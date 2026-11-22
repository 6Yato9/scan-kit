package expo.modules.visionocr

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.util.Size
import android.view.View
import android.widget.ImageView
import androidx.annotation.OptIn
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.Observer
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import expo.modules.visionocr.QuadMath.Pt
import java.io.File
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.atan
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * Scan Kit's own document camera on Android: live preview, live page-outline
 * overlay and steady-page auto-capture. The CameraX port of
 * DocumentCameraView.swift with the same props, events and methods (see
 * modules/vision-ocr/src/DocumentCameraView.tsx); keep the two in step.
 *
 * Events:
 *   onDetection   { quad: number[8] | null, stability: 0..1, aspect }   (~8 Hz)
 *   onCaptureStart {}
 *   onCapture     { sourceUri, width, height, quad: number[8] | null }
 *   onCameraError { code: 'permission' | 'unavailable' | 'failed', message, capture?: true }
 *   onCameraState { state: 'running' | 'paused', reason?: 'in-use' | 'multitasking' | 'pressure' | 'other' }
 *
 * Camera: CameraX Preview (PreviewView, aspect fill) + ImageAnalysis (Y plane,
 * ~15 fps, analysed upright through the frame's rotation, no copy of the full
 * frame) + ImageCapture, all 4:3 so the preview, the analysed frames and the
 * photo show the same field (the photo holds a strip more at the sides than
 * the aspect-filled preview, as on iOS). The view is its own LifecycleOwner:
 * RESUMED while it should run (`active`, attached, app in the foreground,
 * permission granted, not too hot), CREATED otherwise, so CameraX opens and
 * closes the camera with it.
 *
 * Threads: props, views and events on main; frame analysis, detection state,
 * the still feed and the capture watchdog on one analysis thread (iOS
 * analysisQueue); photo decoding and saving on a work thread.
 *
 * Emulator / tests: with `simulatorImageUri` set the same pipeline runs on
 * that still image as if it were the feed; changing the image keeps the
 * detection state (the next sheet under a running camera).
 * `simulatorJitter` (0..1) adds hand-held noise and some unsteady frames.
 */
@SuppressLint("ViewConstructor")
class DocumentCameraView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext), LifecycleOwner, SensorEventListener {

  // Payloads may hold null (no outline), so the maps allow it.
  val onDetection by EventDispatcher<Map<String, Any?>>()
  val onCapture by EventDispatcher<Map<String, Any?>>()
  val onCaptureStart by EventDispatcher<Map<String, Any?>>()
  val onCameraError by EventDispatcher<Map<String, Any?>>()
  val onCameraState by EventDispatcher<Map<String, Any?>>()

  override val shouldUseAndroidLayout = true

  // ── Props and UI state (main thread) ──────────────────────────────────────
  private var autoCapture = true
  private var flashMode = ImageCapture.FLASH_MODE_AUTO
  private var torchOn = false
  private var active = true
  private var simulatorPath: String? = null
  private var appInForeground = true
  private var thermalPaused = false
  private var reportedState: String? = null
  private var reportedError: String? = null
  private var destroyed = false
  private var imageWidth = 3
  private var imageHeight = 4

  private val main = Handler(Looper.getMainLooper())
  private val previewView = PreviewView(context).apply {
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }
  private val stillView = ImageView(context).apply {
    scaleType = ImageView.ScaleType.CENTER_CROP
    visibility = View.GONE
  }
  private val overlay = OutlineOverlay(context)

  // ── Camera (main thread) ──────────────────────────────────────────────────
  private val lifecycleRegistry = LifecycleRegistry(this)
  override fun getLifecycle(): Lifecycle = lifecycleRegistry
  private var provider: ProcessCameraProvider? = null
  private var providerRequested = false
  private var camera: Camera? = null
  private var preview: Preview? = null
  private var analysis: ImageAnalysis? = null
  private var imageCapture: ImageCapture? = null
  private var stateObserver: Observer<CameraState>? = null
  private var thermalListener: Any? = null
  private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
  private var sensorsOn = false

  // ── Analysis thread ───────────────────────────────────────────────────────
  private val analysisThread = HandlerThread("scankit-camera-analysis").apply { start() }
  private val analysisHandler = Handler(analysisThread.looper)
  private val work: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "scankit-camera-work") }
  /**
   * CameraX's callback executor: the work thread while it runs; after the
   * view is torn down (work shut down) CameraX may still deliver an aborted
   * shot's onError, which then runs inline instead of throwing
   * RejectedExecutionException on a CameraX thread.
   */
  private val cameraCallbacks = Executor { r ->
    try {
      work.execute(r)
    } catch (_: RejectedExecutionException) {
      r.run()
    }
  }
  /** Settles the manual capture in flight (any thread, once); destroy() ends it as not-running. */
  @Volatile private var pendingSettle: ((VisionFailure?) -> Unit)? = null

  private enum class Mode { IDLE, CAMERA, STILL }

  // Detection state: analysis thread only.
  private var mode = Mode.IDLE
  private var tracker = AutoCaptureTracker()
  private var smoothed: List<Pt>? = null
  private var missedFrames = 0
  private var lastAnalysis = 0.0
  private var lastEmit = 0.0
  private var lastEmittedHadQuad = false
  private var captureInFlight = false
  private var captureToken = 0
  private var autoCaptureEnabled = true
  private var focusAdjustingSince: Double? = null
  private var lastSignature: PageSignature? = null
  private var stillBitmap: Bitmap? = null
  private var stillGray: GrayImage? = null
  private var stillQuad: List<Pt>? = null
  private var stillSourcePath: String? = null
  private var stillTicking = false
  private var jitter = 0.0
  private val noise = SplitMix(0x5CA7)
  private var sharpnessPeak = 0.0
  private var motionLevel = 0.0
  private var timedFrames = 0
  private var timedSeconds = 0.0

  // Written by camera / sensor callbacks, read on the analysis thread.
  @Volatile private var afState: Int? = null
  @Volatile private var rotationRate = 0.0
  @Volatile private var linearAcceleration = 0.0
  @Volatile private var motionAvailable = false

  private var hostLifecycle: Lifecycle? = null
  private val hostObserver = object : DefaultLifecycleObserver {
    override fun onResume(owner: LifecycleOwner) {
      appInForeground = true
      updateRunning()
    }

    override fun onPause(owner: LifecycleOwner) {
      appInForeground = false
      updateRunning()
    }
  }

  init {
    clipChildren = true
    setBackgroundColor(android.graphics.Color.BLACK)
    addView(previewView)
    addView(stillView)
    addView(overlay)
    lifecycleRegistry.currentState = Lifecycle.State.CREATED
    // The app in the foreground = the activity resumed (iOS: the app's
    // background / foreground notifications).
    (appContext.currentActivity as? LifecycleOwner)?.let { owner ->
      hostLifecycle = owner.lifecycle
      appInForeground = owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
      owner.lifecycle.addObserver(hostObserver)
    }
    listenToThermalStatus()
  }

  // ── Layout: every child fills the view (React Native doesn't lay them out) ─

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = MeasureSpec.getSize(heightMeasureSpec)
    val exact = { size: Int -> MeasureSpec.makeMeasureSpec(size, MeasureSpec.EXACTLY) }
    for (i in 0 until childCount) getChildAt(i).measure(exact(w), exact(h))
    setMeasuredDimension(w, h)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    for (i in 0 until childCount) getChildAt(i).layout(0, 0, r - l, b - t)
    overlay.redraw()
  }

  // ── Props (main) ──────────────────────────────────────────────────────────

  fun setAutoCapture(on: Boolean) {
    autoCapture = on
    analysisHandler.post { autoCaptureEnabled = on }
  }

  fun setFlash(value: String) {
    flashMode = when (value) {
      "on" -> ImageCapture.FLASH_MODE_ON
      "off" -> ImageCapture.FLASH_MODE_OFF
      else -> ImageCapture.FLASH_MODE_AUTO
    }
    imageCapture?.flashMode = flashMode
  }

  fun setTorch(on: Boolean) {
    torchOn = on
    applyTorch()
  }

  fun setActive(on: Boolean) {
    active = on
  }

  fun setSimulatorImage(uri: String?) {
    val p = uri?.takeIf { it.isNotEmpty() }?.let { ImageFiles.pathOf(it) }
    if (p == simulatorPath) return
    val swap = p != null && simulatorPath != null
    simulatorPath = p
    // Another still while running: a new sheet under the same camera, so the
    // detection state carries on. Camera <-> still: start over.
    if (!swap) stopEverything()
  }

  fun setSimulatorJitter(amount: Double) {
    val j = max(0.0, min(1.0, amount))
    analysisHandler.post { jitter = j }
  }

  /** Called once per prop batch, so start/stop decisions see all new props. */
  fun propsDidUpdate() = updateRunning()

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    updateRunning()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    updateRunning()
  }


  private val shouldRun get() = !destroyed && active && isAttachedToWindow && appInForeground && !thermalPaused

  private fun updateRunning() {
    if (!shouldRun) {
      stopEverything()
      if (thermalPaused && !destroyed && active && isAttachedToWindow && appInForeground) reportState("paused", "pressure")
      return
    }
    val path = simulatorPath
    when {
      path != null -> startStill(path)
      !hasBackCamera() -> report("unavailable", "No camera on this device")
      else -> startCamera()
    }
  }

  private fun hasBackCamera() = context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA)

  private fun stopEverything() {
    stopSensors()
    if (torchOn) camera?.cameraControl?.enableTorch(false)
    if (lifecycleRegistry.currentState.isAtLeast(Lifecycle.State.STARTED)) {
      lifecycleRegistry.currentState = Lifecycle.State.CREATED
    }
    analysisHandler.post {
      mode = Mode.IDLE
      resetDetection()
    }
    overlay.setQuad(null, 0, 0, animated = false, stepMs = 0)
    // Paused by us, not interrupted: whatever comes next starts clean.
    reportedState = null
  }

  /** Releases everything (the view is gone). */
  fun destroy() {
    if (destroyed) return
    destroyed = true
    // A shot in flight can't come back to a closed view: its capture() promise
    // is settled now (its result, if CameraX still delivers one, is dropped).
    pendingSettle?.invoke(VisionFailure("not-running", "The camera was closed"))
    pendingSettle = null
    stopEverything()
    hostLifecycle?.removeObserver(hostObserver)
    hostLifecycle = null
    stopThermalListener()
    camera?.cameraInfo?.cameraState?.let { live -> stateObserver?.let { live.removeObserver(it) } }
    stateObserver = null
    val uses = listOfNotNull(preview, analysis, imageCapture)
    if (uses.isNotEmpty()) provider?.unbind(*uses.toTypedArray())
    analysis?.clearAnalyzer()
    lifecycleRegistry.currentState = Lifecycle.State.DESTROYED
    analysisHandler.post {
      stillBitmap = null
      stillGray = null
    }
    // Last: messages already queued still run (quitSafely), and anything
    // posted later is refused and handled where it is posted.
    analysisThread.quitSafely()
    work.shutdown()
  }

  private fun report(code: String, message: String) {
    val key = "$code:$message"
    if (reportedError == key) return
    reportedError = key
    onCameraError(mapOf("code" to code, "message" to message))
  }

  private fun reportState(state: String, reason: String?) {
    val key = "$state:${reason ?: ""}"
    if (reportedState == key) return
    reportedState = key
    val payload = mutableMapOf<String, Any?>("state" to state)
    if (reason != null) payload["reason"] = reason
    onCameraState(payload)
  }

  // ── Camera mode ───────────────────────────────────────────────────────────

  private fun startCamera() {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      requestPermission()
      return
    }
    previewView.visibility = View.VISIBLE
    stillView.visibility = View.GONE
    stillView.setImageDrawable(null)
    analysisHandler.post {
      stillBitmap = null
      stillGray = null
      stillSourcePath = null
      stillQuad = null
    }
    startSensors()
    val p = provider
    if (p == null) {
      if (providerRequested) return
      providerRequested = true
      val future = ProcessCameraProvider.getInstance(context)
      future.addListener({
        try {
          provider = future.get()
          if (!destroyed) updateRunning()
        } catch (e: Exception) {
          Log.w(TAG, "camera provider", e)
          report("failed", "The camera could not be opened")
        }
      }, ContextCompat.getMainExecutor(context))
      return
    }
    if (camera == null && !bind(p)) return
    analysisHandler.post {
      if (mode != Mode.CAMERA) {
        mode = Mode.CAMERA
        resetDetection()
      }
    }
    reportedError = null
    lifecycleRegistry.currentState = Lifecycle.State.RESUMED
    applyTorch()
    val st = camera?.cameraInfo?.cameraState?.value
    if (st?.type == CameraState.Type.OPEN && st.error == null) reportState("running", null)
  }

  /**
   * Asked once per app run, like iOS asks only while undetermined. Refused,
   * the screen explains and offers Settings; coming back builds a new view
   * that finds the permission granted.
   */
  private fun requestPermission() {
    if (permissionAsked) {
      report("permission", "Camera access is turned off for Scan Kit")
      return
    }
    val permissions = appContext.permissions
    if (permissions == null) {
      report("permission", "Camera access is turned off for Scan Kit")
      return
    }
    permissionAsked = true
    permissions.askForPermissions({ result ->
      main.post {
        val granted = result[Manifest.permission.CAMERA]?.status == PermissionsStatus.GRANTED
        if (granted) updateRunning() else report("permission", "Camera access was denied")
      }
    }, Manifest.permission.CAMERA)
  }

  @OptIn(ExperimentalCamera2Interop::class)
  private fun bind(p: ProcessCameraProvider): Boolean {
    val selector = CameraSelector.DEFAULT_BACK_CAMERA
    val hasBack = try {
      p.hasCamera(selector)
    } catch (_: Exception) {
      false
    }
    if (!hasBack) {
      report("unavailable", "No camera on this device")
      return false
    }
    val fourThree = AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY
    val previewBuilder = Preview.Builder()
      .setResolutionSelector(ResolutionSelector.Builder().setAspectRatioStrategy(fourThree).build())
    // Focus state for steadiness (AVCaptureDevice.isAdjustingFocus on iOS).
    Camera2Interop.Extender(previewBuilder).setSessionCaptureCallback(object : CameraCaptureSession.CaptureCallback() {
      override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
        afState = result.get(CaptureResult.CONTROL_AF_STATE)
      }
    })
    val pv = previewBuilder.build().also { it.surfaceProvider = previewView.surfaceProvider }
    val an = ImageAnalysis.Builder()
      .setResolutionSelector(
        ResolutionSelector.Builder()
          .setAspectRatioStrategy(fourThree)
          .setResolutionStrategy(ResolutionStrategy(Size(1280, 960), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
          .build(),
      )
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
      .build()
    an.setAnalyzer({ r -> analysisHandler.post(r) }) { image -> analyze(image) }
    val ic = ImageCapture.Builder()
      .setResolutionSelector(
        ResolutionSelector.Builder()
          .setAspectRatioStrategy(fourThree)
          // At most ~12 MP: a larger frame (50–200 MP sensors list them) is
          // only scaled down to CAPTURE_MAX_EDGE afterwards, at the cost of
          // a 200+ MB decode. Lower first, so a binned 4080x3060 is chosen.
          .setResolutionStrategy(ResolutionStrategy(Size(4096, 3072), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
          .build(),
      )
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
      .setFlashMode(flashMode)
      .build()
    return try {
      // Only our own use cases (an earlier bind's): unbindAll would also
      // stop any other CameraX user in the process (expo-camera's QR scanner).
      val earlier = listOfNotNull(preview, analysis, imageCapture)
      if (earlier.isNotEmpty()) p.unbind(*earlier.toTypedArray())
      val cam = p.bindToLifecycle(this, selector, pv, an, ic)
      camera = cam
      preview = pv
      analysis = an
      imageCapture = ic
      applyCloseUpZoom(cam)
      val observer = Observer<CameraState> { onCameraStateChanged(it) }
      cam.cameraInfo.cameraState.observeForever(observer)
      stateObserver = observer
      true
    } catch (e: Exception) {
      Log.w(TAG, "bind", e)
      report("failed", "The camera could not be started")
      false
    }
  }

  /**
   * Cameras whose minimum focus distance is longer than the distance at which
   * a page fills the frame can't focus on a page held that close: zoom in
   * slightly (at most 1.6x) so the phone is held farther back, as on iOS.
   */
  @OptIn(ExperimentalCamera2Interop::class)
  private fun applyCloseUpZoom(cam: Camera) {
    try {
      val info = Camera2CameraInfo.from(cam.cameraInfo)
      val diopters = info.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: return
      if (diopters <= 0f) return // fixed focus
      val focal = info.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.minOrNull() ?: return
      val sensor = info.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE) ?: return
      val minFocusMM = 1000.0 / diopters
      // Horizontal field of view over the sensor's long side, as iOS's videoFieldOfView.
      val hfov = 2 * atan(max(sensor.width, sensor.height) / (2.0 * focal))
      val shortHalfTan = tan(hfov / 2) * 3 / 4
      val pageFillMM = (210.0 / 0.85) / 2 / shortHalfTan
      if (minFocusMM > pageFillMM) {
        val maxZoom = cam.cameraInfo.zoomState.value?.maxZoomRatio ?: 1f
        val zoom = min(1.6, minFocusMM / pageFillMM).toFloat()
        cam.cameraControl.setZoomRatio(max(1f, min(zoom, maxZoom)))
      }
    } catch (e: Exception) {
      Log.w(TAG, "close-up zoom", e)
    }
  }

  /** main: CameraX reports the camera opening, closing or being taken away. */
  private fun onCameraStateChanged(state: CameraState) {
    if (!shouldRun || simulatorPath != null) return
    val error = state.error
    if (error != null) {
      when (error.code) {
        CameraState.ERROR_CAMERA_IN_USE, CameraState.ERROR_MAX_CAMERAS_IN_USE -> pauseFor("in-use")
        CameraState.ERROR_CAMERA_FATAL_ERROR, CameraState.ERROR_STREAM_CONFIG -> report("failed", "The camera stopped unexpectedly")
        else -> pauseFor("other")
      }
      return
    }
    if (state.type == CameraState.Type.OPEN) reportState("running", null)
  }

  private fun pauseFor(reason: String) {
    analysisHandler.post { resetDetection() }
    overlay.setQuad(null, 0, 0, animated = true, stepMs = 0)
    reportState("paused", reason)
  }

  private fun applyTorch() {
    val cam = camera ?: return
    if (!cam.cameraInfo.hasFlashUnit()) return
    val running = lifecycleRegistry.currentState.isAtLeast(Lifecycle.State.STARTED)
    if (running || !torchOn) cam.cameraControl.enableTorch(torchOn && running)
  }

  private fun listenToThermalStatus() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
    val listener = PowerManager.OnThermalStatusChangedListener { status ->
      val hot = status >= PowerManager.THERMAL_STATUS_SEVERE
      if (hot == thermalPaused) return@OnThermalStatusChangedListener
      thermalPaused = hot
      if (!hot) reportedState = null
      updateRunning()
      if (!hot && shouldRun) reportState("running", null)
    }
    pm.addThermalStatusListener(ContextCompat.getMainExecutor(context), listener)
    thermalListener = listener
  }

  private fun stopThermalListener() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
    (thermalListener as? PowerManager.OnThermalStatusChangedListener)?.let { pm.removeThermalStatusListener(it) }
    thermalListener = null
  }

  // ── Motion (iOS: CMMotionManager deviceMotion) ────────────────────────────

  private fun startSensors() {
    if (sensorsOn) return
    val sm = sensors ?: return
    val gyro = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    val accel = sm.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
    motionAvailable = gyro != null || accel != null
    gyro?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
    accel?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
    sensorsOn = true
  }

  private fun stopSensors() {
    if (!sensorsOn) return
    sensors?.unregisterListener(this)
    sensorsOn = false
    motionAvailable = false
  }

  override fun onSensorChanged(event: SensorEvent) {
    val v = event.values
    val m = sqrt((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).toDouble())
    when (event.sensor.type) {
      Sensor.TYPE_GYROSCOPE -> rotationRate = m
      Sensor.TYPE_LINEAR_ACCELERATION -> linearAcceleration = m
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  // ── Frame analysis (analysis thread) ──────────────────────────────────────

  private fun now() = SystemClock.elapsedRealtimeNanos() / 1e9

  private fun analyze(image: ImageProxy) {
    try {
      if (mode != Mode.CAMERA) return
      val now = now()
      if (now - lastAnalysis < ANALYSIS_INTERVAL) return
      lastAnalysis = now
      val plane = image.planes[0]
      val y = YPlane(plane.buffer, plane.rowStride, plane.pixelStride, image.width, image.height, image.imageInfo.rotationDegrees)
      val gray = y.uprightGray(PageDetector.LIVE_WORK_EDGE)
      val quad = PageDetector.detect(gray, LIVE_MIN_AREA, workEdge = PageDetector.LIVE_WORK_EDGE)?.let { PageGeometry.inset(it) }

      var steady = true
      if (quad != null) {
        val sharp = y.sharpness(quad)
        sharpnessPeak = max(sharp, sharpnessPeak * 0.97)
        // Blurry relative to what this page looked like a moment ago (motion blur, refocusing).
        if (sharp < sharpnessPeak * 0.6) steady = false
      } else {
        sharpnessPeak = 0.0
      }
      if (motionAvailable) {
        // iOS: rotation 0.35 rad/s, user acceleration 0.08 g (= 0.78 m/s^2).
        val level = max(rotationRate / 0.35, linearAcceleration / 0.78)
        motionLevel = motionLevel * 0.6 + level * 0.4
        if (motionLevel > 1) steady = false
      }
      // The lens settling counts as unsteady, but a lens that keeps hunting
      // (low light, a glossy page) would block auto-capture for good: after
      // 0.8 s the sharpness test alone decides.
      val af = afState
      if (af == CaptureResult.CONTROL_AF_STATE_PASSIVE_SCAN || af == CaptureResult.CONTROL_AF_STATE_ACTIVE_SCAN) {
        val since = focusAdjustingSince ?: now
        focusAdjustingSince = since
        if (now - since < 0.8) steady = false
      } else {
        focusAdjustingSince = null
      }
      handleDetection(quad, y.uprightWidth, y.uprightHeight, now, steady) { PageSignature.make(it, y) }
      if (BuildConfig.DEBUG) {
        timedFrames++
        timedSeconds += now() - now
        if (timedFrames == 45) {
          Log.d(TAG, "analysis %.1f ms/frame (%dx%d, rotation %d)".format(timedSeconds * 1000 / timedFrames, image.width, image.height, image.imageInfo.rotationDegrees))
          timedFrames = 0
          timedSeconds = 0.0
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "analyze", e)
    } finally {
      image.close()
    }
  }

  // ── Still-image mode (emulator, tests) ────────────────────────────────────

  private fun startStill(path: String) {
    // The camera stays closed while a still is the feed.
    if (lifecycleRegistry.currentState.isAtLeast(Lifecycle.State.STARTED)) {
      lifecycleRegistry.currentState = Lifecycle.State.CREATED
    }
    previewView.visibility = View.GONE
    stillView.visibility = View.VISIBLE
    reportedError = null
    analysisHandler.post {
      if (stillSourcePath != path || stillBitmap == null) {
        val bmp = try {
          ImageFiles.decodeUpright(path, 1920)
        } catch (e: Throwable) {
          null
        }
        if (bmp == null) {
          main.post { report("unavailable", "Could not read the test image") }
          return@post
        }
        stillBitmap = bmp
        val gray = ImageFiles.gray(bmp, 640)
        stillGray = gray
        // The still never changes, so its outline is found once (same
        // settings as a live frame) and fed every frame.
        stillQuad = PageDetector.detect(gray, LIVE_MIN_AREA, workEdge = PageDetector.LIVE_WORK_EDGE)?.let { PageGeometry.inset(it) }
        stillSourcePath = path
        main.post {
          imageWidth = bmp.width
          imageHeight = bmp.height
          stillView.setImageBitmap(bmp)
        }
      }
      if (mode != Mode.STILL) {
        mode = Mode.STILL
        resetDetection()
      }
      if (!stillTicking) {
        stillTicking = true
        analysisHandler.postDelayed(stillTick, 100)
      }
    }
  }

  private val stillTick = object : Runnable {
    override fun run() {
      if (mode != Mode.STILL) {
        stillTicking = false
        return
      }
      analyseStill()
      analysisHandler.postDelayed(this, (ANALYSIS_INTERVAL * 1000).toLong())
    }
  }

  /** analysis thread: one "frame" of the still image through the live pipeline. */
  private fun analyseStill() {
    val bmp = stillBitmap ?: return
    val now = now()
    var quad = stillQuad
    var steady = true
    val q = quad
    if (jitter > 0 && q != null) {
      // Dev: a hand-held phone. Corners wander (sigma up to 0.6% of the
      // frame) and some frames are blurred or shaken.
      val amp = 0.006 * jitter
      quad = q.map { Pt(it.x + noise.gauss() * amp, it.y + noise.gauss() * amp) }
      steady = noise.next() >= 0.2 * jitter
    }
    val gray = stillGray
    handleDetection(quad, bmp.width, bmp.height, now, steady) { qq -> gray?.let { PageSignature.make(qq, it) } }
  }

  // ── Detection -> overlay, events, auto-capture (analysis thread) ──────────

  /** Starts detection over; the last capture is remembered unless `forgetCapture`. */
  private fun resetDetection(forgetCapture: Boolean = false) {
    tracker = if (forgetCapture) AutoCaptureTracker() else tracker.restarted()
    smoothed = null
    missedFrames = 0
    sharpnessPeak = 0.0
    motionLevel = 0.0
    lastEmittedHadQuad = false
    lastSignature = null
    focusAdjustingSince = null
  }

  /** `signatureOf` reads the page content inside an outline of this frame; it is given the SMOOTHED outline. */
  private fun handleDetection(quad: List<Pt>?, w: Int, h: Int, now: Double, steady: Boolean, signatureOf: (List<Pt>) -> PageSignature?) {
    // Overlay: exponential smoothing of the corners; snap on a big jump (a
    // different page); keep the last outline through a few missed frames.
    if (quad != null) {
      missedFrames = 0
      val s = smoothed
      smoothed = if (s != null && PageGeometry.maxCornerDistance(s, quad) < 0.08) {
        val a = 0.45
        List(4) { Pt(s[it].x + (quad[it].x - s[it].x) * a, s[it].y + (quad[it].y - s[it].y) * a) }
      } else {
        quad
      }
    } else {
      missedFrames += 1
      if (missedFrames > 3) smoothed = null
    }

    val signature = if (quad != null) smoothed?.let(signatureOf) else null
    if (signature != null) lastSignature = signature
    val update = tracker.update(quad, now, steady, signature)
    val shown = smoothed
    val stability = if (captureInFlight) 0.0 else update.stability

    main.post {
      if (destroyed) return@post
      imageWidth = w
      imageHeight = h
      overlay.setQuad(shown, w, h, animated = true, stepMs = (ANALYSIS_INTERVAL * 1200).toLong())
    }

    val hasQuad = shown != null
    if (now - lastEmit >= EMIT_INTERVAL || hasQuad != lastEmittedHadQuad) {
      lastEmit = now
      lastEmittedHadQuad = hasQuad
      val payload = mapOf(
        "quad" to shown?.let { PageGeometry.flatten(it) },
        "stability" to stability,
        // Width / height of the upright frames: 0.75 in portrait.
        "aspect" to if (h > 0) w.toDouble() / h else 0.75,
      )
      main.post { if (!destroyed) onDetection(payload) }
    }

    if (update.fire && autoCaptureEnabled && !captureInFlight) beginCapture(quad ?: shown, null)
  }

  // ── Capture ───────────────────────────────────────────────────────────────

  /** Forget the last capture: the page under the camera may be auto-captured again (a retake). */
  fun rearm() {
    analysisHandler.post { resetDetection(forgetCapture = true) }
  }

  /** Manual shutter. Resolves once the page has been delivered via onCapture. */
  fun capture(promise: Promise) {
    val posted = analysisHandler.post {
      if (mode == Mode.IDLE) {
        promise.reject("not-running", "The camera is not running", null)
        return@post
      }
      if (captureInFlight) {
        promise.reject("busy", "A capture is already in progress", null)
        return@post
      }
      beginCapture(tracker.smoothed ?: smoothed) { failure ->
        if (failure != null) promise.reject(failure.code, failure.message, null) else promise.resolve(null)
      }
    }
    if (!posted) promise.reject("not-running", "The camera is not running", null)
  }

  private class Shot(val path: String, val width: Int, val height: Int, val quad: List<Pt>?)

  /** analysis thread. */
  private fun beginCapture(fallback: List<Pt>?, completion: ((VisionFailure?) -> Unit)?) {
    captureInFlight = true
    captureToken += 1
    val token = captureToken
    tracker.didCapture(fallback, now(), if (fallback == null) null else lastSignature)
    val still = if (mode == Mode.STILL) stillSourcePath else null
    main.post { if (!destroyed) onCaptureStart(emptyMap()) }
    // The completion runs exactly once, whichever of the result, the
    // watchdog or destroy() comes first.
    val settled = AtomicBoolean(false)
    lateinit var settle: (VisionFailure?) -> Unit
    settle = { failure ->
      if (settled.compareAndSet(false, true)) {
        if (pendingSettle === settle) pendingSettle = null
        completion?.invoke(failure)
      }
    }
    if (completion != null) pendingSettle = settle

    // Settles this shot exactly once: the photo, a failure, or the watchdog.
    // A result for a shot already given up is thrown away (its file deleted).
    val finish: (Result<Shot>) -> Unit = { result ->
      val posted = analysisHandler.post {
        if (!captureInFlight || captureToken != token) {
          result.getOrNull()?.let { File(it.path).delete() }
          return@post
        }
        captureInFlight = false
        // The hold starts over for the next page.
        tracker.captureFinished(now())
        // Stopped meanwhile (backgrounded, closed): a failure is expected and
        // not worth an error; the screen resumes by itself.
        val running = mode != Mode.IDLE
        main.post {
          val shot = result.getOrNull()
          if (shot != null && destroyed) {
            File(shot.path).delete()
            settle(VisionFailure("not-running", "The camera was closed"))
          } else if (shot != null) {
            onCapture(payload(shot, shot.quad ?: fallback))
            settle(null)
          } else {
            val e = result.exceptionOrNull()
            val message = (e as? VisionFailure)?.message ?: e?.message ?: "The photo could not be taken"
            if (running && !destroyed) {
              onCameraError(mapOf("code" to "failed", "message" to message, "capture" to true))
              settle(VisionFailure("failed", message))
            } else {
              settle(VisionFailure("not-running", message))
            }
          }
        }
      }
      // The analysis thread is gone (the view was torn down): settle here.
      if (!posted) {
        result.getOrNull()?.let { File(it.path).delete() }
        main.post { settle(VisionFailure("not-running", "The camera was closed")) }
      }
    }
    analysisHandler.postDelayed({
      if (captureInFlight && captureToken == token) finish(Result.failure(VisionFailure("failed", "The photo took too long")))
    }, CAPTURE_TIMEOUT_MS)

    if (still != null) {
      try {
        work.execute {
          finish(runCatching { saveCapture(ImageFiles.decodeUpright(still, CAPTURE_MAX_EDGE)) })
        }
      } catch (_: RejectedExecutionException) {
        finish(Result.failure(VisionFailure("not-running", "The camera is not running")))
      }
      return
    }

    main.post {
      val ic = imageCapture
      if (ic == null || destroyed || !lifecycleRegistry.currentState.isAtLeast(Lifecycle.State.STARTED)) {
        finish(Result.failure(VisionFailure("not-running", "The camera is not running")))
        return@post
      }
      ic.flashMode = flashMode
      try {
        ic.takePicture(cameraCallbacks, object : ImageCapture.OnImageCapturedCallback() {
          override fun onCaptureSuccess(image: ImageProxy) {
            if (destroyed) {
              image.close()
              finish(Result.failure(VisionFailure("not-running", "The camera was closed")))
              return
            }
            val result = runCatching {
              val rotation = image.imageInfo.rotationDegrees
              val buffer = image.planes[0].buffer
              val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
              image.close()
              saveCapture(decodeJpeg(bytes, rotation))
            }
            if (result.isFailure) {
              try { image.close() } catch (_: Exception) {}
            }
            finish(result)
          }

          override fun onError(exception: ImageCaptureException) {
            finish(Result.failure(VisionFailure("failed", exception.message ?: "The photo could not be taken")))
          }
        })
      } catch (e: Exception) {
        finish(Result.failure(VisionFailure("failed", e.message ?: "The photo could not be taken")))
      }
    }
  }

  private fun payload(shot: Shot, quad: List<Pt>?): Map<String, Any?> = mapOf(
    "sourceUri" to Uri.fromFile(File(shot.path)).toString(),
    "width" to shot.width,
    "height" to shot.height,
    "quad" to quad?.let { PageGeometry.flatten(it) },
  )

  /**
   * work thread: upright JPEG (q 0.92, long edge at most CAPTURE_MAX_EDGE) in
   * cache/scanner-src, plus the page outline detected on the still (sharper
   * than any video frame). The JPEG is already what the save path keeps
   * (lib/page-source normalizeImage copies it as is).
   */
  private fun saveCapture(bitmap: Bitmap): Shot {
    try {
      val dir = File(context.cacheDir, "scanner-src").apply { mkdirs() }
      val out = File(dir, "src-${System.currentTimeMillis()}-${counter.incrementAndGet()}.jpg")
      ImageFiles.writeJpeg(bitmap, out, 0.92)
      val quad = try {
        PageDetector.detect(ImageFiles.gray(bitmap, 1024), 0.15)?.let { PageGeometry.inset(it) }
      } catch (e: Exception) {
        Log.w(TAG, "detect on still", e)
        null
      }
      return Shot(out.path, bitmap.width, bitmap.height, quad)
    } finally {
      bitmap.recycle()
    }
  }

  /** The photo upright (rotationDegrees applied), long edge capped at CAPTURE_MAX_EDGE, never decoded at full size (ImageDecode). */
  private fun decodeJpeg(bytes: ByteArray, rotation: Int): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw VisionFailure("failed", "Could not read the photo")
    return ImageDecode.decode(
      EncodedImage.Bytes(bytes), bounds.outWidth, bounds.outHeight,
      DecodePlan.orientationForRotation(rotation), CAPTURE_MAX_EDGE, failCode = "failed",
    )
  }

  companion object {
    private const val TAG = "DocumentCamera"
    private const val ANALYSIS_INTERVAL = 1.0 / 15
    private const val EMIT_INTERVAL = 0.12
    /** Live outlines smaller than this aren't shown; auto-capture also needs the tracker's minArea. */
    private const val LIVE_MIN_AREA = 0.1
    /** A shot that hasn't come back by then is given up (the shutter must never stay busy for good). */
    private const val CAPTURE_TIMEOUT_MS = 10_000L
    /** Long edge of a saved capture: what lib/page-source keeps of a photo (SOURCE_MAX_EDGE). */
    private const val CAPTURE_MAX_EDGE = 4096
    private val counter = AtomicInteger(0)
    /** The camera permission is asked at most once per app run (iOS asks only while undetermined). */
    @Volatile private var permissionAsked = false
  }
}

/** Small deterministic random numbers (dev jitter only); same generator as iOS. */
class SplitMix(seed: Long) {
  private var state = seed.toULong()

  fun next(): Double {
    state += 0x9E3779B97F4A7C15uL
    var z = state
    z = (z xor (z shr 30)) * 0xBF58476D1CE4E5B9uL
    z = (z xor (z shr 27)) * 0x94D049BB133111EBuL
    return (z xor (z shr 31)).shr(11).toDouble() / (1uL shl 53).toDouble()
  }

  fun gauss(): Double {
    val u = max(1e-12, next())
    val v = next()
    return sqrt(-2 * ln(u)) * kotlin.math.cos(2 * Math.PI * v)
  }
}

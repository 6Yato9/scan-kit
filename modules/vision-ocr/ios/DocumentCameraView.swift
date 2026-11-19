import AVFoundation
import CoreMotion
import ExpoModulesCore
import ImageIO
import UIKit
import Vision

/// Scan Kit's own document camera: live preview, live page-outline overlay
/// and steady-page auto-capture. Unlike VisionKit's scanner it delivers the
/// ORIGINAL full photo plus the detected outline, so the crop can later be
/// widened as well as narrowed.
///
/// Only camera + overlay: every button, hint and progress ring is drawn in
/// React Native from the events below.
///
/// Events:
///   onDetection   { quad: number[8] | null, stability: 0...1, aspect }   (~8 Hz)
///   onCaptureStart {}                                             (shutter fired)
///   onCapture     { sourceUri, width, height, quad: number[8] | null }
///   onCameraError { code: 'permission' | 'unavailable' | 'failed', message, capture?: true }
///                 (`capture`: one shot failed, the camera keeps running)
///   onCameraState { state: 'running' | 'paused', reason?: 'in-use' | 'multitasking' | 'pressure' | 'other' }
///                 (paused: the system interrupted the session; it resumes by itself)
///
/// Orientation: the preview, the analysed frames and the photo all follow the
/// interface orientation (iPad turns), so the photo is upright as the user
/// sees the page and the outline maps straight onto the preview.
///
/// Simulator / tests: with `simulatorImageUri` set (or when there is no
/// camera) the same pipeline runs on that still image as if it were the feed.
/// Changing the image while running keeps the detection state, like the next
/// sheet put under a running camera. `simulatorJitter` (0...1) adds hand-held
/// noise to the still's outline and marks some frames unsteady.
public class DocumentCameraView: ExpoView, AVCaptureVideoDataOutputSampleBufferDelegate {
  let onDetection = EventDispatcher()
  let onCapture = EventDispatcher()
  let onCaptureStart = EventDispatcher()
  let onCameraError = EventDispatcher()
  let onCameraState = EventDispatcher()

  // MARK: Props (main thread)
  private var autoCapture = true
  private var flashMode: AVCaptureDevice.FlashMode = .auto
  private var torchOn = false
  private var active = true
  private var simulatorPath: String?
  /// Interface orientation as a capture rotation angle (90 = portrait).
  private var rotationAngle: CGFloat = 90
  private var reportedState: String?        // main
  private var appInForeground = UIApplication.shared.applicationState != .background

  // MARK: Layers (main thread)
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private let stillLayer = CALayer()
  private let overlay = CAShapeLayer()
  private var shownQuad: [CGPoint]?
  /// Upright aspect (width/height) of what the preview shows.
  private var imageSize = CGSize(width: 3, height: 4)

  // MARK: Capture
  private let session = AVCaptureSession()
  private let sessionQueue = DispatchQueue(label: "scankit.camera.session")
  /// Frame analysis and all detection state live on this queue.
  private let analysisQueue = DispatchQueue(label: "scankit.camera.analysis", qos: .userInitiated)
  private let workQueue = DispatchQueue(label: "scankit.camera.work", qos: .userInitiated)
  private let photoOutput = AVCapturePhotoOutput()
  private let videoOutput = AVCaptureVideoDataOutput()
  private var device: AVCaptureDevice?      // sessionQueue
  private var configured = false            // sessionQueue
  private var sessionRotation: CGFloat = 90 // sessionQueue
  private var restartedAfterError = false   // sessionQueue
  private var photoDelegates: [Int64: PhotoDelegate] = [:]  // sessionQueue
  private let motion = CMMotionManager()
  private var reportedError: String?        // main
  private var permissionRequested = false   // main

  // MARK: Detection state (analysisQueue)
  private var tracker = AutoCaptureTracker()
  private var smoothed: [CGPoint]?
  private var missedFrames = 0
  private var lastAnalysis: CFTimeInterval = 0
  private var lastEmit: CFTimeInterval = 0
  private var lastEmittedHadQuad = false
  private var captureInFlight = false
  private var captureToken = 0
  private var autoCaptureEnabled = true
  /// The camera, for focus state (set from sessionQueue once configured).
  private var focusDevice: AVCaptureDevice?
  private var focusAdjustingSince: CFTimeInterval?
  /// Content of the page in the latest frame with an outline.
  private var lastSignature: PageSignature?
  private var stillGray: GrayImage?
  private var jitter: Double = 0
  private var noise = SplitMix(seed: 0x5CA7)
  private var captureFlash: AVCaptureDevice.FlashMode = .auto
  private var sharpnessPeak: Double = 0
  private var motionLevel: Double = 0
  private var stillImage: CGImage?
  private var stillSourcePath: String?
  private var stillTimer: DispatchSourceTimer?
  private var mode: Mode = .idle

  private enum Mode { case idle, camera, still }

  private static let accent = UIColor(red: 0x2B / 255.0, green: 0xB5 / 255.0, blue: 0xD1 / 255.0, alpha: 1)
  private static let analysisInterval: CFTimeInterval = 1.0 / 15
  private static let emitInterval: CFTimeInterval = 0.12
  /// Live outlines smaller than this aren't shown (something on the page, or
  /// noise); auto-capture additionally needs the tracker's minArea.
  private static let liveMinArea: CGFloat = 0.1
  /// A shot that hasn't come back by then is given up (the shutter must
  /// never stay busy for good).
  private static let captureTimeout: Double = 10
  /// Long edge of a saved capture: what lib/page-source keeps of a photo
  /// (SOURCE_MAX_EDGE), so the photo is decoded and encoded once.
  private static let captureMaxEdge = 4096

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black

    stillLayer.contentsGravity = .resizeAspectFill
    stillLayer.masksToBounds = true
    layer.addSublayer(stillLayer)

    overlay.fillColor = Self.accent.withAlphaComponent(0.2).cgColor
    overlay.strokeColor = Self.accent.cgColor
    overlay.lineWidth = 2
    overlay.lineJoin = .round
    overlay.opacity = 0
    layer.addSublayer(overlay)

    let nc = NotificationCenter.default
    nc.addObserver(self, selector: #selector(appDidEnterBackground),
                   name: UIApplication.didEnterBackgroundNotification, object: nil)
    nc.addObserver(self, selector: #selector(appWillEnterForeground),
                   name: UIApplication.willEnterForegroundNotification, object: nil)
    nc.addObserver(self, selector: #selector(sessionRuntimeError(_:)),
                   name: .AVCaptureSessionRuntimeError, object: session)
    nc.addObserver(self, selector: #selector(sessionWasInterrupted(_:)),
                   name: .AVCaptureSessionWasInterrupted, object: session)
    nc.addObserver(self, selector: #selector(sessionInterruptionEnded(_:)),
                   name: .AVCaptureSessionInterruptionEnded, object: session)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    motion.stopDeviceMotionUpdates()
    stillTimer?.cancel()
    let session = self.session
    sessionQueue.async { if session.isRunning { session.stopRunning() } }
  }

  // MARK: - Props

  func setAutoCapture(_ on: Bool) {
    autoCapture = on
    analysisQueue.async { self.autoCaptureEnabled = on }
  }

  func setFlash(_ value: String) {
    switch value {
    case "on": flashMode = .on
    case "off": flashMode = .off
    default: flashMode = .auto
    }
    let mode = flashMode
    analysisQueue.async { self.captureFlash = mode }
  }

  func setTorch(_ on: Bool) {
    torchOn = on
    applyTorch()
  }

  func setActive(_ on: Bool) {
    active = on
  }

  func setSimulatorImage(_ uri: String?) {
    let p = uri.flatMap { $0.isEmpty ? nil : DocumentGeometry.path($0.components(separatedBy: "?")[0]) }
    guard p != simulatorPath else { return }
    let swap = p != nil && simulatorPath != nil
    simulatorPath = p
    // Another still while running: a new sheet under the same camera, so the
    // detection state carries on (propsDidUpdate loads it). Camera <-> still:
    // start over.
    if !swap { stopEverything() }
  }

  func setSimulatorJitter(_ amount: Double) {
    let j = max(0, min(1, amount))
    analysisQueue.async { self.jitter = j }
  }

  /// Called once per prop batch, so start/stop decisions see all new props.
  func propsDidUpdate() {
    updateRunning()
  }

  // MARK: - Lifecycle

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    updateRotation()
    updateRunning()
  }

  @objc private func appDidEnterBackground() {
    appInForeground = false
    updateRunning()
  }

  @objc private func appWillEnterForeground() {
    appInForeground = true
    updateRunning()
  }

  @objc private func sessionRuntimeError(_ note: Notification) {
    let err = note.userInfo?[AVCaptureSessionErrorKey] as? AVError
    if err?.code == .mediaServicesWereReset {
      // The media server restarted: every input and output is dead. Rebuild
      // the session from scratch, then start it again if it should run.
      sessionQueue.async {
        self.teardownSession()
        DispatchQueue.main.async { self.updateRunning() }
      }
      return
    }
    // Anything else: restart once; a second failure is reported (the screen
    // offers Try again, which builds a new camera view).
    sessionQueue.async {
      if !self.restartedAfterError && self.configured {
        self.restartedAfterError = true
        self.session.startRunning()
        if self.session.isRunning { return }
      }
      DispatchQueue.main.async {
        self.report("failed", err?.localizedDescription ?? "The camera stopped unexpectedly")
      }
    }
  }

  @objc private func sessionWasInterrupted(_ note: Notification) {
    var reason = "other"
    if let raw = (note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? NSNumber)?.intValue,
       let r = AVCaptureSession.InterruptionReason(rawValue: raw) {
      switch r {
      case .videoDeviceInUseByAnotherClient: reason = "in-use"
      case .videoDeviceNotAvailableWithMultipleForegroundApps: reason = "multitasking"
      case .videoDeviceNotAvailableDueToSystemPressure: reason = "pressure"
      case .videoDeviceNotAvailableInBackground: reason = "background"
      default: reason = "other"
      }
    }
    analysisQueue.async { self.resetDetection() }
    DispatchQueue.main.async {
      self.setOverlay(nil, animated: true)
      // Going to the background is not news (the screen pauses itself).
      if reason != "background" { self.reportState("paused", reason: reason) }
    }
  }

  @objc private func sessionInterruptionEnded(_ note: Notification) {
    DispatchQueue.main.async { self.reportState("running", reason: nil) }
  }

  /// main.
  private func reportState(_ state: String, reason: String?) {
    let key = "\(state):\(reason ?? "")"
    guard reportedState != key else { return }
    reportedState = key
    var payload: [String: Any] = ["state": state]
    if let r = reason { payload["reason"] = r }
    onCameraState(payload)
  }

  private var shouldRun: Bool { active && window != nil && appInForeground }

  private func updateRunning() {
    guard shouldRun else {
      stopEverything()
      return
    }
    let hasCamera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil
    if let path = simulatorPath {
      startStill(path: path)
    } else if !hasCamera {
      report("unavailable", "No camera on this device")
    } else {
      startCamera()
    }
  }

  private func stopEverything() {
    stillTimer?.cancel()
    stillTimer = nil
    motion.stopDeviceMotionUpdates()
    if torchOn { applyTorch(forceOff: true) }
    sessionQueue.async {
      if self.session.isRunning { self.session.stopRunning() }
    }
    analysisQueue.async {
      self.mode = .idle
      self.resetDetection()
    }
    setOverlay(nil, animated: false)
    // Paused by us, not interrupted: whatever comes next starts clean.
    reportedState = nil
  }

  private func report(_ code: String, _ message: String) {
    let key = "\(code):\(message)"
    guard reportedError != key else { return }
    reportedError = key
    onCameraError(["code": code, "message": message])
  }

  // MARK: - Camera mode

  private func startCamera() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      break
    case .notDetermined:
      guard !permissionRequested else { return }
      permissionRequested = true
      AVCaptureDevice.requestAccess(for: .video) { granted in
        DispatchQueue.main.async {
          if granted { self.updateRunning() } else { self.report("permission", "Camera access was denied") }
        }
      }
      return
    default:
      report("permission", "Camera access is turned off for Scan Kit")
      return
    }

    if previewLayer == nil {
      let pl = AVCaptureVideoPreviewLayer(session: session)
      pl.videoGravity = .resizeAspectFill
      pl.frame = bounds
      layer.insertSublayer(pl, at: 0)
      previewLayer = pl
    }
    previewLayer?.isHidden = false
    stillLayer.contents = nil
    stillLayer.isHidden = true
    analysisQueue.async {
      self.stillImage = nil
      self.stillSourcePath = nil
    }
    if motion.isDeviceMotionAvailable && !motion.isDeviceMotionActive {
      motion.deviceMotionUpdateInterval = 1.0 / 30
      motion.startDeviceMotionUpdates()
    }

    sessionQueue.async {
      if !self.configured {
        do {
          try self.configureSession()
          self.configured = true
        } catch let e as DocumentGeometry.Failure {
          DispatchQueue.main.async { self.report(e.code, e.message) }
          return
        } catch {
          DispatchQueue.main.async { self.report("failed", error.localizedDescription) }
          return
        }
      }
      self.analysisQueue.sync {
        if self.mode != .camera {
          self.mode = .camera
          self.resetDetection()
        }
      }
      if !self.session.isRunning { self.session.startRunning() }
      let running = self.session.isRunning
      if running { self.restartedAfterError = false }
      DispatchQueue.main.async {
        guard self.shouldRun else {
          self.stopEverything()
          return
        }
        self.reportedError = nil
        if let c = self.previewLayer?.connection { Self.setRotation(c, self.rotationAngle) }
        self.applyTorch()
        // Started while another app holds the camera: the interruption
        // notification says so; otherwise it is running.
        if running && !self.session.isInterrupted { self.reportState("running", reason: nil) }
      }
    }
  }

  /// sessionQueue.
  private func configureSession() throws {
    guard let dev = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
      throw DocumentGeometry.Failure(code: "unavailable", message: "No camera on this device")
    }
    session.beginConfiguration()
    defer { session.commitConfiguration() }
    // A retry after a partial failure (or a media services reset) starts
    // from an empty session.
    for i in session.inputs { session.removeInput(i) }
    for o in session.outputs { session.removeOutput(o) }
    session.sessionPreset = .photo
    // iPad Split View / Slide Over / Stage Manager: keep the camera where
    // the hardware allows it (otherwise the session is interrupted with
    // reason "multitasking").
    if #available(iOS 16.0, *), session.isMultitaskingCameraAccessSupported {
      session.isMultitaskingCameraAccessEnabled = true
    }

    let input = try AVCaptureDeviceInput(device: dev)
    guard session.canAddInput(input) else {
      throw DocumentGeometry.Failure(code: "failed", message: "Could not use the camera")
    }
    session.addInput(input)

    guard session.canAddOutput(photoOutput) else {
      throw DocumentGeometry.Failure(code: "failed", message: "Could not take photos")
    }
    session.addOutput(photoOutput)
    photoOutput.maxPhotoQualityPrioritization = .balanced

    videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
    videoOutput.alwaysDiscardsLateVideoFrames = true
    // Analyse preview-sized frames (about 1920 x 1440), not the photo
    // preset's full sensor size: detection needs no more, and 12 MP frames
    // at 15 Hz cost heat and battery for nothing.
    videoOutput.deliversPreviewSizedOutputBuffers = true
    videoOutput.setSampleBufferDelegate(self, queue: analysisQueue)
    if session.canAddOutput(videoOutput) { session.addOutput(videoOutput) }

    // Buffers and photos upright as the interface is: analysis then works in
    // the same upright, top-left-origin space as the preview and the photo.
    if let c = videoOutput.connection(with: .video) { Self.setRotation(c, sessionRotation) }
    if let c = photoOutput.connection(with: .video) { Self.setRotation(c, sessionRotation) }

    try dev.lockForConfiguration()
    if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
    if dev.isAutoFocusRangeRestrictionSupported { dev.autoFocusRangeRestriction = .near }
    if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
    if dev.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { dev.whiteBalanceMode = .continuousAutoWhiteBalance }
    // Cameras whose minimum focus distance is longer than the distance at
    // which a page fills the frame (recent Pro models) can't focus on a page
    // held that close: zoom in slightly so the user holds the phone farther
    // back, as Apple recommends for close-up scanning.
    let minFocusMM = Double(dev.minimumFocusDistance)
    if minFocusMM > 0 {
      let hfov = Double(dev.activeFormat.videoFieldOfView) * .pi / 180
      // Portrait: the frame's width is the sensor's short side (4:3).
      let shortHalfTan = tan(hfov / 2) * 3 / 4
      let pageFillMM = (210.0 / 0.85) / 2 / shortHalfTan  // A4 width at ~85% of the frame
      if minFocusMM > pageFillMM {
        let zoom = min(1.6, minFocusMM / pageFillMM)
        dev.videoZoomFactor = max(1, min(CGFloat(zoom), dev.activeFormat.videoMaxZoomFactor))
      }
    }
    dev.unlockForConfiguration()
    device = dev
    analysisQueue.async { self.focusDevice = dev }
  }

  /// sessionQueue: back to an unconfigured session (media services reset).
  private func teardownSession() {
    if session.isRunning { session.stopRunning() }
    session.beginConfiguration()
    for i in session.inputs { session.removeInput(i) }
    for o in session.outputs { session.removeOutput(o) }
    session.commitConfiguration()
    configured = false
    device = nil
    analysisQueue.async { self.focusDevice = nil }
  }

  /// Rotation angle for the current interface orientation (90 = portrait),
  /// as AVCaptureConnection.videoRotationAngle counts it for the back camera.
  private func interfaceRotationAngle() -> CGFloat {
    guard let scene = window?.windowScene else { return rotationAngle }
    switch scene.interfaceOrientation {
    case .landscapeRight: return 0
    case .landscapeLeft: return 180
    case .portraitUpsideDown: return 270
    case .portrait: return 90
    default: return rotationAngle
    }
  }

  /// main: follows the interface orientation (iPad), turning the preview,
  /// the analysed frames and the photo together.
  private func updateRotation() {
    let angle = interfaceRotationAngle()
    guard angle != rotationAngle else { return }
    rotationAngle = angle
    if let c = previewLayer?.connection { Self.setRotation(c, angle) }
    sessionQueue.async {
      self.sessionRotation = angle
      if let c = self.videoOutput.connection(with: .video) { Self.setRotation(c, angle) }
      if let c = self.photoOutput.connection(with: .video) { Self.setRotation(c, angle) }
    }
    // Outlines (and page signatures) from the old orientation mean nothing
    // in the new one.
    analysisQueue.async { self.resetDetection(forgetCapture: true) }
    setOverlay(nil, animated: false)
  }

  private static func setRotation(_ c: AVCaptureConnection, _ angle: CGFloat) {
    if #available(iOS 17.0, *) {
      if c.isVideoRotationAngleSupported(angle) { c.videoRotationAngle = angle }
    } else if c.isVideoOrientationSupported {
      switch Int(angle) {
      case 0: c.videoOrientation = .landscapeRight
      case 180: c.videoOrientation = .landscapeLeft
      case 270: c.videoOrientation = .portraitUpsideDown
      default: c.videoOrientation = .portrait
      }
    }
  }

  private func applyTorch(forceOff: Bool = false) {
    let want = torchOn && !forceOff
    sessionQueue.async {
      guard let dev = self.device, dev.hasTorch, dev.isTorchModeSupported(.on) else { return }
      guard self.session.isRunning || !want else { return }
      do {
        try dev.lockForConfiguration()
        dev.torchMode = want ? .on : .off
        dev.unlockForConfiguration()
      } catch {}
    }
  }

  public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                            from connection: AVCaptureConnection) {
    // analysisQueue. Late frames are discarded by the output while we work.
    guard mode == .camera else { return }
    let now = CACurrentMediaTime()
    guard now - lastAnalysis >= Self.analysisInterval,
          let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    lastAnalysis = now
    let size = CGSize(width: CVPixelBufferGetWidth(pixels), height: CVPixelBufferGetHeight(pixels))
    let handler = VNImageRequestHandler(cvPixelBuffer: pixels, orientation: .up, options: [:])
    let quad = DocumentGeometry.detect(handler: handler, minArea: Self.liveMinArea)

    var steady = true
    if let quad = quad {
      let sharp = Self.sharpness(pixels, quad: quad)
      sharpnessPeak = max(sharp, sharpnessPeak * 0.97)
      // Blurry relative to what this page looked like a moment ago (motion
      // blur, refocusing).
      if sharp < sharpnessPeak * 0.6 { steady = false }
    } else {
      sharpnessPeak = 0
    }
    if let dm = motion.deviceMotion {
      let r = dm.rotationRate, a = dm.userAcceleration
      let level = max(sqrt(r.x * r.x + r.y * r.y + r.z * r.z) / 0.35, sqrt(a.x * a.x + a.y * a.y + a.z * a.z) / 0.08)
      motionLevel = motionLevel * 0.6 + level * 0.4
      if motionLevel > 1 { steady = false }
    }
    // The lens settling counts as unsteady, but a lens that keeps hunting
    // (low light, a glossy page) would block auto-capture for good: after
    // 0.8 s the sharpness test alone decides.
    if let dev = focusDevice, dev.isAdjustingFocus {
      let since = focusAdjustingSince ?? now
      focusAdjustingSince = since
      if now - since < 0.8 { steady = false }
    } else {
      focusAdjustingSince = nil
    }
    handleDetection(quad, imageSize: size, now: now, steady: steady) { Self.signature(pixels, quad: $0) }
  }

  /// Content signature of the page inside `quad`, from the luma plane.
  private static func signature(_ buffer: CVPixelBuffer, quad: [CGPoint]) -> PageSignature? {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard CVPixelBufferGetPlaneCount(buffer) > 0,
          let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return nil }
    let w = CVPixelBufferGetWidthOfPlane(buffer, 0), h = CVPixelBufferGetHeightOfPlane(buffer, 0)
    let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
    let ptr = base.assumingMemoryBound(to: UInt8.self)
    return PageSignature.make(quad: quad) { x, y in
      let xi = min(w - 1, max(0, Int(x * CGFloat(w)))), yi = min(h - 1, max(0, Int(y * CGFloat(h))))
      return Float(ptr[yi * stride + xi])
    }
  }

  /// Variance of the Laplacian of luma inside the quad's bounding box,
  /// sampled on a sparse grid at full resolution (fine-scale sharpness, ~30k
  /// samples). Only compared against recent frames of the same page.
  private static func sharpness(_ buffer: CVPixelBuffer, quad: [CGPoint]) -> Double {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard CVPixelBufferGetPlaneCount(buffer) > 0,
          let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return 0 }
    let w = CVPixelBufferGetWidthOfPlane(buffer, 0), h = CVPixelBufferGetHeightOfPlane(buffer, 0)
    let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
    let ptr = base.assumingMemoryBound(to: UInt8.self)
    let xs = quad.map { $0.x }, ys = quad.map { $0.y }
    let x0 = max(1, Int(xs.min()! * CGFloat(w)) + 2), x1 = min(w - 2, Int(xs.max()! * CGFloat(w)) - 2)
    let y0 = max(1, Int(ys.min()! * CGFloat(h)) + 2), y1 = min(h - 2, Int(ys.max()! * CGFloat(h)) - 2)
    guard x1 > x0 + 8, y1 > y0 + 8 else { return 0 }
    let step = max(1, max(x1 - x0, y1 - y0) / 180)
    var sum = 0.0, sumSq = 0.0, n = 0.0
    var y = y0
    while y <= y1 {
      let row = ptr + y * stride
      var x = x0
      while x <= x1 {
        let c = Int(row[x]) * 4
        let lap = Double(c - Int(row[x - 1]) - Int(row[x + 1]) - Int(row[x - stride]) - Int(row[x + stride]))
        sum += lap; sumSq += lap * lap; n += 1
        x += step
      }
      y += step
    }
    guard n > 0 else { return 0 }
    let mean = sum / n
    return sumSq / n - mean * mean
  }

  // MARK: - Still-image mode (simulator, tests)

  private func startStill(path: String) {
    previewLayer?.isHidden = true
    stillLayer.isHidden = false
    let already = stillTimer != nil
    analysisQueue.async {
      if self.stillSourcePath != path || self.stillImage == nil {
        guard let src = try? DocumentGeometry.source(path: path),
              let cg = DocumentGeometry.upright(source: src, maxPixel: 1920) else {
          DispatchQueue.main.async { self.report("unavailable", "Could not read the test image") }
          return
        }
        self.stillImage = cg
        self.stillGray = GrayImage(cg, longEdge: 640)
        self.stillSourcePath = path
        DispatchQueue.main.async {
          self.imageSize = CGSize(width: cg.width, height: cg.height)
          CATransaction.begin()
          CATransaction.setDisableActions(true)
          self.stillLayer.contents = cg
          CATransaction.commit()
        }
      }
      if self.mode != .still {
        self.mode = .still
        self.resetDetection()
      }
    }
    guard !already else { return }
    reportedError = nil
    let timer = DispatchSource.makeTimerSource(queue: analysisQueue)
    timer.schedule(deadline: .now() + 0.1, repeating: Self.analysisInterval)
    timer.setEventHandler { [weak self] in self?.analyseStill() }
    stillTimer = timer
    timer.resume()
  }

  /// analysisQueue: one "frame" of the still image through the live pipeline.
  private func analyseStill() {
    guard mode == .still, let cg = stillImage else { return }
    let now = CACurrentMediaTime()
    var quad = DocumentGeometry.detect(handler: VNImageRequestHandler(cgImage: cg, options: [:]), minArea: Self.liveMinArea)
    var steady = true
    if jitter > 0, let q = quad {
      // Dev: a hand-held phone. Corners wander (sigma up to 0.6% of the
      // frame) and some frames are blurred or shaken.
      let amp = 0.006 * jitter
      quad = q.map { CGPoint(x: $0.x + CGFloat(noise.gauss() * amp), y: $0.y + CGFloat(noise.gauss() * amp)) }
      steady = noise.next() >= 0.2 * jitter
    }
    let gray = stillGray
    handleDetection(quad, imageSize: CGSize(width: cg.width, height: cg.height), now: now, steady: steady) { q in
      gray.flatMap { PageSignature.make(quad: q, luma: $0.luma) }
    }
  }

  // MARK: - Detection -> overlay, events, auto-capture (analysisQueue)

  /// Starts detection over. The last capture is remembered (see
  /// AutoCaptureTracker.restarted) unless `forgetCapture`.
  private func resetDetection(forgetCapture: Bool = false) {
    tracker = forgetCapture ? AutoCaptureTracker() : tracker.restarted()
    smoothed = nil
    missedFrames = 0
    sharpnessPeak = 0
    motionLevel = 0
    lastEmittedHadQuad = false
    lastSignature = nil
    focusAdjustingSince = nil
  }

  /// `signatureOf` reads the page content inside an outline of this frame;
  /// it is given the SMOOTHED outline (detector noise misaligns the grid).
  private func handleDetection(_ quad: [CGPoint]?, imageSize: CGSize, now: CFTimeInterval, steady: Bool,
                               signatureOf: ([CGPoint]) -> PageSignature?) {
    // Overlay: exponential smoothing of the corners; snap on a big jump (a
    // different page); keep the last outline through a couple of missed
    // frames so it doesn't flicker.
    if let q = quad {
      missedFrames = 0
      if let s = smoothed, DocumentGeometry.maxCornerDistance(s, q) < 0.08 {
        let a: CGFloat = 0.45
        smoothed = (0..<4).map { CGPoint(x: s[$0].x + (q[$0].x - s[$0].x) * a, y: s[$0].y + (q[$0].y - s[$0].y) * a) }
      } else {
        smoothed = q
      }
    } else {
      missedFrames += 1
      if missedFrames > 3 { smoothed = nil }
    }

    let signature = quad != nil ? smoothed.flatMap(signatureOf) : nil
    if let sig = signature { lastSignature = sig }
    let (progress, fire) = tracker.update(quad: quad, now: now, steady: steady, signature: signature)
    let shown = smoothed
    let stability = captureInFlight ? 0 : progress

    DispatchQueue.main.async {
      self.imageSize = imageSize
      self.setOverlay(shown, animated: true)
    }

    let hasQuad = shown != nil
    if now - lastEmit >= Self.emitInterval || hasQuad != lastEmittedHadQuad {
      lastEmit = now
      lastEmittedHadQuad = hasQuad
      let payload: [String: Any] = [
        "quad": shown.map { DocumentGeometry.flatten($0) } ?? NSNull(),
        "stability": stability,
        // Width / height of the upright frames: 3:4 in portrait, 4:3 when an
        // iPad is turned. The screen sizes its preview to it.
        "aspect": imageSize.height > 0 ? Double(imageSize.width / imageSize.height) : 0.75,
      ]
      DispatchQueue.main.async { self.onDetection(payload) }
    }

    if fire && autoCaptureEnabled && !captureInFlight {
      beginCapture(fallback: quad ?? shown, completion: nil)
    }
  }

  // MARK: - Overlay (main thread)

  private func setOverlay(_ quad: [CGPoint]?, animated: Bool) {
    shownQuad = quad
    guard let quad = quad else {
      if overlay.opacity != 0 {
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = overlay.presentation()?.opacity ?? overlay.opacity
        fade.toValue = 0
        fade.duration = animated ? 0.2 : 0
        overlay.opacity = 0
        overlay.add(fade, forKey: "fade")
      }
      return
    }
    let pts = Self.layerPoints(quad, imageSize: imageSize, bounds: bounds)
    let path = UIBezierPath()
    path.move(to: pts[0])
    for p in pts.dropFirst() { path.addLine(to: p) }
    path.close()
    let wasHidden = overlay.opacity == 0
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if animated && !wasHidden, let from = overlay.presentation()?.path ?? overlay.path {
      let anim = CABasicAnimation(keyPath: "path")
      anim.fromValue = from
      anim.toValue = path.cgPath
      anim.duration = Self.analysisInterval * 1.2
      anim.timingFunction = CAMediaTimingFunction(name: .linear)
      overlay.add(anim, forKey: "path")
    }
    overlay.path = path.cgPath
    if wasHidden {
      overlay.removeAnimation(forKey: "fade")
      overlay.opacity = 1
      if animated {
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = 0.15
        overlay.add(fade, forKey: "fade")
      }
    }
    CATransaction.commit()
  }

  /// Normalised upright point -> layer point for an aspect-FILL display of an
  /// image of `imageSize` in `bounds` (what both the preview layer and the
  /// still layer do): scale to cover, centre, crop the overflow.
  static func layerPoints(_ quad: [CGPoint], imageSize: CGSize, bounds: CGRect) -> [CGPoint] {
    guard imageSize.width > 0, imageSize.height > 0 else { return quad }
    let s = max(bounds.width / imageSize.width, bounds.height / imageSize.height)
    let dw = imageSize.width * s, dh = imageSize.height * s
    let ox = bounds.minX + (bounds.width - dw) / 2, oy = bounds.minY + (bounds.height - dh) / 2
    return quad.map { CGPoint(x: ox + $0.x * dw, y: oy + $0.y * dh) }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    previewLayer?.frame = bounds
    stillLayer.frame = bounds
    overlay.frame = bounds
    CATransaction.commit()
    updateRotation()
    if let q = shownQuad { setOverlay(q, animated: false) }
  }

  // MARK: - Capture

  /// Forget the last capture: the page under the camera may be auto-captured
  /// again (a retake of the same page).
  func rearm() {
    analysisQueue.async { self.resetDetection(forgetCapture: true) }
  }

  /// Manual shutter. Resolves once the page has been delivered via onCapture.
  func capture(_ promise: Promise) {
    analysisQueue.async {
      guard self.mode != .idle else {
        promise.reject("not-running", "The camera is not running")
        return
      }
      guard !self.captureInFlight else {
        promise.reject("busy", "A capture is already in progress")
        return
      }
      self.beginCapture(fallback: self.tracker.smoothed ?? self.smoothed) { error in
        if let e = error { promise.reject(e.code, e.message) } else { promise.resolve(nil) }
      }
    }
  }

  /// analysisQueue.
  private func beginCapture(fallback: [CGPoint]?, completion: ((DocumentGeometry.Failure?) -> Void)?) {
    captureInFlight = true
    captureToken += 1
    let token = captureToken
    tracker.didCapture(quad: fallback, now: CACurrentMediaTime(), signature: fallback == nil ? nil : lastSignature)
    let still = mode == .still ? stillSourcePath : nil
    let flash = captureFlash
    DispatchQueue.main.async { self.onCaptureStart([:]) }

    // Settles this shot exactly once: the photo, a failure, or the watchdog.
    // A result for a shot already given up is thrown away (its file deleted).
    let finish: (Result<[String: Any], DocumentGeometry.Failure>) -> Void = { result in
      self.analysisQueue.async {
        guard self.captureInFlight, self.captureToken == token else {
          if case .success(let payload) = result, let uri = payload["sourceUri"] as? String,
             let url = URL(string: uri) {
            try? FileManager.default.removeItem(at: url)
          }
          return
        }
        self.captureInFlight = false
        // The hold starts over for the next page.
        self.tracker.captureFinished(now: CACurrentMediaTime())
        // Stopped meanwhile (backgrounded, locked, closed): a failure is
        // expected and not worth an error; the screen resumes by itself.
        let running = self.mode != .idle
        DispatchQueue.main.async {
          switch result {
          case .success(let payload):
            self.onCapture(payload)
            completion?(nil)
          case .failure(let e):
            if running {
              self.onCameraError(["code": "failed", "message": e.message, "capture": true])
              completion?(e)
            } else {
              completion?(.init(code: "not-running", message: e.message))
            }
          }
        }
      }
    }
    analysisQueue.asyncAfter(deadline: .now() + Self.captureTimeout) {
      guard self.captureInFlight, self.captureToken == token else { return }
      finish(.failure(.init(code: "failed", message: "The photo took too long")))
    }

    if let path = still {
      workQueue.async {
        do {
          let src = try DocumentGeometry.source(path: path)
          let (out, w, h, quad) = try Self.saveCapture(src)
          finish(.success(Self.payload(out, w, h, quad ?? fallback)))
        } catch let e as DocumentGeometry.Failure {
          finish(.failure(e))
        } catch {
          finish(.failure(.init(code: "failed", message: error.localizedDescription)))
        }
      }
      return
    }

    sessionQueue.async {
      guard self.session.isRunning, let conn = self.photoOutput.connection(with: .video), conn.isEnabled else {
        finish(.failure(.init(code: "not-running", message: "The camera is not running")))
        return
      }
      Self.setRotation(conn, self.sessionRotation)
      let settings = AVCapturePhotoSettings()
      if self.photoOutput.supportedFlashModes.contains(flash) { settings.flashMode = flash }
      settings.photoQualityPrioritization = .balanced
      let id = settings.uniqueID
      let delegate = PhotoDelegate { data, error in
        self.sessionQueue.async { self.photoDelegates[id] = nil }
        guard let data = data else {
          finish(.failure(.init(code: "failed", message: error?.localizedDescription ?? "The photo could not be taken")))
          return
        }
        self.workQueue.async {
          do {
            guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else {
              throw DocumentGeometry.Failure(code: "failed", message: "Could not read the photo")
            }
            let (out, w, h, quad) = try Self.saveCapture(src)
            finish(.success(Self.payload(out, w, h, quad ?? fallback)))
          } catch let e as DocumentGeometry.Failure {
            finish(.failure(e))
          } catch {
            finish(.failure(.init(code: "failed", message: error.localizedDescription)))
          }
        }
      }
      self.photoDelegates[id] = delegate
      self.photoOutput.capturePhoto(with: settings, delegate: delegate)
    }
  }

  /// Upright JPEG (q 0.92, long edge at most captureMaxEdge) in
  /// Caches/scanner-src, plus the page outline detected on the still
  /// (sharper than any video frame). The photo is decoded once and encoded
  /// once; the outline is found on that same bitmap. The JPEG is already what
  /// the save path keeps (lib/page-source normalizeImage copies it as is).
  private static func saveCapture(_ src: CGImageSource) throws -> (String, Int, Int, [CGPoint]?) {
    try autoreleasepool {
      guard let image = DocumentGeometry.upright(source: src, maxPixel: captureMaxEdge) else {
        throw DocumentGeometry.Failure(code: "failed", message: "Could not decode the photo")
      }
      let out = newSourcePath()
      try DocumentGeometry.writeJPEG(image, to: out, quality: 0.92)
      let quad = DocumentGeometry.detect(image)
      return (out, image.width, image.height, quad)
    }
  }

  private static var counter = 0
  private static let counterLock = NSLock()

  private static func newSourcePath() -> String {
    counterLock.lock()
    counter += 1
    let n = counter
    counterLock.unlock()
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    let dir = caches.appendingPathComponent("scanner-src", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let ms = Int64(Date().timeIntervalSince1970 * 1000)
    return dir.appendingPathComponent("src-\(ms)-\(n).jpg").path
  }

  private static func payload(_ path: String, _ w: Int, _ h: Int, _ quad: [CGPoint]?) -> [String: Any] {
    [
      "sourceUri": URL(fileURLWithPath: path).absoluteString,
      "width": w,
      "height": h,
      "quad": quad.map { DocumentGeometry.flatten($0) } ?? NSNull(),
    ]
  }
}

/// Keeps one photo capture's delegate alive until its data arrives.
private final class PhotoDelegate: NSObject, AVCapturePhotoCaptureDelegate {
  private let done: (Data?, Error?) -> Void
  private var called = false

  init(done: @escaping (Data?, Error?) -> Void) {
    self.done = done
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
    guard !called else { return }
    called = true
    done(error == nil ? photo.fileDataRepresentation() : nil, error)
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings,
                   error: Error?) {
    guard !called else { return }
    called = true
    done(nil, error ?? DocumentGeometry.Failure(code: "failed", message: "No photo was produced"))
  }
}

extension DocumentGeometry.Failure: LocalizedError {
  var errorDescription: String? { message }
}

/// An 8-bit grey copy of a still (simulator feed) for page signatures.
private struct GrayImage {
  let width: Int
  let height: Int
  let pixels: [UInt8]

  init?(_ image: CGImage, longEdge: Int) {
    let s = Double(longEdge) / Double(max(image.width, image.height, 1))
    let w = max(1, Int(Double(image.width) * min(1, s))), h = max(1, Int(Double(image.height) * min(1, s)))
    var px = [UInt8](repeating: 0, count: w * h)
    let ok: Bool = px.withUnsafeMutableBytes { buf in
      guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
      ctx.interpolationQuality = .medium
      ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
      return true
    }
    guard ok else { return nil }
    width = w
    height = h
    pixels = px
  }

  func luma(_ x: CGFloat, _ y: CGFloat) -> Float {
    let xi = min(width - 1, max(0, Int(x * CGFloat(width)))), yi = min(height - 1, max(0, Int(y * CGFloat(height))))
    return Float(pixels[yi * width + xi])
  }
}

/// Small deterministic random numbers (dev jitter only).
private struct SplitMix {
  var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> Double {
    state &+= 0x9E3779B97F4A7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
    z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
    return Double((z ^ (z >> 31)) >> 11) / Double(1 << 53)
  }
  mutating func gauss() -> Double {
    let u = max(1e-12, next()), v = next()
    return (-2 * log(u)).squareRoot() * cos(2 * .pi * v)
  }
}

package expo.modules.visionocr

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.view.animation.DecelerateInterpolator
import android.widget.OverScroller
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The scrolling, zooming page column of PdfDocumentView: continuous vertical
 * scroll with fling, pinch zoom (1×–6×) and double-tap zoom, pages on white
 * with a soft shadow on the caller's background, `margin` around and
 * between them (PDFView on iOS: singlePageContinuous, autoScales, page
 * shadows, 16 pt margins).
 *
 * Drawing is lazy: each page near the view gets a bitmap rendered at its
 * fit-to-width size (an LRU cache bounded by the heap), drawn scaled while
 * zooming; once a gesture settles above that resolution, the visible part
 * of each page is rendered again at the current zoom ("detail") and drawn
 * on top, so text stays sharp at any zoom. Rendering happens on the owner's
 * single PDFium thread through [renderer]; everything here runs on the main
 * thread.
 */
@SuppressLint("ViewConstructor")
class PdfPagesView(context: Context, private val onPage: (page: Int, count: Int) -> Unit) : View(context) {

  /** Renders page `index` scaled to sizeX × sizeY at (startX, startY) of `bitmap`; false when the document is gone. */
  fun interface Renderer {
    fun render(index: Int, bitmap: Bitmap, startX: Int, startY: Int, sizeX: Int, sizeY: Int): Boolean
  }

  private val density = resources.displayMetrics.density
  private val margin = 16f * density
  private val main = Handler(Looper.getMainLooper())

  private var sizes: FloatArray? = null
  private var renderer: Renderer? = null
  private var submit: ((Runnable) -> Unit)? = null
  /** Bumped whenever the document or layout changes: late renders for an older one are dropped. */
  private var generation = 0

  private var layout: PdfPageLayout? = null
  private var zoom = 1f
  private var scrollXf = 0f
  private var scrollYf = 0f
  private var lastPage = -1
  private var pendingPage: Int? = null

  private var bg = Color.BLACK
  private val pagePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE
    setShadowLayer(5f * density, 0f, 1.5f * density, 0x59000000)
  }
  private val bitmapPaint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.DITHER_FLAG)
  private val src = Rect()
  private val dst = RectF()

  // ── Bitmaps ───────────────────────────────────────────────────────────────

  private class Base(val bitmap: Bitmap, val layoutWidth: Float)

  /** A part of a page rendered at `zoom`: `rect` in zoomed content pixels. */
  private class Detail(val bitmap: Bitmap, val zoom: Float, val rect: RectF, val generation: Int)

  private val maxBytes = (Runtime.getRuntime().maxMemory() / 5).coerceIn(16L shl 20, 160L shl 20).toInt()
  private val base = object : LruCache<Int, Base>(maxBytes) {
    override fun sizeOf(key: Int, value: Base) = value.bitmap.allocationByteCount
  }
  private val baseWanted = HashSet<Int>()
  private val details = HashMap<Int, Detail>()
  private var detailToken = 0
  /** Pages the renderer may still work on (read from the render thread to skip stale jobs). */
  @Volatile private var near: IntRange = IntRange.EMPTY

  // ── Gestures ──────────────────────────────────────────────────────────────

  private val scroller = OverScroller(context)
  private var zoomAnimator: ValueAnimator? = null
  private var touching = false
  private var lastFocusX = 0f
  private var lastFocusY = 0f

  private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
    override fun onScaleBegin(d: ScaleGestureDetector): Boolean {
      lastFocusX = d.focusX
      lastFocusY = d.focusY
      return layout != null
    }

    override fun onScale(d: ScaleGestureDetector): Boolean {
      val l = layout ?: return false
      val z1 = PdfPageLayout.clampZoom(zoom * d.scaleFactor)
      val (x, y) = l.zoomAround(scrollXf, scrollYf, zoom, z1, d.focusX, d.focusY)
      zoom = z1
      // Two fingers also pan.
      scrollTo(x - (d.focusX - lastFocusX), y - (d.focusY - lastFocusY))
      lastFocusX = d.focusX
      lastFocusY = d.focusY
      return true
    }
  })

  private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDown(e: MotionEvent): Boolean {
      scroller.forceFinished(true)
      zoomAnimator?.cancel()
      return true
    }

    override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
      if (scaleDetector.isInProgress || e2.pointerCount > 1) return false
      scrollTo(scrollXf + dx, scrollYf + dy)
      return true
    }

    override fun onFling(e1: MotionEvent?, e2: MotionEvent, vx: Float, vy: Float): Boolean {
      val l = layout ?: return false
      if (scaleDetector.isInProgress) return false
      scroller.fling(
        scrollXf.roundToInt(), scrollYf.roundToInt(), -vx.roundToInt(), -vy.roundToInt(),
        0, l.maxScrollX(zoom).roundToInt(), 0, l.maxScrollY(zoom).roundToInt(),
      )
      postInvalidateOnAnimation()
      return true
    }

    override fun onDoubleTap(e: MotionEvent): Boolean {
      animateZoom(if (zoom > 1.2f) 1f else 2.5f, e.x, e.y)
      return true
    }
  })

  init {
    isClickable = true
    isFocusable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    contentDescription = null
  }

  // ── Public (main thread) ──────────────────────────────────────────────────

  fun setBackgroundHex(color: Int) {
    bg = color
    invalidate()
  }

  /** A loaded document: page sizes in points (w0, h0, …) and how to draw a page. */
  fun setDocument(pageSizes: FloatArray, renderer: Renderer, submit: (Runnable) -> Unit) {
    clear()
    sizes = pageSizes
    this.renderer = renderer
    this.submit = submit
    zoom = 1f
    scrollXf = 0f
    scrollYf = 0f
    relayout()
  }

  /** Forgets the document (a new source, an error, or the view going away). */
  fun clear() {
    generation++
    detailToken++
    sizes = null
    renderer = null
    submit = null
    layout = null
    lastPage = -1
    near = IntRange.EMPTY
    base.evictAll()
    baseWanted.clear()
    details.clear()
    scroller.forceFinished(true)
    zoomAnimator?.cancel()
    main.removeCallbacksAndMessages(null)
    invalidate()
  }

  /** Shows page `index` (zero-based) at the top once laid out (initialPage; applied once). */
  fun goToPage(index: Int) {
    pendingPage = index
    applyPendingPage()
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    relayout()
  }

  private fun relayout() {
    val s = sizes ?: return
    if (width <= 0 || height <= 0) return
    val old = layout
    val next = PdfPageLayout(s, width.toFloat(), height.toFloat(), margin)
    if (old == null) {
      layout = next
      zoom = 1f
      scrollXf = 0f
      scrollYf = 0f
    } else {
      // Keep a user's zoom and place across relayouts (a banner dismissed,
      // rotation); a fitted page stays fitted.
      val anchor = old.anchorOf(scrollXf, scrollYf, zoom)
      val z = PdfPageLayout.zoomAfterResize(zoom, old.baseScale, next.baseScale)
      layout = next
      zoom = z
      val (x, y) = next.scrollFor(anchor, z)
      scrollXf = x
      scrollYf = y
      if (old.viewWidth != next.viewWidth) generation++
      details.clear()
    }
    applyPendingPage()
    changed(settled = true)
  }

  private fun applyPendingPage() {
    val l = layout ?: return
    val p = pendingPage ?: return
    pendingPage = null
    if (l.count == 0) return
    scrollYf = l.scrollYForPage(p, zoom)
    changed(settled = true)
  }

  // ── Scrolling and zooming ─────────────────────────────────────────────────

  private fun scrollTo(x: Float, y: Float) {
    val l = layout ?: return
    scrollXf = l.clampX(x, zoom)
    scrollYf = l.clampY(y, zoom)
    changed(settled = false)
  }

  private fun animateZoom(target: Float, fx: Float, fy: Float) {
    val l = layout ?: return
    zoomAnimator?.cancel()
    val z0 = zoom
    val x0 = scrollXf
    val y0 = scrollYf
    val z1 = PdfPageLayout.clampZoom(target)
    // Where the double-tapped point ends up: under the finger, unless the
    // view must be clamped there.
    val (x1, y1) = l.zoomAround(x0, y0, z0, z1, fx, fy)
    zoomAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 240
      interpolator = DecelerateInterpolator()
      addUpdateListener {
        val t = it.animatedValue as Float
        zoom = z0 + (z1 - z0) * t
        scrollXf = l.clampX(x0 + (x1 - x0) * t, zoom)
        scrollYf = l.clampY(y0 + (y1 - y0) * t, zoom)
        changed(settled = t >= 1f)
      }
      start()
    }
  }

  override fun computeScroll() {
    if (scroller.computeScrollOffset()) {
      val l = layout ?: return
      scrollXf = l.clampX(scroller.currX.toFloat(), zoom)
      scrollYf = l.clampY(scroller.currY.toFloat(), zoom)
      val done = scroller.isFinished
      changed(settled = done)
      if (!done) postInvalidateOnAnimation()
    }
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (layout == null) return false
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        touching = true
        // The page column owns the gesture (RN's ancestors must not take it).
        parent?.requestDisallowInterceptTouchEvent(true)
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> touching = false
    }
    scaleDetector.onTouchEvent(event)
    gestures.onTouchEvent(event)
    if (!touching && scroller.isFinished && zoomAnimator?.isRunning != true) changed(settled = true)
    return true
  }

  /** After any change of scroll or zoom: page counter, renders, redraw. */
  private fun changed(settled: Boolean) {
    val l = layout ?: return
    val page = l.pageAtCenter(scrollYf, zoom)
    if (page != lastPage) {
      lastPage = page
      onPage(page, l.count)
    }
    requestBase()
    main.removeCallbacks(detailRunnable)
    if (settled && !touching) main.postDelayed(detailRunnable, 90)
    invalidate()
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /** Bitmap size for page `i` at fit-to-width (capped so one page can't take the heap). */
  private fun baseSize(l: PdfPageLayout, i: Int): Pair<Int, Int> {
    val p = l.pages[i]
    return PdfPageLayout.renderSize(p.width, p.height, BASE_MAX_PIXELS)
  }

  private fun requestBase() {
    val l = layout ?: return
    val r = renderer ?: return
    val run = submit ?: return
    val range = l.visibleRange(scrollYf, zoom, extra = height * 0.75f)
    near = range
    val gen = generation
    for (i in range) {
      val have = base.get(i)
      if ((have != null && have.layoutWidth == l.viewWidth) || !baseWanted.add(i)) continue
      val (w, h) = baseSize(l, i)
      run(Runnable {
        // Scrolled far past it meanwhile: skip (a fling through a long PDF).
        if (gen != generation || i !in near) {
          main.post { if (gen == generation) baseWanted.remove(i) }
          return@Runnable
        }
        val bmp = try {
          Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        } catch (e: OutOfMemoryError) {
          null
        }
        val ok = bmp != null && try { r.render(i, bmp, 0, 0, w, h) } catch (e: Throwable) { false }
        main.post {
          if (gen != generation) return@post
          baseWanted.remove(i)
          if (ok && bmp != null) {
            base.put(i, Base(bmp, l.viewWidth))
            invalidate()
          }
        }
      })
    }
  }

  private val detailRunnable = Runnable { requestDetail() }

  /** The visible part of each visible page again at the current zoom, when the cached bitmap is too coarse. */
  private fun requestDetail() {
    val l = layout ?: return
    val r = renderer ?: return
    val run = submit ?: return
    if (touching || !scroller.isFinished || zoomAnimator?.isRunning == true) return
    val token = ++detailToken
    val gen = generation
    val z = zoom
    val sx = scrollXf
    val sy = scrollYf
    val pad = l.padTop(z)
    val visible = l.visibleRange(sy, z)
    details.keys.retainAll(visible.toSet())
    for (i in visible) {
      val pv = l.pageInView(i, sx, sy, z)
      val (bw, _) = baseSize(l, i)
      // Sharp enough already: the cached bitmap has the pixels shown.
      if (bw >= pv.width * 0.98f) {
        details.remove(i)
        continue
      }
      val left = max(0f, pv.left)
      val top = max(0f, pv.top)
      val right = min(width.toFloat(), pv.right)
      val bottom = min(height.toFloat(), pv.bottom)
      if (right - left < 1f || bottom - top < 1f) continue
      val d = details[i]
      val rect = RectF(left + sx, top + sy - pad, right + sx, bottom + sy - pad)
      if (d != null && d.zoom == z && d.generation == gen && d.rect.contains(rect)) continue
      val w = (right - left).roundToInt().coerceAtLeast(1)
      val h = (bottom - top).roundToInt().coerceAtLeast(1)
      val startX = (pv.left - left).roundToInt()
      val startY = (pv.top - top).roundToInt()
      val sizeX = pv.width.roundToInt()
      val sizeY = pv.height.roundToInt()
      run(Runnable {
        if (token != detailToken || gen != generation) return@Runnable
        val bmp = try {
          Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        } catch (e: OutOfMemoryError) {
          null
        } ?: return@Runnable
        val ok = try { r.render(i, bmp, startX, startY, sizeX, sizeY) } catch (e: Throwable) { false }
        if (!ok) return@Runnable
        main.post {
          if (token != detailToken || gen != generation) return@post
          details[i] = Detail(bmp, z, rect, gen)
          invalidate()
        }
      })
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  override fun onDraw(canvas: Canvas) {
    canvas.drawColor(bg)
    val l = layout ?: return
    val pad = l.padTop(zoom)
    for (i in l.visibleRange(scrollYf, zoom, extra = 8f * density)) {
      val pv = l.pageInView(i, scrollXf, scrollYf, zoom)
      dst.set(pv.left, pv.top, pv.right, pv.bottom)
      canvas.drawRect(dst, pagePaint)
      base.get(i)?.let { b ->
        src.set(0, 0, b.bitmap.width, b.bitmap.height)
        canvas.drawBitmap(b.bitmap, src, dst, bitmapPaint)
      }
      details[i]?.let { d ->
        if (d.generation != generation) return@let
        val k = zoom / d.zoom
        dst.set(
          d.rect.left * k - scrollXf, d.rect.top * k - scrollYf + pad,
          d.rect.right * k - scrollXf, d.rect.bottom * k - scrollYf + pad,
        )
        src.set(0, 0, d.bitmap.width, d.bitmap.height)
        canvas.drawBitmap(d.bitmap, src, dst, bitmapPaint)
      }
    }
  }

  // ── Accessibility: scroll by a screen ─────────────────────────────────────

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    val l = layout ?: return
    info.isScrollable = l.maxScrollY(zoom) > 0
    if (scrollYf > 0) info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD)
    if (scrollYf < l.maxScrollY(zoom)) info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD)
  }

  override fun performAccessibilityAction(action: Int, arguments: android.os.Bundle?): Boolean {
    if (layout == null) return super.performAccessibilityAction(action, arguments)
    val step = height * 0.85f
    return when (action) {
      AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> { scrollTo(scrollXf, scrollYf + step); changed(true); true }
      AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> { scrollTo(scrollXf, scrollYf - step); changed(true); true }
      else -> super.performAccessibilityAction(action, arguments)
    }
  }

  companion object {
    /** A fit-to-width page bitmap holds at most this many pixels (≈ 12 MB). */
    const val BASE_MAX_PIXELS = 3_000_000L
  }
}

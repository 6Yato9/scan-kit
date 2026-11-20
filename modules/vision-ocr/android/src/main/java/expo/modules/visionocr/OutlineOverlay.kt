package expo.modules.visionocr

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.view.View
import android.view.animation.LinearInterpolator
import expo.modules.visionocr.QuadMath.Pt
import kotlin.math.max

/**
 * The live page outline over the camera preview: accent #2BB5D1, 20 % fill,
 * 2 dp stroke, fading in and out like the CAShapeLayer in
 * DocumentCameraView.swift. Points are normalised in the upright frame and
 * mapped with the same aspect-fill rule as the preview (layerPoints).
 */
@SuppressLint("ViewConstructor")
class OutlineOverlay(context: Context) : View(context) {
  private val density = context.resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.FILL
    color = Color.argb((0.2 * 255).toInt(), 0x2B, 0xB5, 0xD1)
  }
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    color = ACCENT
    strokeWidth = 2 * density
    strokeJoin = Paint.Join.ROUND
  }
  private val path = Path()

  /** What is drawn now (normalised), and where it is heading. */
  private var shown: List<Pt>? = null
  private var from: List<Pt>? = null
  private var target: List<Pt>? = null
  private var imageWidth = 3.0
  private var imageHeight = 4.0
  private var progress = 1f
  private val mover = ValueAnimator.ofFloat(0f, 1f).apply {
    interpolator = LinearInterpolator()
    addUpdateListener {
      progress = it.animatedValue as Float
      val f = from
      val t = target
      shown = if (f != null && t != null) List(4) { i -> Pt(f[i].x + (t[i].x - f[i].x) * progress, f[i].y + (t[i].y - f[i].y) * progress) } else t
      invalidate()
    }
  }

  init {
    alpha = 0f
    setWillNotDraw(false)
  }

  private var visible = false

  /** main thread. `quad` null fades the outline out. */
  fun setQuad(quad: List<Pt>?, imageWidth: Int, imageHeight: Int, animated: Boolean, stepMs: Long) {
    if (imageWidth > 0 && imageHeight > 0) {
      this.imageWidth = imageWidth.toDouble()
      this.imageHeight = imageHeight.toDouble()
    }
    if (quad == null) {
      if (!visible) return
      visible = false
      mover.cancel()
      animate().cancel()
      if (animated) animate().alpha(0f).setDuration(200).start() else alpha = 0f
      return
    }
    mover.cancel()
    if (animated && visible && shown != null) {
      from = shown
      target = quad
      mover.duration = max(16L, stepMs)
      mover.start()
    } else {
      from = null
      target = quad
      shown = quad
      invalidate()
    }
    if (!visible) {
      visible = true
      animate().cancel()
      if (animated) animate().alpha(1f).setDuration(150).start() else alpha = 1f
    }
  }

  /** The outline moved with the view (relayout). */
  fun redraw() = invalidate()

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val q = shown ?: return
    val pts = layerPoints(q, imageWidth, imageHeight, width.toDouble(), height.toDouble())
    path.reset()
    path.moveTo(pts[0].x.toFloat(), pts[0].y.toFloat())
    for (i in 1 until 4) path.lineTo(pts[i].x.toFloat(), pts[i].y.toFloat())
    path.close()
    canvas.drawPath(path, fill)
    canvas.drawPath(path, stroke)
  }

  companion object {
    val ACCENT = Color.rgb(0x2B, 0xB5, 0xD1)

    /**
     * Normalised upright point -> view point for an aspect-FILL display of an
     * image of `iw` x `ih` in a `bw` x `bh` view (what the preview and the
     * still do): scale to cover, centre, crop the overflow. Same rule as
     * DocumentCameraView.layerPoints and lib/camera-layout.ts.
     */
    fun layerPoints(quad: List<Pt>, iw: Double, ih: Double, bw: Double, bh: Double): List<Pt> {
      if (iw <= 0 || ih <= 0) return quad
      val s = max(bw / iw, bh / ih)
      val dw = iw * s
      val dh = ih * s
      val ox = (bw - dw) / 2
      val oy = (bh - dh) / 2
      return quad.map { Pt(ox + it.x * dw, oy + it.y * dh) }
    }
  }
}

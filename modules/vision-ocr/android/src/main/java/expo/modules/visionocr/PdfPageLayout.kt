package expo.modules.visionocr

import kotlin.math.max
import kotlin.math.min

/** A rectangle in pixels (left, top, right, bottom); pure, for JVM tests. */
data class Box(val left: Float, val top: Float, val right: Float, val bottom: Float) {
  val width get() = right - left
  val height get() = bottom - top
  fun intersects(o: Box) = left < o.right && o.left < right && top < o.bottom && o.top < bottom
}

/**
 * Geometry of the PDF viewer (PdfDocumentView.kt), pure so it can be unit
 * tested: pages in one column with `margin` around and between them, all at
 * one scale that fits the widest page to the view's width (PDFKit's
 * singlePageContinuous + autoScales on iOS). At zoom 1 the content is
 * exactly as wide as the view; zoom z scales it about the content origin.
 * A document shorter than the view is centred vertically.
 *
 * Coordinates: "content" = zoom-1 pixels from the content's top-left;
 * "scroll" = zoomed pixels; "view" = pixels in the view.
 */
class PdfPageLayout(
  /** Page sizes in points, as displayed (the page's /Rotate applied): w0, h0, w1, h1, … */
  private val sizes: FloatArray,
  val viewWidth: Float,
  val viewHeight: Float,
  val margin: Float,
) {
  val count = sizes.size / 2
  /** Pixels per point at zoom 1. */
  val baseScale: Float
  val pages: List<Box>
  /** Content height at zoom 1 (margins included). */
  val contentHeight: Float

  init {
    var widest = 1f
    for (i in 0 until count) widest = max(widest, sizes[2 * i])
    baseScale = max(0.0001f, (viewWidth - 2 * margin) / widest)
    val list = ArrayList<Box>(count)
    var y = margin
    for (i in 0 until count) {
      val w = sizes[2 * i] * baseScale
      val h = max(1f, sizes[2 * i + 1] * baseScale)
      val left = (viewWidth - w) / 2
      list.add(Box(left, y, left + w, y + h))
      y += h + margin
    }
    pages = list
    contentHeight = if (count == 0) 2 * margin else y
  }

  /** Space above the content when it is shorter than the view (centred). */
  fun padTop(zoom: Float): Float = max(0f, (viewHeight - contentHeight * zoom) / 2)

  fun maxScrollX(zoom: Float): Float = max(0f, viewWidth * zoom - viewWidth)
  fun maxScrollY(zoom: Float): Float = max(0f, contentHeight * zoom - viewHeight)

  fun clampX(x: Float, zoom: Float) = x.coerceIn(0f, maxScrollX(zoom))
  fun clampY(y: Float, zoom: Float) = y.coerceIn(0f, maxScrollY(zoom))

  /** Page `i`'s rectangle in view pixels for this scroll and zoom. */
  fun pageInView(i: Int, scrollX: Float, scrollY: Float, zoom: Float): Box {
    val p = pages[i]
    val pad = padTop(zoom)
    return Box(p.left * zoom - scrollX, p.top * zoom - scrollY + pad, p.right * zoom - scrollX, p.bottom * zoom - scrollY + pad)
  }

  /** The first page whose bottom (plus half a gap) is below content y `cy`. */
  private fun firstBelow(cy: Float): Int {
    var lo = 0
    var hi = count - 1
    while (lo < hi) {
      val mid = (lo + hi) / 2
      if (pages[mid].bottom + margin / 2 < cy) lo = mid + 1 else hi = mid
    }
    return lo
  }

  /** Pages that intersect the view (plus `extra` pixels above and below), or an empty range. */
  fun visibleRange(scrollY: Float, zoom: Float, extra: Float = 0f): IntRange {
    if (count == 0) return IntRange.EMPTY
    val pad = padTop(zoom)
    val top = (scrollY - pad - extra) / zoom
    val bottom = (scrollY - pad + viewHeight + extra) / zoom
    var first = firstBelow(top)
    while (first > 0 && pages[first - 1].bottom > top) first--
    var last = first
    while (last + 1 < count && pages[last + 1].top < bottom) last++
    return first..last
  }

  /** The page under the vertical centre of the view (onPageChange). */
  fun pageAtCenter(scrollY: Float, zoom: Float): Int {
    if (count == 0) return 0
    val cy = (scrollY - padTop(zoom) + viewHeight / 2) / zoom
    return firstBelow(cy)
  }

  /** Scroll that puts page `i`'s top (less one margin) at the top of the view, as PDFView.go(to:). */
  fun scrollYForPage(i: Int, zoom: Float): Float {
    if (count == 0) return 0f
    val p = pages[i.coerceIn(0, count - 1)]
    return clampY((p.top - margin) * zoom, zoom)
  }

  /**
   * Scroll after zooming from `z0` to `z1` about the view point (fx, fy), so
   * the content under it stays put; clamped.
   */
  fun zoomAround(scrollX: Float, scrollY: Float, z0: Float, z1: Float, fx: Float, fy: Float): Pair<Float, Float> {
    val cx = (scrollX + fx) / z0
    val cy = (scrollY + fy - padTop(z0)) / z0
    val x = cx * z1 - fx
    val y = cy * z1 - fy + padTop(z1)
    return clampX(x, z1) to clampY(y, z1)
  }

  /** Where the view's top-left corner is, independent of the view size: (page, fraction down it, fraction across the content). */
  data class Anchor(val page: Int, val down: Float, val across: Float)

  fun anchorOf(scrollX: Float, scrollY: Float, zoom: Float): Anchor {
    if (count == 0) return Anchor(0, 0f, 0f)
    val cy = (scrollY - padTop(zoom)) / zoom
    val i = firstBelow(cy)
    val p = pages[i]
    return Anchor(i, ((cy - p.top) / p.height), (scrollX / zoom) / viewWidth)
  }

  /** The scroll that shows `anchor` at the view's top-left corner in this layout. */
  fun scrollFor(anchor: Anchor, zoom: Float): Pair<Float, Float> {
    if (count == 0) return 0f to 0f
    val p = pages[anchor.page.coerceIn(0, count - 1)]
    val cy = p.top + anchor.down * p.height
    return clampX(anchor.across * viewWidth * zoom, zoom) to clampY(cy * zoom + padTop(zoom), zoom)
  }

  companion object {
    const val MIN_ZOOM = 1f
    const val MAX_ZOOM = 6f

    /**
     * The zoom after the view's width changed (rotation; iOS keeps a user's
     * zoom across relayouts unless the page was fitted): the same scale of
     * points to pixels, never below fit-to-width.
     */
    fun zoomAfterResize(zoom: Float, oldBaseScale: Float, newBaseScale: Float): Float {
      if (zoom <= MIN_ZOOM + 0.001f || newBaseScale <= 0f) return MIN_ZOOM
      return (zoom * oldBaseScale / newBaseScale).coerceIn(MIN_ZOOM, MAX_ZOOM)
    }

    /**
     * Pixel size to render a page bitmap at so it is sharp when shown
     * `shownW` × `shownH`, within `maxPixels` (scaled down proportionally).
     */
    fun renderSize(shownW: Float, shownH: Float, maxPixels: Long): Pair<Int, Int> {
      val w = max(1f, shownW)
      val h = max(1f, shownH)
      val area = w.toDouble() * h.toDouble()
      val k = if (area > maxPixels) kotlin.math.sqrt(maxPixels / area).toFloat() else 1f
      return max(1, (w * k).toInt()) to max(1, (h * k).toInt())
    }

    /** min/max helpers kept here so the view code reads simply. */
    fun clampZoom(z: Float) = min(MAX_ZOOM, max(MIN_ZOOM, z))
  }
}

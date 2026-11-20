package expo.modules.visionocr

import expo.modules.visionocr.QuadMath.Pt
import java.nio.ByteBuffer
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Brightness 0..255 at a normalised point (top-left origin) of an UPRIGHT frame. */
fun interface LumaSource {
  fun luma(x: Double, y: Double): Float
}

/**
 * An 8-bit grey image, row-major, no padding, upright. What the page detector,
 * page signatures and the still (emulator) feed work on. Pure Kotlin.
 */
class GrayImage(val width: Int, val height: Int, val pixels: ByteArray) : LumaSource {
  init {
    require(width > 0 && height > 0 && pixels.size >= width * height)
  }

  fun at(x: Int, y: Int): Int = pixels[y * width + x].toInt() and 0xFF

  /** Nearest sample, like GrayImage.luma in DocumentCameraView.swift. */
  override fun luma(x: Double, y: Double): Float {
    val xi = min(width - 1, max(0, (x * width).toInt()))
    val yi = min(height - 1, max(0, (y * height).toInt()))
    return (pixels[yi * width + xi].toInt() and 0xFF).toFloat()
  }

  /** Box-filtered copy with the long edge at most `longEdge` (never upscaled). */
  fun scaledTo(longEdge: Int): GrayImage {
    val long = max(width, height)
    if (long <= longEdge) return this
    val s = longEdge.toDouble() / long
    val w = max(1, (width * s).roundToInt())
    val h = max(1, (height * s).roundToInt())
    return boxResample(w, h) { x, y -> pixels[y * width + x].toInt() and 0xFF }
  }

  private fun boxResample(w: Int, h: Int, src: (Int, Int) -> Int): GrayImage {
    val out = ByteArray(w * h)
    val fx = width.toDouble() / w
    val fy = height.toDouble() / h
    for (oy in 0 until h) {
      val y0 = floor(oy * fy).toInt()
      val y1 = min(height, max(y0 + 1, ceil((oy + 1) * fy).toInt()))
      for (ox in 0 until w) {
        val x0 = floor(ox * fx).toInt()
        val x1 = min(width, max(x0 + 1, ceil((ox + 1) * fx).toInt()))
        var sum = 0
        for (y in y0 until y1) for (x in x0 until x1) sum += src(x, y)
        out[oy * w + ox] = (sum / ((y1 - y0) * (x1 - x0))).toByte()
      }
    }
    return GrayImage(w, h, out)
  }

  companion object {
    /** Grey from packed ARGB pixels (Bitmap.getPixels), Rec. 601 luma. */
    fun fromArgb(width: Int, height: Int, argb: IntArray): GrayImage {
      val px = ByteArray(width * height)
      for (i in 0 until width * height) {
        val c = argb[i]
        val r = (c shr 16) and 0xFF
        val g = (c shr 8) and 0xFF
        val b = c and 0xFF
        px[i] = ((r * 299 + g * 587 + b * 114 + 500) / 1000).toByte()
      }
      return GrayImage(width, height, px)
    }
  }
}

/**
 * The luma (Y) plane of a camera frame in SENSOR orientation, seen upright:
 * `rotation` (0, 90, 180, 270) is the clockwise turn that makes the sensor
 * image upright (CameraX ImageInfo.rotationDegrees). Analysis works in the
 * upright, top-left-origin space of the preview and the photo, while the
 * pixels stay where the camera put them (no copy of the full frame).
 */
class YPlane(
  private val buffer: ByteBuffer,
  private val rowStride: Int,
  private val pixelStride: Int,
  /** Sensor-orientation size. */
  val sensorWidth: Int,
  val sensorHeight: Int,
  val rotation: Int,
) : LumaSource {
  private val turned = rotation == 90 || rotation == 270
  val uprightWidth get() = if (turned) sensorHeight else sensorWidth
  val uprightHeight get() = if (turned) sensorWidth else sensorHeight

  /** Upright normalised point -> sensor normalised point. */
  fun toSensor(u: Double, v: Double): Pt = when (rotation) {
    90 -> Pt(v, 1 - u)
    180 -> Pt(1 - u, 1 - v)
    270 -> Pt(1 - v, u)
    else -> Pt(u, v)
  }

  private fun raw(x: Int, y: Int): Int = buffer.get(y * rowStride + x * pixelStride).toInt() and 0xFF

  /** Upright full-resolution pixel -> the sensor pixel it shows. */
  private fun rawUpright(ux: Int, uy: Int): Int = when (rotation) {
    90 -> raw(uy, sensorHeight - 1 - ux)
    180 -> raw(sensorWidth - 1 - ux, sensorHeight - 1 - uy)
    270 -> raw(sensorWidth - 1 - uy, ux)
    else -> raw(ux, uy)
  }

  override fun luma(x: Double, y: Double): Float {
    val ux = min(uprightWidth - 1, max(0, (x * uprightWidth).toInt()))
    val uy = min(uprightHeight - 1, max(0, (y * uprightHeight).toInt()))
    return rawUpright(ux, uy).toFloat()
  }

  /** An upright, box-filtered grey copy with the long edge at most `longEdge`. */
  fun uprightGray(longEdge: Int): GrayImage {
    val uw = uprightWidth
    val uh = uprightHeight
    val s = min(1.0, longEdge.toDouble() / max(uw, uh))
    val w = max(1, (uw * s).roundToInt())
    val h = max(1, (uh * s).roundToInt())
    val out = ByteArray(w * h)
    // Each output pixel averages up to 2 x 2 samples spread over its box.
    val fx = uw.toDouble() / w
    val fy = uh.toDouble() / h
    val taps = min(2, max(1, fx.toInt()))
    for (oy in 0 until h) {
      for (ox in 0 until w) {
        var sum = 0
        for (j in 0 until taps) {
          val uy = min(uh - 1, ((oy + (j + 0.5) / taps) * fy).toInt())
          for (i in 0 until taps) {
            val ux = min(uw - 1, ((ox + (i + 0.5) / taps) * fx).toInt())
            sum += rawUpright(ux, uy)
          }
        }
        out[oy * w + ox] = (sum / (taps * taps)).toByte()
      }
    }
    return GrayImage(w, h, out)
  }

  /**
   * Variance of the Laplacian of luma inside the quad's bounding box, on a
   * sparse grid at full resolution (~30k samples): the port of
   * DocumentCameraView.sharpness. The Laplacian doesn't care about rotation,
   * so the box is taken in sensor space.
   */
  fun sharpness(quad: List<Pt>): Double {
    val pts = quad.map { toSensor(it.x, it.y) }
    val w = sensorWidth
    val h = sensorHeight
    val x0 = max(1, (pts.minOf { it.x } * w).toInt() + 2)
    val x1 = min(w - 2, (pts.maxOf { it.x } * w).toInt() - 2)
    val y0 = max(1, (pts.minOf { it.y } * h).toInt() + 2)
    val y1 = min(h - 2, (pts.maxOf { it.y } * h).toInt() - 2)
    if (x1 <= x0 + 8 || y1 <= y0 + 8) return 0.0
    val step = max(1, max(x1 - x0, y1 - y0) / 180)
    var sum = 0.0
    var sumSq = 0.0
    var n = 0.0
    var y = y0
    while (y <= y1) {
      var x = x0
      while (x <= x1) {
        val lap = (raw(x, y) * 4 - raw(x - 1, y) - raw(x + 1, y) - raw(x, y - 1) - raw(x, y + 1)).toDouble()
        sum += lap
        sumSq += lap * lap
        n += 1
        x += step
      }
      y += step
    }
    if (n <= 0) return 0.0
    val mean = sum / n
    return sumSq / n - mean * mean
  }
}

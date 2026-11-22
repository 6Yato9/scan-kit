package expo.modules.visionocr

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.util.Log
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Pure arithmetic of a memory-bounded decode (JVM-tested): the power-of-two
 * subsample, the horizontal strips a large image is decoded in, and the EXIF
 * orientation as an affine transform.
 */
object DecodePlan {
  /**
   * Above this many bytes (ARGB) a subsampled decode is done in strips, so a
   * 20–200 MP photo never sits in memory at its decoded size: only the
   * output (≤ 4096 px long edge, ~50 MB) and one ~8 MB strip do. A 12–16 MP
   * photo (every capture: DocumentCameraView asks for at most ~12 MP) is
   * still decoded in one go, which is faster.
   */
  const val STRIP_THRESHOLD_BYTES = 64L * 1024 * 1024
  const val STRIP_BYTES = 8L * 1024 * 1024

  /** Largest power of two that keeps the decoded long edge at or above `target` (the final step is then a downscale). */
  fun sample(long: Int, target: Int): Int {
    var sample = 1
    while (long / (sample * 2) >= target) sample *= 2
    return sample
  }

  /** ARGB bytes of a `w` × `h` image decoded at `sample`. */
  fun sampledBytes(w: Int, h: Int, sample: Int): Long =
    ceil(w.toDouble() / sample).toLong() * ceil(h.toDouble() / sample).toLong() * 4

  /** Rows (source pixels, multiples of `sample`) of each strip: [top, bottom) pairs covering 0..h. */
  fun strips(w: Int, h: Int, sample: Int, stripBytes: Long = STRIP_BYTES): List<IntArray> {
    val sampledWidth = ceil(w.toDouble() / sample).toLong()
    val sampledRows = max(16L, stripBytes / max(1L, sampledWidth * 4)).toInt()
    val step = sampledRows * sample
    val out = ArrayList<IntArray>()
    var top = 0
    while (top < h) {
      val bottom = min(h, top + step)
      out.add(intArrayOf(top, bottom))
      top = bottom
    }
    return out
  }

  /** Upright size of a `w` × `h` image with EXIF `orientation` (5..8 swap the sides). */
  fun uprightSize(w: Int, h: Int, orientation: Int): Pair<Int, Int> = if (orientation in 5..8) h to w else w to h

  /**
   * The affine map [a, b, c, d, e, f] (x' = a·x + b·y + c, y' = d·x + e·y + f)
   * from a `w` × `h` image as stored to its upright form under EXIF
   * `orientation` (1 = as stored, 6 = turn 90° clockwise, 8 = 90° counter-
   * clockwise, 3 = 180°, 2/4/5/7 mirrored).
   */
  fun orientation(o: Int, w: Float, h: Float): FloatArray = when (o) {
    2 -> floatArrayOf(-1f, 0f, w, 0f, 1f, 0f)
    3 -> floatArrayOf(-1f, 0f, w, 0f, -1f, h)
    4 -> floatArrayOf(1f, 0f, 0f, 0f, -1f, h)
    5 -> floatArrayOf(0f, 1f, 0f, 1f, 0f, 0f)
    6 -> floatArrayOf(0f, -1f, h, 1f, 0f, 0f)
    7 -> floatArrayOf(0f, -1f, h, -1f, 0f, w)
    8 -> floatArrayOf(0f, 1f, 0f, -1f, 0f, w)
    else -> floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f)
  }

  /** EXIF orientation of a camera frame that must be turned `degrees` clockwise. */
  fun orientationForRotation(degrees: Int): Int = when (((degrees % 360) + 360) % 360) {
    90 -> 6
    180 -> 3
    270 -> 8
    else -> 1
  }
}

/** An encoded image: a file, or bytes in memory (a camera JPEG). */
sealed class EncodedImage {
  abstract fun decode(opts: BitmapFactory.Options): Bitmap?
  abstract fun regionDecoder(): BitmapRegionDecoder?

  class Path(val path: String) : EncodedImage() {
    override fun decode(opts: BitmapFactory.Options): Bitmap? = BitmapFactory.decodeFile(path, opts)

    @Suppress("DEPRECATION")
    override fun regionDecoder(): BitmapRegionDecoder? =
      if (Build.VERSION.SDK_INT >= 31) BitmapRegionDecoder.newInstance(path) else BitmapRegionDecoder.newInstance(path, false)
  }

  class Bytes(val bytes: ByteArray) : EncodedImage() {
    override fun decode(opts: BitmapFactory.Options): Bitmap? = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)

    @Suppress("DEPRECATION")
    override fun regionDecoder(): BitmapRegionDecoder? =
      if (Build.VERSION.SDK_INT >= 31) BitmapRegionDecoder.newInstance(bytes, 0, bytes.size)
      else BitmapRegionDecoder.newInstance(bytes, 0, bytes.size, false)
  }
}

/**
 * Decodes images upright at a capped size without ever holding them at full
 * resolution. A subsampled decode (inSampleSize, the largest power of two
 * that still covers the target) is done in one go when it is small; a large
 * one (a 50 MP photo whose half size is just under 4096 px) is decoded in
 * horizontal strips (BitmapRegionDecoder) that are scaled and turned straight
 * into the output, so memory is the output plus one strip. Formats the region
 * decoder can't read fall back to the single decode, retried once at half
 * the size if memory runs out.
 */
object ImageDecode {
  private const val TAG = "ImageDecode"

  /**
   * `w` × `h` (as stored) → upright, long edge at most `maxLong` (never
   * upscaled). `failCode` is the rejection code callers want for an
   * unreadable or too large image.
   */
  fun decode(src: EncodedImage, w: Int, h: Int, orientation: Int, maxLong: Int, failCode: String = "ERR_IMAGE_READ"): Bitmap {
    if (w <= 0 || h <= 0) throw VisionFailure(failCode, "Could not decode image")
    val long = max(w, h)
    val target = max(1, min(maxLong, long))
    val (tw, th) = QuadMath.capped(w, h, target)
    val sample = DecodePlan.sample(long, target)
    if (DecodePlan.sampledBytes(w, h, sample) > DecodePlan.STRIP_THRESHOLD_BYTES) {
      try {
        val striped = inStrips(src, w, h, orientation, tw, th, sample)
        if (striped != null) return striped
      } catch (e: OutOfMemoryError) {
        Log.w(TAG, "strip decode ran out of memory")
      } catch (e: Exception) {
        Log.w(TAG, "strip decode failed: ${e.message}")
      }
    }
    return whole(src, w, h, orientation, tw, th, sample, failCode)
  }

  /** The affine map of the output: stored-image pixels scaled to tw × th, then turned upright. */
  private fun outputMatrix(orientation: Int, tw: Int, th: Int, sx: Float, sy: Float): Matrix {
    val o = DecodePlan.orientation(orientation, tw.toFloat(), th.toFloat())
    val m = Matrix()
    m.setScale(sx, sy)
    m.postConcat(Matrix().apply { setValues(floatArrayOf(o[0], o[1], o[2], o[3], o[4], o[5], 0f, 0f, 1f)) })
    return m
  }

  private fun inStrips(src: EncodedImage, w: Int, h: Int, orientation: Int, tw: Int, th: Int, sample: Int): Bitmap? {
    val decoder = try {
      src.regionDecoder()
    } catch (e: Exception) {
      null
    } ?: return null
    try {
      if (decoder.width != w || decoder.height != h) return null
      val (ow, oh) = DecodePlan.uprightSize(tw, th, orientation)
      val out = Bitmap.createBitmap(ow, oh, Bitmap.Config.ARGB_8888)
      try {
        val canvas = Canvas(out)
        val paint = Paint(Paint.FILTER_BITMAP_FLAG)
        val toOutput = outputMatrix(orientation, tw, th, tw.toFloat() / w, th.toFloat() / h)
        // A few rows of overlap so the filter sees real neighbours at the seams.
        val pad = 2 * sample
        val opts = BitmapFactory.Options().apply {
          inSampleSize = sample
          inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        for (strip in DecodePlan.strips(w, h, sample)) {
          val top = strip[0]
          val bottom = strip[1]
          val rTop = max(0, top - pad)
          val rBottom = min(h, bottom + pad)
          val part = decoder.decodeRegion(Rect(0, rTop, w, rBottom), opts) ?: return null.also { out.recycle() }
          try {
            canvas.save()
            // This strip's own rows, in output pixels (shared edges round alike: no gaps).
            val clip = RectF(0f, top.toFloat(), w.toFloat(), bottom.toFloat())
            toOutput.mapRect(clip)
            canvas.clipRect(clip)
            val m = Matrix()
            m.setScale(w.toFloat() / part.width, (rBottom - rTop).toFloat() / part.height)
            m.postTranslate(0f, rTop.toFloat())
            m.postConcat(toOutput)
            canvas.drawBitmap(part, m, paint)
            canvas.restore()
          } finally {
            part.recycle()
          }
        }
        return out
      } catch (e: Throwable) {
        out.recycle()
        throw e
      }
    } finally {
      decoder.recycle()
    }
  }

  private fun whole(src: EncodedImage, w: Int, h: Int, orientation: Int, tw: Int, th: Int, firstSample: Int, failCode: String): Bitmap {
    var sample = firstSample
    var decoded: Bitmap? = null
    for (attempt in 0..1) {
      val opts = BitmapFactory.Options().apply {
        inSampleSize = sample
        inPreferredConfig = Bitmap.Config.ARGB_8888
      }
      try {
        decoded = src.decode(opts) ?: throw VisionFailure(failCode, "Could not decode image")
        break
      } catch (e: OutOfMemoryError) {
        if (attempt == 1) throw VisionFailure(failCode, "The image is too large to open")
        sample *= 2
      }
    }
    val bmp = decoded ?: throw VisionFailure(failCode, "Could not decode image")
    // A second attempt at half size gives a smaller output (never upscaled).
    val (cw, ch) = if (sample == firstSample) tw to th else QuadMath.capped(w, h, max(bmp.width, bmp.height))
    if (orientation == 1 && bmp.width == cw && bmp.height == ch) return bmp
    val (ow, oh) = DecodePlan.uprightSize(cw, ch, orientation)
    return try {
      val out = Bitmap.createBitmap(ow, oh, Bitmap.Config.ARGB_8888)
      Canvas(out).drawBitmap(bmp, outputMatrix(orientation, cw, ch, cw.toFloat() / bmp.width, ch.toFloat() / bmp.height), Paint(Paint.FILTER_BITMAP_FLAG))
      out
    } catch (e: OutOfMemoryError) {
      throw VisionFailure(failCode, "The image is too large to open")
    } finally {
      bmp.recycle()
    }
  }
}

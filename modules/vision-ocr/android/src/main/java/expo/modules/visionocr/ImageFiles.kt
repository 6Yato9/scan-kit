package expo.modules.visionocr

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.net.Uri
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** A rejection with the exact code and message the JS side expects (same as iOS). */
class VisionFailure(val code: String, message: String) : Exception(message)

/**
 * File and image plumbing, the Android counterpart of DocumentGeometry.swift
 * (normalize, warp) and PdfEditor.replace. Images are never decoded at full
 * size when a smaller one will do (inSampleSize), so a 50 MP photo can't
 * exhaust the heap.
 */
object ImageFiles {
  // ── URIs ───────────────────────────────────────────────────────────────────

  /** File path of a file:// URI (percent escapes decoded, any ?v= query dropped), or the string itself for a plain path. */
  fun pathOf(uri: String): String {
    val clean = uri.substringBefore('?')
    if (clean.startsWith("file:", ignoreCase = true)) {
      return Uri.parse(clean).path ?: clean.removePrefix("file://")
    }
    return clean
  }

  /** file:///data/user/0/… — never File.toURI()'s single-slash "file:/data/…", which breaks JS path keys. */
  fun uriOf(file: File): String = Uri.fromFile(file).toString()

  // ── Writing ────────────────────────────────────────────────────────────────

  /** Writes through a temp file next to `dest` and one rename: `dest` is never partial. */
  fun writeAtomically(dest: File, write: (FileOutputStream) -> Unit) {
    dest.parentFile?.mkdirs()
    val tmp = File(dest.parentFile, ".${dest.name}.${UUID.randomUUID()}.tmp")
    try {
      FileOutputStream(tmp).use { out ->
        write(out)
        out.flush()
        out.fd.sync()
      }
      Os.rename(tmp.path, dest.path)
    } catch (e: Exception) {
      tmp.delete()
      throw e
    }
  }

  fun writeJpeg(bitmap: Bitmap, dest: File, quality: Double) {
    val q = (max(0.05, min(1.0, quality)) * 100).roundToInt()
    try {
      // No EXIF orientation is written: the pixels are already upright.
      writeAtomically(dest) { out ->
        if (!bitmap.compress(Bitmap.CompressFormat.JPEG, q, out)) throw VisionFailure("ERR_IMAGE_WRITE", "Could not encode JPEG")
      }
    } catch (e: VisionFailure) {
      throw e
    } catch (e: Exception) {
      throw VisionFailure("ERR_IMAGE_WRITE", e.message ?: "Could not write the image")
    }
  }

  /**
   * Moves `src` over `dest` in one rename(2): at every instant `dest` is the
   * old file or the new one, never missing or partial. Across volumes (EXDEV)
   * the file is copied next to `dest` as `.name.uuid.part` first.
   */
  fun replace(src: File, dest: File) {
    if (!src.exists()) throw VisionFailure("ERR_REPLACE_FILE", "Nothing to move")
    try {
      Os.rename(src.path, dest.path)
      return
    } catch (e: ErrnoException) {
      if (e.errno != OsConstants.EXDEV) throw VisionFailure("ERR_REPLACE_FILE", "Could not replace the file (${e.message})")
    }
    val part = File(dest.parentFile, ".${dest.name}.${UUID.randomUUID()}.part")
    try {
      writeAtomically(part) { out -> src.inputStream().use { it.copyTo(out) } }
      Os.rename(part.path, dest.path)
    } catch (e: Exception) {
      part.delete()
      throw VisionFailure("ERR_REPLACE_FILE", "Could not replace the file (${e.message})")
    }
    src.delete()
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  class Info(val width: Int, val height: Int, val orientation: Int, val mime: String?) {
    /** EXIF 5..8 swap width and height. */
    val turned get() = orientation in 5..8
    val uprightWidth get() = if (turned) height else width
    val uprightHeight get() = if (turned) width else height
  }

  fun info(path: String): Info {
    val file = File(path)
    if (!file.isFile) throw VisionFailure("ERR_IMAGE_READ", "Could not read image at $path")
    val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, opts)
    if (opts.outWidth <= 0 || opts.outHeight <= 0) throw VisionFailure("ERR_IMAGE_READ", "Could not read image at $path")
    val orientation = try {
      ExifInterface(path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    } catch (_: Exception) {
      ExifInterface.ORIENTATION_NORMAL
    }
    return Info(opts.outWidth, opts.outHeight, if (orientation in 1..8) orientation else 1, opts.outMimeType)
  }

  /**
   * The image upright (EXIF applied) with its long edge capped at `maxLong`
   * (never upscaled). Decodes subsampled by a power of two first, then one
   * filtered scale + orientation transform.
   */
  fun decodeUpright(path: String, maxLong: Int, info: Info = info(path)): Bitmap {
    val long = max(info.width, info.height)
    val target = max(1, min(maxLong, long))
    var sample = 1
    while (long / (sample * 2) >= target) sample *= 2
    val opts = BitmapFactory.Options().apply {
      inSampleSize = sample
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val decoded = try {
      BitmapFactory.decodeFile(path, opts)
    } catch (e: OutOfMemoryError) {
      throw VisionFailure("ERR_IMAGE_READ", "The image is too large to open")
    } ?: throw VisionFailure("ERR_IMAGE_READ", "Could not decode image")

    val (tw, th) = QuadMath.capped(info.width, info.height, target)
    val sx = tw.toFloat() / decoded.width
    val sy = th.toFloat() / decoded.height
    val m = Matrix()
    m.setScale(sx, sy)
    when (info.orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> { m.postRotate(180f); m.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(-90f); m.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(-90f)
    }
    if (m.isIdentity) return decoded
    val out = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, m, true)
    if (out !== decoded) decoded.recycle()
    return out
  }

  // ── normalizeImage ─────────────────────────────────────────────────────────

  /**
   * Bakes EXIF orientation into the pixels and caps the long edge. A JPEG
   * that is already upright, within the cap and not wastefully large is
   * copied byte for byte (no second generation of JPEG loss), exactly as
   * DocumentGeometry.normalize does.
   */
  fun normalize(srcPath: String, out: File, maxEdge: Int, quality: Double): Pair<Int, Int> {
    val info = info(srcPath)
    val src = File(srcPath)
    val reusable = info.mime == "image/jpeg" && info.orientation == 1 &&
      max(info.width, info.height) <= maxEdge &&
      src.length().toDouble() <= info.width.toDouble() * info.height * 0.6
    if (reusable) {
      try {
        writeAtomically(out) { o -> src.inputStream().use { it.copyTo(o) } }
        return info.width to info.height
      } catch (_: Exception) {
        // Fall through to a re-encode.
      }
    }
    val bmp = decodeUpright(srcPath, max(1, maxEdge), info)
    try {
      writeJpeg(bmp, out, quality)
      return bmp.width to bmp.height
    } finally {
      bmp.recycle()
    }
  }

  // ── warpQuad ───────────────────────────────────────────────────────────────

  /**
   * Perspective-corrects `quad` of the upright source into an upright JPEG
   * with the long edge capped at `maxEdge`. An upright axis-aligned quad is a
   * plain crop (pixel-exact); a cyclic shift of the corners turns the page
   * 90 degrees per step (corner 0 always lands top-left).
   */
  fun warp(srcPath: String, quad: List<QuadMath.Pt>, out: File, quality: Double, maxEdge: Int): Pair<Int, Int> {
    val info = info(srcPath)
    val fullW = info.uprightWidth.toDouble()
    val fullH = info.uprightHeight.toDouble()
    // Decode just enough pixels for the capped output (+25% for the final
    // downscale), never the whole 48 MP when 4 MP will do.
    val (fw, fh) = QuadMath.outputSize(quad, fullW, fullH)
    val cap = max(1, maxEdge)
    val scale = min(1.0, cap * 1.25 / max(max(fw, fh), 1.0))
    val decodeLong = ceil(max(fullW, fullH) * scale).toInt()
    val src = decodeUpright(srcPath, decodeLong, info)
    var page: Bitmap? = null
    try {
      val w = src.width.toDouble()
      val h = src.height.toDouble()
      val px = quad.map { QuadMath.Pt(it.x * w, it.y * h) }
      val crop = QuadMath.axisAlignedCrop(px, src.width, src.height)
      page = if (crop != null) {
        val cw = crop[2] - crop[0]
        val ch = crop[3] - crop[1]
        if (cw < 1 || ch < 1) throw VisionFailure("ERR_BAD_QUAD", "Quad is empty")
        Bitmap.createBitmap(src, crop[0], crop[1], cw, ch)
      } else {
        val (ow, oh) = QuadMath.outputSize(px, 1.0, 1.0)
        val outW = max(1, ow.roundToInt())
        val outH = max(1, oh.roundToInt())
        val dst = try {
          Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888)
        } catch (e: OutOfMemoryError) {
          throw VisionFailure("ERR_WARP", "The corrected page is too large")
        }
        val m = Matrix()
        val from = floatArrayOf(
          px[0].x.toFloat(), px[0].y.toFloat(), px[1].x.toFloat(), px[1].y.toFloat(),
          px[2].x.toFloat(), px[2].y.toFloat(), px[3].x.toFloat(), px[3].y.toFloat(),
        )
        val to = floatArrayOf(0f, 0f, outW.toFloat(), 0f, outW.toFloat(), outH.toFloat(), 0f, outH.toFloat())
        if (!m.setPolyToPoly(from, 0, to, 0, 4)) {
          dst.recycle()
          throw VisionFailure("ERR_WARP", "Perspective correction failed")
        }
        Canvas(dst).drawBitmap(src, m, Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
        dst
      }
      val long = max(page.width, page.height)
      if (long > cap) {
        val (tw, th) = QuadMath.capped(page.width, page.height, cap)
        val scaled = Bitmap.createScaledBitmap(page, tw, th, true)
        if (scaled !== page) page.recycle()
        page = scaled
      }
      writeJpeg(page, out, quality)
      return page.width to page.height
    } finally {
      if (page != null && page !== src) page.recycle()
      src.recycle()
    }
  }
}

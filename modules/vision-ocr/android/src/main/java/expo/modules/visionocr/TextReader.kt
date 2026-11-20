package expo.modules.visionocr

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.LocaleList
import android.util.Log
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.nl.languageid.LanguageIdentification
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import com.googlecode.tesseract.android.TessBaseAPI
import java.io.File
import kotlin.math.max

/**
 * `recognize` on Android: on-device text recognition with two bundled
 * engines (no Play Services, no network).
 *
 *  1. Google ML Kit, Latin model bundled in the APK (com.google.mlkit:
 *     text-recognition), reads every page: fast and accurate for Latin script.
 *  2. Tesseract 5 (Tesseract4Android) with tessdata_fast `ara` reads the page
 *     only when ML Kit's result suggests script it couldn't read
 *     (OcrLayout.suspectsArabic): glyph-sized ink outside every line ML Kit
 *     returned (it skips unknown script rather than misreading it), or a
 *     large share of misread-looking lines. A page ML Kit read completely
 *     never pays for the second pass. Arabic as a device language lowers the
 *     bar. The lines ML Kit read are painted white first, so Latin print
 *     can't confuse the Arabic model.
 *  3. OcrLayout.merge keeps Tesseract's confident Arabic lines and ML Kit's
 *     lines (ML Kit wins wherever it read a clean line); OcrLayout.readingOrder
 *     orders them like iOS (right to left in an Arabic row).
 *
 * Line boxes are in pixels of the UPRIGHT image at its full size, like iOS.
 * Called off the main thread; Tesseract is not thread-safe, so its use is
 * serialised.
 */
class TextReader(private val context: Context) {
  private val latin by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }
  private val languageId by lazy { LanguageIdentification.getClient() }
  private val tessLock = Any()
  private var tess: TessBaseAPI? = null
  private var tessFailed = false

  fun recognize(path: String): Map<String, Any> {
    val info = ImageFiles.info(path)
    // ML Kit reads text from ~16 px tall; 3200 px keeps small print readable
    // on a full page without decoding a 48 MP photo whole.
    val bitmap = ImageFiles.decodeUpright(path, MAX_DECODE, info)
    try {
      val scale = info.uprightWidth.toDouble() / bitmap.width
      val latinLines = readLatin(bitmap)
      var lines = latinLines
      val ink = inkOf(bitmap, latinLines)
      if (OcrLayout.suspectsArabic(latinLines, ink, arabicPreferred())) {
        val arabic = readArabic(bitmap, latinLines.filterNot { OcrLayout.looksMisread(it) })
        lines = OcrLayout.merge(latinLines, arabic)
        if (BuildConfig.DEBUG) {
          Log.d(TAG, "recognize: latin=${latinLines.size} ink=$ink arabic=${arabic.size} kept=${lines.size}")
          arabic.forEach { Log.d(TAG, "  ara ${"%.2f".format(it.confidence)} ${it.text}") }
        }
      } else if (BuildConfig.DEBUG) {
        Log.d(TAG, "recognize: latin only (${latinLines.size} lines, ink=$ink)")
      }
      val (ordered, text) = OcrLayout.readingOrder(lines)
      return mapOf(
        "text" to text,
        "lines" to ordered.map {
          mapOf(
            "text" to it.text.trim(),
            "left" to it.left * scale,
            "top" to it.top * scale,
            "width" to it.width * scale,
            "height" to it.height * scale,
          )
        },
      )
    } finally {
      bitmap.recycle()
    }
  }

  /** Ink inside / outside ML Kit's lines on a ~480 px grey copy (OcrLayout.ink). */
  private fun inkOf(bitmap: Bitmap, latin: List<OcrLayout.Line>): OcrLayout.Ink? = try {
    val f = INK_LONG.toDouble() / max(bitmap.width, bitmap.height)
    val w = max(1, (bitmap.width * f).toInt())
    val h = max(1, (bitmap.height * f).toInt())
    val small = Bitmap.createScaledBitmap(bitmap, w, h, true)
    val px = IntArray(w * h)
    small.getPixels(px, 0, w, 0, 0, w, h)
    if (small !== bitmap) small.recycle()
    val gray = IntArray(w * h) { i ->
      val c = px[i]
      (((c shr 16) and 0xFF) * 299 + ((c shr 8) and 0xFF) * 587 + (c and 0xFF) * 114) / 1000
    }
    val boxes = latin.map { it.copy(left = it.left * f, top = it.top * f, width = it.width * f, height = it.height * f) }
    OcrLayout.ink(gray, w, h, boxes)
  } catch (e: Exception) {
    null
  }

  private fun readLatin(bitmap: Bitmap): List<OcrLayout.Line> {
    val result = Tasks.await(latin.process(InputImage.fromBitmap(bitmap, 0)))
    val out = mutableListOf<OcrLayout.Line>()
    for (block in result.textBlocks) {
      for (line in block.lines) {
        val box = line.boundingBox ?: continue
        out.add(
          OcrLayout.Line(
            text = line.text,
            left = box.left.toDouble(),
            top = box.top.toDouble(),
            width = box.width().toDouble(),
            height = box.height().toDouble(),
            confidence = line.confidence.toDouble(),
            engine = OcrLayout.Engine.LATIN,
          ),
        )
      }
    }
    return out
  }

  /** Tesseract `ara` lines (empty when the engine can't start). */
  /**
   * Tesseract `ara` lines (empty when the engine can't start). The lines ML
   * Kit read cleanly are painted out first: Latin print only confuses the
   * Arabic model (it is read as Arabic-looking letters and drags Arabic
   * lines next to it into one mixed line).
   */
  private fun readArabic(bitmap: Bitmap, read: List<OcrLayout.Line>): List<OcrLayout.Line> {
    synchronized(tessLock) { return readArabicLocked(bitmap, read) }
  }

  private fun readArabicLocked(bitmap: Bitmap, read: List<OcrLayout.Line>): List<OcrLayout.Line> {
    val api = tesseract() ?: return emptyList()
    // Tesseract's LSTM reads ~20-40 px text best: an A4 page at 1800 px is
    // about 150 dpi (body text ~30 px). Measured on the test pages, 1800
    // found every line where 2400 dropped some headings; and it is faster.
    val long = max(bitmap.width, bitmap.height)
    val f = if (long > TESS_MAX) TESS_MAX.toDouble() / long else 1.0
    val input = Bitmap.createBitmap(
      (bitmap.width * f).toInt().coerceAtLeast(1),
      (bitmap.height * f).toInt().coerceAtLeast(1),
      Bitmap.Config.ARGB_8888,
    )
    Canvas(input).apply {
      scale(f.toFloat(), f.toFloat())
      drawBitmap(bitmap, 0f, 0f, Paint(Paint.FILTER_BITMAP_FLAG))
      val white = Paint().apply { color = Color.WHITE }
      for (l in read) {
        val pad = l.height * 0.15
        drawRect((l.left - pad).toFloat(), (l.top - pad).toFloat(), (l.right + pad).toFloat(), (l.bottom + pad).toFloat(), white)
      }
    }
    val out = mutableListOf<OcrLayout.Line>()
    try {
      api.setImage(input)
      api.getUTF8Text() // runs recognition
      val it = api.resultIterator ?: return out
      try {
        it.begin()
        do {
          val text = it.getUTF8Text(TessBaseAPI.PageIteratorLevel.RIL_TEXTLINE) ?: continue
          val r = it.getBoundingRect(TessBaseAPI.PageIteratorLevel.RIL_TEXTLINE) ?: continue
          val conf = it.confidence(TessBaseAPI.PageIteratorLevel.RIL_TEXTLINE).toDouble() / 100.0
          out.add(
            OcrLayout.Line(
              // Tesseract marks direction runs with invisible bidi controls
              // (U+200E/U+200F…); they would only get in the way of search.
              text = text.replace(BIDI_CONTROLS, "").trim(),
              left = r.left / f,
              top = r.top / f,
              width = r.width() / f,
              height = r.height() / f,
              confidence = conf,
              engine = OcrLayout.Engine.ARABIC,
            ),
          )
        } while (it.next(TessBaseAPI.PageIteratorLevel.RIL_TEXTLINE))
      } finally {
        it.delete()
      }
    } catch (e: Exception) {
      Log.w(TAG, "Tesseract failed: ${e.message}")
    } finally {
      api.clear()
      input.recycle()
    }
    return out
  }

  private fun tesseract(): TessBaseAPI? {
    tess?.let { return it }
    if (tessFailed) return null
    return try {
      val root = tessDataRoot()
      val api = TessBaseAPI()
      if (!api.init(root.path, "ara", TessBaseAPI.OEM_LSTM_ONLY)) {
        api.recycle()
        tessFailed = true
        Log.w(TAG, "Tesseract init failed")
        null
      } else {
        api.pageSegMode = TessBaseAPI.PageSegMode.PSM_AUTO
        tess = api
        api
      }
    } catch (e: Throwable) {
      tessFailed = true
      Log.w(TAG, "Tesseract unavailable: ${e.message}")
      null
    }
  }

  /**
   * Tesseract reads its model from a file: the bundled asset is copied once
   * into no-backup app storage (<root>/tessdata/ara.traineddata), and again
   * whenever MODEL_ID changes.
   */
  private fun tessDataRoot(): File {
    val root = File(context.noBackupFilesDir, "visionocr")
    val dir = File(root, "tessdata")
    val model = File(dir, "ara.traineddata")
    val marker = File(dir, "ara.version")
    val current = try { marker.readText() } catch (_: Exception) { "" }
    if (!model.isFile || current != MODEL_ID) {
      dir.mkdirs()
      ImageFiles.writeAtomically(model) { out -> context.assets.open("tessdata/ara.traineddata").use { it.copyTo(out) } }
      ImageFiles.writeAtomically(marker) { out -> out.write(MODEL_ID.toByteArray()) }
    }
    return root
  }

  private fun arabicPreferred(): Boolean {
    val locales = LocaleList.getDefault()
    for (i in 0 until locales.size()) {
      if (locales[i].language == "ar") return true
    }
    return false
  }

  /** BCP-47 code of the text's dominant language, or null (ML Kit language ID, bundled model). */
  fun dominantLanguage(text: String): String? {
    val sample = text.take(4000)
    if (sample.isBlank()) return null
    val code = Tasks.await(languageId.identifyLanguage(sample))
    return if (code == null || code == "und") null else code
  }

  fun close() {
    synchronized(tessLock) {
      tess?.recycle()
      tess = null
    }
    try { latin.close() } catch (_: Exception) {}
    try { languageId.close() } catch (_: Exception) {}
  }

  companion object {
    private const val TAG = "VisionOcr"
    private const val MAX_DECODE = 3200
    private const val TESS_MAX = 1800
    /** Change when assets/tessdata/ara.traineddata changes, so installed copies are replaced. */
    private const val MODEL_ID = "tessdata_fast/ara e3206d3d"
    private const val INK_LONG = 480
    private val BIDI_CONTROLS = Regex("[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]")
  }
}

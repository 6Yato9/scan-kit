package expo.modules.visionocr

import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage

/**
 * QR codes and barcodes in an image file (TextActions.detectBarcodes on iOS),
 * read with ML Kit's barcode scanner, the BUNDLED model
 * (com.google.mlkit:barcode-scanning, the artifact expo-camera already ships
 * for the QR tool's live scanner: no second copy, nothing downloaded, no Play
 * Services). Same result shape as iOS: { symbology, payload, left, top,
 * width, height }, the box normalised 0..1 in the upright image, top to
 * bottom, one entry per (symbology, payload).
 */
object Barcodes {
  /** Long edge the image is read at (iOS reads at 3000 px too). */
  private const val MAX_EDGE = 3000

  fun detect(path: String): List<Map<String, Any>> {
    val bitmap = try {
      ImageFiles.decodeUpright(path, MAX_EDGE)
    } catch (e: VisionFailure) {
      throw VisionFailure("ERR_BARCODES", "Could not read the image")
    }
    val scanner = BarcodeScanning.getClient(
      BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_ALL_FORMATS).build(),
    )
    try {
      val found = Tasks.await(scanner.process(InputImage.fromBitmap(bitmap, 0)))
      val w = bitmap.width.toDouble()
      val h = bitmap.height.toDouble()
      val codes = found.mapNotNull { b ->
        val payload = b.rawValue ?: b.displayValue
        val box = b.boundingBox
        if (payload.isNullOrEmpty() || box == null) {
          null
        } else {
          Code(symbologyName(b.format), payload, box.left / w, box.top / h, box.width() / w, box.height() / h)
        }
      }
      return tidy(codes).map { it.toMap() }
    } finally {
      scanner.close()
      bitmap.recycle()
    }
  }

  data class Code(
    val symbology: String,
    val payload: String,
    val left: Double,
    val top: Double,
    val width: Double,
    val height: Double,
  ) {
    fun toMap(): Map<String, Any> = mapOf(
      "symbology" to symbology,
      "payload" to payload,
      "left" to left,
      "top" to top,
      "width" to width,
      "height" to height,
    )
  }

  /** Top to bottom, clamped to the image, one per (symbology, payload). */
  fun tidy(codes: List<Code>): List<Code> {
    val seen = HashSet<String>()
    return codes
      .map { c ->
        val l = c.left.coerceIn(0.0, 1.0)
        val t = c.top.coerceIn(0.0, 1.0)
        c.copy(left = l, top = t, width = c.width.coerceIn(0.0, 1.0 - l), height = c.height.coerceIn(0.0, 1.0 - t))
      }
      .sortedBy { it.top }
      .filter { seen.add(it.symbology + "\u0001" + it.payload) }
  }

  /**
   * The names iOS (and expo-camera's live scanner) use, so the QR tool and the
   * page chips label them the same way (lib/text-actions barcodeTypeLabel).
   */
  fun symbologyName(format: Int): String = when (format) {
    Barcode.FORMAT_QR_CODE -> "qr"
    Barcode.FORMAT_AZTEC -> "aztec"
    Barcode.FORMAT_PDF417 -> "pdf417"
    Barcode.FORMAT_DATA_MATRIX -> "datamatrix"
    Barcode.FORMAT_EAN_13 -> "ean13"
    Barcode.FORMAT_EAN_8 -> "ean8"
    Barcode.FORMAT_UPC_A -> "upc_a"
    Barcode.FORMAT_UPC_E -> "upc_e"
    Barcode.FORMAT_CODE_128 -> "code128"
    Barcode.FORMAT_CODE_39 -> "code39"
    Barcode.FORMAT_CODE_93 -> "code93"
    Barcode.FORMAT_ITF -> "itf"
    Barcode.FORMAT_CODABAR -> "codabar"
    else -> "barcode"
  }
}

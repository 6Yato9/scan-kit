package expo.modules.visionocr

import expo.modules.visionocr.QuadMath.Pt

/** Page detection on image files (DocumentGeometry.detectQuad on iOS). */
object PageScan {
  /**
   * Page outline of the photo at `path` (upright, EXIF applied), inset like
   * iOS, or null when not confident. The detector works at 640 px (sub-pixel
   * edges), so 1024 px is decoded, subsampled, never the full photo.
   */
  fun detectQuad(path: String, minArea: Double): List<Pt>? {
    val bmp = ImageFiles.decodeUpright(path, 1024)
    val gray = try {
      ImageFiles.gray(bmp, 1024)
    } finally {
      bmp.recycle()
    }
    return PageDetector.detect(gray, minArea)?.let { PageGeometry.inset(it) }
  }
}

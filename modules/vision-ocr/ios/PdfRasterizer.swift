import PDFKit
import UIKit

/// Renders every page of a PDF to a JPEG on a white background, so an imported
/// PDF can become ordinary scan pages (filters, sign, watermark, OCR, crop).
enum PdfRasterizer {
  /// Returns the written file paths in page order.
  static func render(inputPath: String, outputDir: String, maxEdge: CGFloat, quality: CGFloat) throws -> [String] {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: inputPath)) else {
      throw NSError(domain: "PdfRasterizer", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Could not open the PDF"])
    }
    if doc.isLocked {
      throw NSError(domain: "PdfRasterizer", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "This PDF is password protected"])
    }
    try FileManager.default.createDirectory(atPath: outputDir, withIntermediateDirectories: true)
    var out: [String] = []
    for i in 0..<doc.pageCount {
      guard let page = doc.page(at: i) else { continue }
      try autoreleasepool {
        let box = page.bounds(for: .cropBox)
        // Respect the page's /Rotate so landscape pages come out upright.
        let rotated = page.rotation % 180 != 0
        let w = rotated ? box.height : box.width
        let h = rotated ? box.width : box.height
        // Target ~200 dpi, capped at maxEdge on the long side.
        let scale = min(200.0 / 72.0, maxEdge / max(w, h))
        let size = CGSize(width: (w * scale).rounded(), height: (h * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
          UIColor.white.setFill()
          ctx.fill(CGRect(origin: .zero, size: size))
          let cg = ctx.cgContext
          cg.saveGState()
          // PDF space is bottom-left origin; flip, then let PDFKit apply rotation.
          cg.translateBy(x: 0, y: size.height)
          cg.scaleBy(x: scale, y: -scale)
          page.draw(with: .cropBox, to: cg)
          cg.restoreGState()
        }
        guard let data = image.jpegData(compressionQuality: quality) else {
          throw NSError(domain: "PdfRasterizer", code: 3,
                        userInfo: [NSLocalizedDescriptionKey: "Could not encode page \(i + 1)"])
        }
        let path = (outputDir as NSString).appendingPathComponent(String(format: "pdfpage-%03d.jpg", i))
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        out.append(path)
      }
    }
    if out.isEmpty {
      throw NSError(domain: "PdfRasterizer", code: 4,
                    userInfo: [NSLocalizedDescriptionKey: "The PDF has no pages"])
    }
    return out
  }
}

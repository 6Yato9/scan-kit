import Foundation
import PDFKit

/// Concatenates PDFs in order into one file. Pages are moved as-is, so each
/// keeps its own size and its text layer (searchable PDFs stay searchable).
/// A PDF whose permissions don't allow assembling its pages into another
/// document is refused ("restricted", as PdfEditor) rather than copied out of
/// its protection.
enum PdfMerger {
  static func merge(inputPaths: [String], outputPath: String) throws {
    guard !inputPaths.isEmpty else {
      throw NSError(domain: "PdfMerger", code: 1, userInfo: [NSLocalizedDescriptionKey: "Nothing to merge"])
    }
    let out = PDFDocument()
    for path in inputPaths {
      guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
        throw NSError(domain: "PdfMerger", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "Could not open a part of the PDF"])
      }
      if doc.isEncrypted && !doc.isLocked && !doc.allowsDocumentAssembly {
        throw NSError(domain: "PdfMerger", code: 4,
                      userInfo: [NSLocalizedDescriptionKey: PdfEditor.restrictedMessage])
      }
      for i in 0..<doc.pageCount {
        if let page = doc.page(at: i) { out.insert(page, at: out.pageCount) }
      }
    }
    let url = URL(fileURLWithPath: outputPath)
    try? FileManager.default.removeItem(at: url)
    guard out.write(to: url) else {
      throw NSError(domain: "PdfMerger", code: 3, userInfo: [NSLocalizedDescriptionKey: "Could not write the PDF"])
    }
  }
}

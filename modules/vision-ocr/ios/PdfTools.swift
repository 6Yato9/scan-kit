import Foundation
import PDFKit

/// Text and password helpers for imported PDFs.
enum PdfTools {
  /// Embedded text per page (empty string for scanned/image-only pages).
  /// Throws "locked" if the PDF needs a password that wasn't given or is wrong.
  static func pageTexts(path: String, password: String?) throws -> [String] {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
      throw NSError(domain: "PdfTools", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not open the PDF"])
    }
    if doc.isLocked {
      guard let pw = password, doc.unlock(withPassword: pw) else {
        throw NSError(domain: "PdfTools", code: 2, userInfo: [NSLocalizedDescriptionKey: "locked"])
      }
    }
    var out: [String] = []
    for i in 0..<doc.pageCount { out.append(doc.page(at: i)?.string ?? "") }
    return out
  }

  /// Writes an unencrypted copy of a password-protected PDF.
  /// Throws "wrong-password" when the password doesn't unlock it.
  static func unlock(inputPath: String, outputPath: String, password: String) throws {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: inputPath)) else {
      throw NSError(domain: "PdfTools", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not open the PDF"])
    }
    if doc.isLocked && !doc.unlock(withPassword: password) {
      throw NSError(domain: "PdfTools", code: 3, userInfo: [NSLocalizedDescriptionKey: "wrong-password"])
    }
    // Rebuild into a fresh document so no encryption dictionary carries over,
    // keeping metadata and the outline (bookmarks).
    let out = PDFDocument()
    for i in 0..<doc.pageCount {
      guard let p = doc.page(at: i) else {
        throw NSError(domain: "PdfTools", code: 5,
                      userInfo: [NSLocalizedDescriptionKey: "Could not read page \(i + 1)"])
      }
      out.insert(p, at: out.pageCount)
    }
    if let attrs = doc.documentAttributes { out.documentAttributes = attrs }
    if let outline = doc.outlineRoot { out.outlineRoot = outline }
    let url = URL(fileURLWithPath: outputPath)
    try? FileManager.default.removeItem(at: url)
    // The caller deletes the protected original after this returns, so the
    // copy must be complete: unlocked AND every page present.
    guard out.write(to: url), let check = PDFDocument(url: url), !check.isLocked,
          check.pageCount == doc.pageCount else {
      try? FileManager.default.removeItem(at: url)
      throw NSError(domain: "PdfTools", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not write the unlocked PDF"])
    }
  }
}

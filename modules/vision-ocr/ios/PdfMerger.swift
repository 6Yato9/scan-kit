import Foundation
import PDFKit

/// Concatenates PDFs in order into one file. Pages are moved as-is, so each
/// keeps its own size and its text layer (searchable PDFs stay searchable).
/// A PDF whose permissions don't allow assembling its pages into another
/// document is refused ("restricted", as PdfEditor) rather than copied out of
/// its protection. One that allows it (an owner password with permissions)
/// passes its restrictions on: the merged file is encrypted with the
/// permissions every such part allows (round 13b; before, it came out
/// unprotected), read back and refused if any came out wider.
enum PdfMerger {
  static func merge(inputPaths: [String], outputPath: String) throws {
    guard !inputPaths.isEmpty else {
      throw NSError(domain: "PdfMerger", code: 1, userInfo: [NSLocalizedDescriptionKey: "Nothing to merge"])
    }
    let out = PDFDocument()
    // The permissions all protected parts allow (PDFKit's raw bits).
    var shared: UInt?
    var sources: [PDFDocument] = []
    for path in inputPaths {
      guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
        throw NSError(domain: "PdfMerger", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "Could not open a part of the PDF"])
      }
      if doc.isEncrypted && !doc.isLocked && !doc.allowsDocumentAssembly {
        throw NSError(domain: "PdfMerger", code: 4,
                      userInfo: [NSLocalizedDescriptionKey: PdfEditor.restrictedMessage])
      }
      if doc.isEncrypted && !doc.isLocked {
        shared = (shared ?? doc.accessPermissions.rawValue) & doc.accessPermissions.rawValue
        sources.append(doc)
      }
      for i in 0..<doc.pageCount {
        if let page = doc.page(at: i) { out.insert(page, at: out.pageCount) }
      }
    }
    let url = URL(fileURLWithPath: outputPath)
    try? FileManager.default.removeItem(at: url)
    let options = shared.map { PdfEditor.protectionOptions(permissions: $0) } ?? [:]
    guard out.write(to: url, withOptions: options) else {
      throw NSError(domain: "PdfMerger", code: 3, userInfo: [NSLocalizedDescriptionKey: "Could not write the PDF"])
    }
    if !sources.isEmpty {
      // Never looser than any protected part.
      let check = PDFDocument(url: url)
      let widened = check.flatMap { c in sources.lazy.compactMap { PdfStructure.widenedPermissions(source: $0, written: c) }.first }
      if check == nil || check?.isLocked == true || widened != nil {
        NSLog("PdfMerger: refused (%@)", widened ?? "unreadable")
        try? FileManager.default.removeItem(at: url)
        throw NSError(domain: "PdfMerger", code: 5, userInfo: [NSLocalizedDescriptionKey: "The merged PDF could not be verified"])
      }
    }
  }
}

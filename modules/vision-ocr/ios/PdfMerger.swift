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
///
/// Form fields are never linked across parts (round 15, the same on
/// Android): two forms that both have a field "name" would otherwise come out
/// as two widgets of one field, so filling one fills the other. A later part's
/// top-level field whose name is already taken is renamed to the first free
/// "<name>_2", "<name>_3"…, checked against every top-level name already in
/// the result and in that part (parts in order, then fields in page and
/// annotation order). Widgets of one field within a part stay one field.
enum PdfMerger {
  static func merge(inputPaths: [String], outputPath: String) throws {
    guard !inputPaths.isEmpty else {
      throw NSError(domain: "PdfMerger", code: 1, userInfo: [NSLocalizedDescriptionKey: "Nothing to merge"])
    }
    let out = PDFDocument()
    // The permissions all protected parts allow (PDFKit's raw bits).
    var shared: UInt?
    var sources: [PDFDocument] = []
    // Top-level field names already in the merged document.
    var usedNames = Set<String>()
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
      renameClashingFields(doc, used: &usedNames)
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

  /// The widgets of `doc`, in page and annotation order.
  static func widgets(_ doc: PDFDocument) -> [PDFAnnotation] {
    var out: [PDFAnnotation] = []
    for i in 0..<doc.pageCount {
      guard let page = doc.page(at: i) else { continue }
      for a in page.annotations where a.type == "Widget" {
        if let name = a.fieldName, !name.isEmpty { out.append(a) }
      }
    }
    return out
  }

  /// Renames `doc`'s top-level fields whose names are in `used` (see the
  /// header) and adds its top-level names to `used`.
  static func renameClashingFields(_ doc: PDFDocument, used: inout Set<String>) {
    let list = widgets(doc)
    var order: [String] = []
    for a in list {
      let top = topLevelName(a.fieldName ?? "")
      if !order.contains(top) { order.append(top) }
    }
    let renames = fieldRenames(order, used: used)
    used.formUnion(order.map { renames[$0] ?? $0 })
    guard !renames.isEmpty else { return }
    for a in list {
      guard let name = a.fieldName else { continue }
      let top = topLevelName(name)
      if let to = renames[top] { a.fieldName = to + name.dropFirst(top.count) }
    }
  }

  /// "a.b.c" -> "a".
  static func topLevelName(_ name: String) -> String {
    String(name.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
  }

  /// New names for the `names` (one part's top-level names, in order) that
  /// clash with `used`: the first free "<name>_k", k = 2, 3…, free of `used`,
  /// of the part's own names and of the names already given.
  static func fieldRenames(_ names: [String], used: Set<String>) -> [String: String] {
    var taken = used.union(names)
    var out: [String: String] = [:]
    for name in names where used.contains(name) {
      var k = 2
      while taken.contains("\(name)_\(k)") { k += 1 }
      let to = "\(name)_\(k)"
      out[name] = to
      taken.insert(to)
    }
    return out
  }
}

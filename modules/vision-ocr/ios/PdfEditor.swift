import Foundation
import PDFKit

/// Page edits on an imported PDF that keep it a PDF: rotate, delete, reorder,
/// insert a blank page and split. Pages are moved, never redrawn, so their text
/// stays selectable and searchable, and their links, form fields and
/// annotations come with them.
///
/// One primitive does all of it: `compose` writes a PDF whose pages are, in
/// order, the input's pages named by `sources` (each turned by `rotations`), or
/// blank pages. Delete leaves a page out, reorder permutes, split is two calls
/// with the two halves.
///
/// `sources[i]` >= 0 is an input page index (each at most once); a negative
/// value -(k + 1) is a blank page shaped like input page k (same size and
/// orientation). `rotations[i]` is added to that page's rotation (a multiple
/// of 90, either sign).
///
/// Protected PDFs:
///  - Opened with its password (the user unlocked it): rebuilt into a fresh,
///    unencrypted document, the same as unlocking (lib/pdf-unlock.ts).
///  - Opens without a password but is encrypted (an owner password with
///    permissions, e.g. bank statements): edited IN PLACE when its permissions
///    allow document assembly, keeping its form fields, page labels and
///    named destinations; it is written back encrypted with its permissions
///    (keepProtectionOptions). When they don't allow assembly the edit is refused
///    with `restrictedMessage` ("restricted"; ERR_PDF_RESTRICTED from the
///    module): PDFKit itself won't rotate or remove pages of such a document,
///    and rebuilding it would silently drop the author's restrictions.
///
/// The output is written to `outputPath` and read back before this returns:
/// it must open, be unlocked, have exactly the planned pages and their planned
/// rotations. Anything else removes it and throws, so a caller never swaps in
/// a half-written or wrong file.
enum PdfEditor {
  static func fail(_ code: Int, _ message: String) -> NSError {
    NSError(domain: "PdfEditor", code: code, userInfo: [NSLocalizedDescriptionKey: message])
  }

  static let lockedMessage = "locked"
  /// The PDF's permissions don't allow changing its pages (see the header).
  static let restrictedMessage = "restricted"

  /// Opens a PDF, unlocking it with `password` when it is protected.
  /// Throws "locked" when it needs a password that wasn't given or is wrong.
  static func open(_ path: String, password: String?) throws -> PDFDocument {
    try openReporting(path, password: password).doc
  }

  /// `open`, also saying whether a password was needed to open it.
  static func openReporting(_ path: String, password: String?) throws -> (doc: PDFDocument, unlocked: Bool) {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
      throw fail(1, "Could not open the PDF")
    }
    if doc.isLocked {
      guard let pw = password, !pw.isEmpty, doc.unlock(withPassword: pw) else {
        throw fail(2, lockedMessage)
      }
      return (doc, true)
    }
    return (doc, false)
  }

  /// Encrypted with permissions that don't allow moving, removing, rotating
  /// or inserting pages (and it opened without a password).
  static func isRestricted(_ doc: PDFDocument, unlocked: Bool) -> Bool {
    doc.isEncrypted && !unlocked && !doc.allowsDocumentAssembly
  }

  /// Write options that keep an encrypted document (one that opened without
  /// a password: an owner password with permissions) protected. PDFKit's
  /// plain write(to:) drops the encryption, and with it the author's
  /// restrictions; this writes the author's permissions under a new random
  /// owner password (the original can't be known without asking for it).
  ///
  /// PDFKit's getter reports `allowsDocumentChanges` whenever form filling,
  /// commenting or page assembly is allowed (the "superset" rule in
  /// PDFDocument.h). Written back, that bit becomes the PDF's real "modify
  /// contents" permission (/P bit 4), which in revision 3+ also grants
  /// assembly, commenting and form filling: one edit would loosen the file.
  /// So it is cleared: every other permission then round-trips to the
  /// author's exact /P (measured with qpdf for assembly-only, form-only,
  /// annotate, print-only and "all but copying" sources). For a source that
  /// really allowed "modify contents" this only tightens that one bit, which
  /// Scan Kit never uses. The writers also read the result back and refuse it
  /// if any permission went from off to on (`PdfStructure.widenedPermissions`).
  static func keepProtectionOptions(_ doc: PDFDocument) -> [PDFDocumentWriteOption: Any] {
    guard doc.isEncrypted, !doc.isLocked else { return [:] }
    return protectionOptions(permissions: doc.accessPermissions.rawValue)
  }

  /// Owner-password write options for `permissions` (PDFKit's raw bits), the
  /// derived "document changes" bit cleared (see keepProtectionOptions).
  static func protectionOptions(permissions: UInt) -> [PDFDocumentWriteOption: Any] {
    let raw = permissions & ~PDFAccessPermissions.allowsDocumentChanges.rawValue
    return [
      .ownerPasswordOption: UUID().uuidString + UUID().uuidString,
      .accessPermissionsOption: NSNumber(value: raw),
    ]
  }

  static func normalized(_ degrees: Int) -> Int {
    ((degrees % 360) + 360) % 360
  }

  /// Page count and protection of a PDF, without changing it.
  static func info(path: String, password: String?) throws -> [String: Any] {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
      throw fail(1, "Could not open the PDF")
    }
    let wasLocked = doc.isLocked
    var locked = wasLocked
    if locked, let pw = password, !pw.isEmpty, doc.unlock(withPassword: pw) { locked = false }
    var out: [String: Any] = [
      "pageCount": doc.pageCount,
      "locked": locked,
      "encrypted": doc.isEncrypted,
      // Page edits would be refused (restrictedMessage).
      "restricted": !locked && isRestricted(doc, unlocked: wasLocked),
    ]
    if !locked {
      // What else the file holds (round 13b): Fill & sign and Share use it.
      out["canAnnotate"] = PdfFiller.canAnnotate(doc)
      out["canFillForms"] = PdfFiller.canFillForms(doc)
      var widgets = 0
      var additions = 0
      for i in 0..<doc.pageCount {
        for a in doc.page(at: i)?.annotations ?? [] {
          if a.type == "Widget" { widgets += 1 } else if PdfFlattener.flattens(a) { additions += 1 }
        }
      }
      out["formFields"] = widgets
      out["annotations"] = additions
      let facts = PdfStructure.formFacts(path: path)
      out["signed"] = facts.signed
      out["certified"] = facts.certified
      out["xfa"] = facts.xfa
    }
    return out
  }

  /// A blank page the size and orientation of `like`: PDFKit's own empty page
  /// (no content), with `like`'s media and crop boxes and rotation.
  static func blankPage(like: PDFPage) -> PDFPage {
    let page = PDFPage()
    page.setBounds(like.bounds(for: .mediaBox), for: .mediaBox)
    page.setBounds(like.bounds(for: .cropBox), for: .cropBox)
    page.rotation = like.rotation
    return page
  }

  /// A bookmark and where it pointed before the edit (input page index, point on it).
  typealias OutlineLink = (item: PDFOutline, page: Int, point: CGPoint)

  /// Every bookmark (outline entry) that goes to a page of the input, read
  /// BEFORE pages move: PDFKit drops a destination's page when the page is
  /// removed from its document, even if it is inserted again.
  static func outlineLinks(_ root: PDFOutline?, originals: [PDFPage]) -> [OutlineLink] {
    guard let root = root else { return [] }
    var links: [OutlineLink] = []
    func walk(_ item: PDFOutline) {
      for i in 0..<item.numberOfChildren {
        guard let child = item.child(at: i) else { continue }
        if let dest = child.destination, let page = dest.page,
           let index = originals.firstIndex(where: { $0 === page }) {
          links.append((child, index, dest.point))
        }
        walk(child)
      }
    }
    walk(root)
    return links
  }

  /// Points each bookmark at its page again, wherever the page is now; one to
  /// a deleted page is removed (or, if it has sub-entries, just loses its target).
  static func relink(_ links: [OutlineLink], originals: [PDFPage], kept: Set<Int>) {
    for link in links.reversed() {
      if kept.contains(link.page) {
        link.item.destination = PDFDestination(page: originals[link.page], at: link.point)
      } else if link.item.numberOfChildren == 0 {
        link.item.removeFromParent()
      } else {
        link.item.destination = nil
      }
    }
  }

  static func compose(inputPath: String, outputPath: String, sources: [Int], rotations: [Int],
                      password: String?) throws -> Int {
    let (doc, unlocked) = try openReporting(inputPath, password: password)
    guard !isRestricted(doc, unlocked: unlocked) else { throw fail(12, restrictedMessage) }
    let count = doc.pageCount
    guard count > 0 else { throw fail(4, "The PDF has no pages") }
    guard !sources.isEmpty, rotations.count == sources.count else { throw fail(5, "Bad page plan") }
    var used = Set<Int>()
    for s in sources {
      let index = s >= 0 ? s : -s - 1
      guard index >= 0 && index < count else { throw fail(5, "Bad page plan") }
      if s >= 0 {
        guard !used.contains(s) else { throw fail(5, "Bad page plan") }
        used.insert(s)
      }
    }
    for r in rotations where r % 90 != 0 { throw fail(5, "Bad rotation") }

    var originals: [PDFPage] = []
    for i in 0..<count {
      guard let p = doc.page(at: i) else { throw fail(6, "Could not read page \(i + 1)") }
      originals.append(p)
    }
    var targets: [PDFPage] = []
    for s in sources {
      targets.append(s >= 0 ? originals[s] : blankPage(like: originals[-s - 1]))
    }
    var expected: [Int] = []
    for (i, page) in targets.enumerated() {
      let r = normalized(page.rotation + rotations[i])
      if r != normalized(page.rotation) { page.rotation = r }
      expected.append(r)
    }
    let links = outlineLinks(doc.outlineRoot, originals: originals)

    let out: PDFDocument
    if unlocked {
      // Opened with its password: rebuilt into a fresh document so no
      // encryption dictionary carries over (the same as unlocking,
      // lib/pdf-unlock.ts), with metadata and bookmarks. Writing it in place
      // would keep it locked with a password Scan Kit doesn't store.
      out = PDFDocument()
      for page in targets { out.insert(page, at: out.pageCount) }
      if let attrs = doc.documentAttributes { out.documentAttributes = attrs }
      if let outline = doc.outlineRoot { out.outlineRoot = outline }
    } else {
      // Edited in place, so everything the document itself carries (form
      // fields, bookmarks, metadata, page labels) stays; an owner-password
      // PDF keeps its encryption and permissions.
      out = doc
      let keep = Set(sources.filter { $0 >= 0 })
      var i = count - 1
      while i >= 0 {
        if !keep.contains(i) { out.removePage(at: i) }
        i -= 1
      }
      // Put each page in its place, front to back: pages already placed
      // stay in front, so `j` is never below `k`. Remove + insert only
      // (exchangePage raises an Objective-C exception for some pages, which
      // Swift can't catch). Blank pages aren't in the document yet: inserted.
      for k in 0..<targets.count {
        let j = out.index(for: targets[k])
        if j == k { continue }
        if j != NSNotFound {
          guard j > k else { throw fail(7, "Lost a page while editing") }
          out.removePage(at: j)
        } else if sources[k] >= 0 {
          throw fail(7, "Lost a page while editing")
        }
        out.insert(targets[k], at: k)
      }
    }
    relink(links, originals: originals, kept: used)
    guard out.pageCount == targets.count else { throw fail(7, "Page count mismatch") }
    for k in 0..<targets.count where out.page(at: k) !== targets[k] {
      throw fail(7, "Page order mismatch")
    }

    let url = URL(fileURLWithPath: outputPath)
    try? FileManager.default.removeItem(at: url)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    // In place, an owner-password PDF stays protected (see keepProtectionOptions);
    // a document rebuilt after unlocking is written without a password.
    let wasEncrypted = doc.isEncrypted && !unlocked
    // Taken before writing: what the author allowed (see keepProtectionOptions).
    let source = wasEncrypted ? PDFDocument(url: URL(fileURLWithPath: inputPath)) : nil
    guard out.write(to: url, withOptions: unlocked ? [:] : keepProtectionOptions(doc)) else {
      try? FileManager.default.removeItem(at: url)
      throw fail(8, "Could not write the PDF")
    }
    // A form's widgets keep the appearances PDFKit drew (PdfStructure).
    PdfStructure.settleNeedAppearances(at: url)
    // Read back what was written: never hand over a file that isn't exactly the plan.
    guard let check = PDFDocument(url: url), !check.isLocked, check.pageCount == targets.count else {
      try? FileManager.default.removeItem(at: url)
      throw fail(9, "The edited PDF could not be verified")
    }
    // Never looser than the author made it: still encrypted, no permission turned on.
    if wasEncrypted {
      let widened = source.map { PdfStructure.widenedPermissions(source: $0, written: check) } ?? "source unreadable"
      if let what = widened {
        NSLog("PdfEditor: refused, permissions widened (%@)", what)
        try? FileManager.default.removeItem(at: url)
        throw fail(9, "The edited PDF could not be verified")
      }
    }
    for k in 0..<expected.count {
      guard let p = check.page(at: k), normalized(p.rotation) == expected[k] else {
        try? FileManager.default.removeItem(at: url)
        throw fail(9, "The edited PDF could not be verified")
      }
    }
    return check.pageCount
  }

  /// Moves `srcPath` over `destPath` in one step: rename(2) replaces the
  /// destination atomically, so at every instant `destPath` is either the old
  /// file or the new one, never missing or partial. Across volumes (never the
  /// case inside the app's container) the file is first copied next to the
  /// destination, then renamed over it.
  static func replace(srcPath: String, destPath: String) throws {
    guard FileManager.default.fileExists(atPath: srcPath) else { throw fail(10, "Nothing to move") }
    if rename(srcPath, destPath) == 0 { return }
    let err = errno
    guard err == EXDEV else {
      throw fail(11, "Could not replace the file (\(String(cString: strerror(err))))")
    }
    let dest = URL(fileURLWithPath: destPath)
    let part = dest.deletingLastPathComponent()
      .appendingPathComponent(".\(dest.lastPathComponent).\(UUID().uuidString).part")
    do {
      try FileManager.default.copyItem(at: URL(fileURLWithPath: srcPath), to: part)
    } catch {
      try? FileManager.default.removeItem(at: part)
      throw error
    }
    guard rename(part.path, destPath) == 0 else {
      let e = errno
      try? FileManager.default.removeItem(at: part)
      throw fail(11, "Could not replace the file (\(String(cString: strerror(e))))")
    }
    try? FileManager.default.removeItem(atPath: srcPath)
  }
}

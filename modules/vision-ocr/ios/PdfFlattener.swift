import CoreGraphics
import Foundation
import PDFKit

/// Burning things into a page's content: the page is redrawn with Core
/// Graphics into a new one-page PDF (the page's own content drawn as
/// content, so its text stays vector text, selectable and searchable), with
/// what is burned in drawn on top, and the new page takes the old one's
/// place in the document.
///
/// Two users:
///  - `flatten`: a copy for sharing in which form-field values, signatures,
///    added text, stamps and notes are part of the page, so the recipient
///    can't move or edit them and every reader shows them the same way. Links
///    stay links. The stored PDF is never touched.
///  - PdfFiller's fallback for when PDFKit doesn't record a Fill & sign
///    addition's drawing as its appearance (an older iOS): the additions are
///    burned in, and every other annotation and form field of the page is
///    moved, live, onto the new page.
enum PdfFlattener {
  static func fail(_ code: Int, _ message: String) -> NSError {
    NSError(domain: "PdfFlattener", code: code, userInfo: [NSLocalizedDescriptionKey: message])
  }

  /// Annotations a flattened copy draws into the page: everything shown
  /// except links (kept as links) and pop-ups (a note's open bubble).
  static func flattens(_ a: PDFAnnotation) -> Bool {
    let t = a.type ?? ""
    return t != "Link" && t != "Popup" && a.shouldDisplay
  }

  /// A new page with `page`'s content (Core Graphics, vector) and `extra`
  /// drawn on top in the page's own coordinate space; same boxes and
  /// rotation, no annotations. `holder` keeps the one-page document alive.
  static func redrawn(_ page: PDFPage, holder: inout [PDFDocument], extra: (CGContext) -> Void) throws -> PDFPage {
    guard let source = page.pageRef else { throw fail(1, "Could not read the page") }
    var media = page.bounds(for: .mediaBox)
    let data = NSMutableData()
    guard let consumer = CGDataConsumer(data: data as CFMutableData),
          let ctx = CGContext(consumer: consumer, mediaBox: &media, nil) else { throw fail(2, "Could not draw the page") }
    ctx.beginPDFPage([kCGPDFContextMediaBox as String: NSData(bytes: &media, length: MemoryLayout<CGRect>.size)] as CFDictionary)
    ctx.saveGState()
    // drawPDFPage draws the page's content in its own user space (no
    // rotation, no box transform): exactly where it was.
    ctx.drawPDFPage(source)
    ctx.restoreGState()
    ctx.saveGState()
    extra(ctx)
    ctx.restoreGState()
    ctx.endPDFPage()
    ctx.closePDF()
    guard let doc = PDFDocument(data: data as Data), let fresh = doc.page(at: 0) else { throw fail(3, "Could not draw the page") }
    holder.append(doc)
    for box in [PDFDisplayBox.cropBox, .bleedBox, .trimBox, .artBox] {
      fresh.setBounds(page.bounds(for: box), for: box)
    }
    fresh.rotation = page.rotation
    return fresh
  }

  /// Puts `fresh` in place of the page at `index`; bookmarks and links that
  /// went to the old page go to the new one.
  static func replace(_ doc: PDFDocument, at index: Int, with fresh: PDFPage) {
    guard let old = doc.page(at: index) else { return }
    var all: [PDFPage] = []
    for i in 0..<doc.pageCount { if let p = doc.page(at: i) { all.append(p) } }
    let links = PdfEditor.outlineLinks(doc.outlineRoot, originals: all)
    // Link annotations (on any page) that go to the old page.
    var goTos: [(PDFAnnotation, CGPoint)] = []
    for p in all {
      for a in p.annotations {
        if let d = a.destination, d.page === old { goTos.append((a, d.point)) }
        else if let act = a.action as? PDFActionGoTo, act.destination.page === old { goTos.append((a, act.destination.point)) }
      }
    }
    doc.insert(fresh, at: index)
    doc.removePage(at: index + 1)
    for link in links where link.page == index {
      link.item.destination = PDFDestination(page: fresh, at: link.point)
    }
    for (a, point) in goTos {
      if a.action is PDFActionGoTo {
        a.action = PDFActionGoTo(destination: PDFDestination(page: fresh, at: point))
      } else {
        a.destination = PDFDestination(page: fresh, at: point)
      }
    }
  }

  /// Writes a flattened copy of `inputPath` (see the header) to `outputPath`
  /// and reads it back. Returns the page count. An encrypted PDF stays
  /// encrypted with the same permissions, and is refused ("restricted") when
  /// they don't allow both commenting and filling in its form.
  static func flatten(inputPath: String, outputPath: String) throws -> Int {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: inputPath)) else { throw fail(4, "Could not open the PDF") }
    if doc.isLocked { throw fail(5, PdfEditor.lockedMessage) }
    if doc.isEncrypted && !(doc.allowsCommenting && doc.allowsFormFieldEntry) { throw fail(6, PdfEditor.restrictedMessage) }
    let count = doc.pageCount
    guard count > 0 else { throw fail(7, "The PDF has no pages") }
    let source = PDFDocument(url: URL(fileURLWithPath: inputPath))
    var holder: [PDFDocument] = []
    var kept: [Int] = []      // links kept per page
    var texts: [Int] = []     // text length per page before
    var rotations: [Int] = []
    for i in 0..<count {
      guard let page = doc.page(at: i) else { throw fail(8, "Could not read page \(i + 1)") }
      texts.append(page.string?.count ?? 0)
      rotations.append(PdfEditor.normalized(page.rotation))
      let burn = page.annotations.filter(flattens)
      let links = page.annotations.filter { $0.type == "Link" }
      kept.append(links.count)
      if burn.isEmpty { continue }
      // PDFKit draws an annotation turned by its page's rotation; the new
      // page gets that rotation itself, so draw them unturned.
      let turn = page.rotation
      page.rotation = 0
      let fresh = try redrawn(page, holder: &holder) { ctx in
        for a in burn { a.draw(with: .mediaBox, in: ctx) }
      }
      page.rotation = turn
      fresh.rotation = turn
      for a in links {
        page.removeAnnotation(a)
        fresh.addAnnotation(a)
      }
      replace(doc, at: i, with: fresh)
    }
    let url = URL(fileURLWithPath: outputPath)
    try? FileManager.default.removeItem(at: url)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard doc.write(to: url, withOptions: PdfEditor.keepProtectionOptions(doc)) else {
      try? FileManager.default.removeItem(at: url)
      throw fail(9, "Could not write the PDF")
    }
    func refuse(_ why: String) -> NSError {
      NSLog("PdfFlattener: not verified (%@)", why)
      try? FileManager.default.removeItem(at: url)
      return fail(10, "The flattened PDF could not be verified")
    }
    guard let check = PDFDocument(url: url), !check.isLocked, check.pageCount == count else { throw refuse("pages") }
    if let src = source, let widened = PdfStructure.widenedPermissions(source: src, written: check) { throw refuse(widened) }
    for i in 0..<count {
      guard let p = check.page(at: i) else { throw refuse("page") }
      if PdfEditor.normalized(p.rotation) != rotations[i] { throw refuse("rotation") }
      // Nothing left to edit or move; links still there; the text still text.
      if p.annotations.contains(where: { $0.type == "Widget" || flattens($0) }) { throw refuse("annotations on page \(i + 1)") }
      if p.annotations.filter({ $0.type == "Link" }).count != kept[i] { throw refuse("links on page \(i + 1)") }
      if (p.string?.count ?? 0) < texts[i] / 2 { throw refuse("text on page \(i + 1)") }
    }
    return count
  }

  /// True when `rect` of the two pages' content (annotations not drawn)
  /// looks different: something was burned in there.
  static func contentDiffers(_ a: CGPDFPage, _ b: CGPDFPage, in rect: CGRect) -> Bool {
    func render(_ page: CGPDFPage) -> [UInt8]? {
      let side = 48
      var pixels = [UInt8](repeating: 255, count: side * side)
      let ok: Bool = pixels.withUnsafeMutableBytes { buf in
        guard let ctx = CGContext(data: buf.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: side, height: side))
        ctx.scaleBy(x: CGFloat(side) / max(rect.width, 1), y: CGFloat(side) / max(rect.height, 1))
        ctx.translateBy(x: -rect.minX, y: -rect.minY)
        ctx.drawPDFPage(page)
        return true
      }
      return ok ? pixels : nil
    }
    guard let x = render(a), let y = render(b) else { return false }
    var diff = 0
    for i in 0..<x.count { diff += abs(Int(x[i]) - Int(y[i])) }
    return diff > 255 * 3 // a few pixels' worth: a thin check mark still counts
  }
}

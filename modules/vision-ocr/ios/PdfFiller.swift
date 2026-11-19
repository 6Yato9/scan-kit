import CoreGraphics
import CoreText
import Foundation
import ImageIO
import PDFKit
import UIKit

/// Fill & sign for an imported PDF, in place: form fields filled, and text,
/// dates, check marks, crosses, signatures and initials added — without
/// redrawing the page. The page's own content is never touched (its text stays
/// text, selectable and searchable); everything added is a PDF annotation.
///
/// What is added, and why annotations
/// - Each addition is a Stamp annotation (`FillMark`) whose look PDFKit records
///   into the annotation's appearance stream (/AP) when it writes the file:
///   vector text (an embedded font subset), vector check marks and crosses,
///   and the signature as an image with transparency. Every viewer that shows
///   annotations (Preview, Files, Mail, Acrobat, Chrome, poppler, Ghostscript)
///   draws that appearance. Flattening into the page's content stream instead
///   would mean rebuilding the page through Core Graphics, which drops the
///   page's links, notes and form fields.
/// - Whether PDFKit serialises a custom annotation's drawing is not documented,
///   so nothing is assumed: the written file is parsed back with Core Graphics
///   (an independent reader) and every addition must be there WITH a non-empty
///   appearance stream, or the write is refused ("not verified") and the
///   stored PDF stays as it was.
/// - The page's rotation (/Rotate) is honoured: the appearance is drawn turned
///   against it, so an addition reads upright however the page is shown.
///
/// Form fields (AcroForm widgets): values are set through PDFKit
/// (widgetStringValue, buttonWidgetState), which regenerates their appearance
/// and keeps the form itself. Read back after writing.
///
/// Permissions: an encrypted PDF that opens without a password stays
/// protected (PdfEditor.keepProtectionOptions: PDFKit would otherwise write it
/// unencrypted). Additions need
/// `allowsCommenting`, field values `allowsFormFieldEntry`; otherwise the fill
/// is refused with PdfEditor.restrictedMessage. A PDF that needs a password is
/// refused ("locked"): the viewer's unlock flow stores an unlocked copy first.
enum PdfFiller {
  static func fail(_ code: Int, _ message: String) -> NSError {
    NSError(domain: "PdfFiller", code: code, userInfo: [NSLocalizedDescriptionKey: message])
  }

  /// Fields changed between reading them and filling them (another edit came first).
  static let changedMessage = "changed"
  /// The written file didn't read back as planned.
  static let unverifiedMessage = "The filled PDF could not be verified"
  /// Every addition carries this key (PDFKit writes custom keys; it drops /NM)
  /// with a per-fill id, so the read-back can count them.
  static let markKey = PDFAnnotationKey(rawValue: "/SKFill")
  static let markPrefix = "scankit-fill-"

  // MARK: Opening

  static func openUnlocked(_ path: String) throws -> PDFDocument {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { throw fail(1, "Could not open the PDF") }
    if doc.isLocked { throw fail(2, PdfEditor.lockedMessage) }
    return doc
  }

  /// Unencrypted documents allow everything; encrypted ones say so themselves.
  static func canAnnotate(_ doc: PDFDocument) -> Bool { !doc.isEncrypted || doc.allowsCommenting }
  static func canFillForms(_ doc: PDFDocument) -> Bool { !doc.isEncrypted || doc.allowsFormFieldEntry }

  static func rectArray(_ r: CGRect) -> [Double] {
    [Double(r.origin.x), Double(r.origin.y), Double(r.size.width), Double(r.size.height)]
  }

  // MARK: Info

  static func fieldKind(_ a: PDFAnnotation) -> String? {
    switch a.widgetFieldType {
    case .text: return "text"
    case .choice: return "choice"
    case .signature: return "signature"
    case .button:
      switch a.widgetControlType {
      case .checkBoxControl: return "checkbox"
      case .radioButtonControl: return "radio"
      default: return nil // push buttons do nothing here
      }
    default: return nil
    }
  }

  /// Pages (crop box, media box, rotation), the form's fields and what the
  /// PDF's permissions allow. Throws "locked" for a PDF that needs a password.
  static func info(path: String) throws -> [String: Any] {
    let doc = try openUnlocked(path)
    guard doc.pageCount > 0 else { throw fail(4, "The PDF has no pages") }
    var pages: [[String: Any]] = []
    var fields: [[String: Any]] = []
    for i in 0..<doc.pageCount {
      guard let page = doc.page(at: i) else { throw fail(6, "Could not read page \(i + 1)") }
      pages.append([
        "crop": rectArray(page.bounds(for: .cropBox)),
        "media": rectArray(page.bounds(for: .mediaBox)),
        "rotation": PdfEditor.normalized(page.rotation),
      ])
      for (k, a) in page.annotations.enumerated() {
        guard a.type == "Widget", a.shouldDisplay, let kind = fieldKind(a) else { continue }
        var f: [String: Any] = [
          "id": "\(i):\(k)",
          "page": i,
          "name": a.fieldName ?? "",
          "kind": kind,
          "rect": rectArray(a.bounds),
          "readOnly": a.isReadOnly,
          "fontSize": Double(a.font?.pointSize ?? 0),
          // The field's description for people (/TU), when the form has one.
          "label": (a.value(forAnnotationKey: PDFAnnotationKey(rawValue: "/TU")) as? String) ?? "",
        ]
        switch kind {
        case "text":
          f["value"] = a.widgetStringValue ?? ""
          f["multiline"] = a.isMultiline
          f["maxLength"] = a.maximumLength
          f["comb"] = a.hasComb
          f["align"] = a.alignment == .center ? "center" : a.alignment == .right ? "right" : "left"
        case "choice":
          f["value"] = a.widgetStringValue ?? ""
          f["options"] = a.choices ?? []
          f["list"] = a.isListChoice
        case "checkbox", "radio":
          f["on"] = a.buttonWidgetState == .onState
          f["onValue"] = a.buttonWidgetStateString
        default:
          break
        }
        fields.append(f)
      }
    }
    return [
      "pageCount": doc.pageCount,
      "encrypted": doc.isEncrypted,
      "canAnnotate": canAnnotate(doc),
      "canFillForms": canFillForms(doc),
      "pages": pages,
      "fields": fields,
    ]
  }

  // MARK: Page preview

  /// One page as an upright JPEG (crop box, rotation applied), long edge
  /// `maxEdge` px, on white. With `hideFields` the form's widgets are left out
  /// (the fill screen draws the fields itself); everything else on the page,
  /// earlier notes and signatures included, is drawn.
  static func renderPage(path: String, index: Int, outPath: String, maxEdge: CGFloat, hideFields: Bool) throws -> [String: Any] {
    let doc = try openUnlocked(path)
    guard index >= 0, index < doc.pageCount, let page = doc.page(at: index) else { throw fail(5, "No such page") }
    if hideFields {
      // This document is only drawn, never written: hiding is not saved.
      for a in page.annotations where a.type == "Widget" { a.shouldDisplay = false }
    }
    let box = page.bounds(for: .cropBox)
    let turned = PdfEditor.normalized(page.rotation) % 180 != 0
    let w = turned ? box.height : box.width
    let h = turned ? box.width : box.height
    guard w > 0, h > 0 else { throw fail(6, "Empty page") }
    let scale = max(0.1, min(maxEdge, 4000) / max(w, h))
    let size = CGSize(width: max(1, (w * scale).rounded()), height: max(1, (h * scale).rounded()))
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let data: Data? = autoreleasepool {
      let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
        UIColor.white.setFill()
        ctx.fill(CGRect(origin: .zero, size: size))
        let cg = ctx.cgContext
        cg.saveGState()
        cg.translateBy(x: 0, y: size.height)
        cg.scaleBy(x: size.width / w, y: -size.height / h)
        page.draw(with: .cropBox, to: cg)
        cg.restoreGState()
      }
      return image.jpegData(compressionQuality: 0.88)
    }
    guard let jpeg = data else { throw fail(7, "Could not encode the page") }
    let url = URL(fileURLWithPath: outPath)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try jpeg.write(to: url, options: .atomic)
    return ["uri": url.absoluteString, "width": Int(size.width), "height": Int(size.height)]
  }

  // MARK: Filling

  struct Mark {
    let page: Int
    let rect: CGRect
    let kind: String
    let text: String
    let fontSize: CGFloat
    let color: CGColor
    let image: CGImage?
  }

  static func color(_ hex: String?) -> CGColor {
    var s = (hex ?? "").trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let v = UInt32(s, radix: 16) else { return CGColor(red: 0.07, green: 0.07, blue: 0.07, alpha: 1) }
    return CGColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
                   blue: CGFloat(v & 0xff) / 255, alpha: 1)
  }

  /// A PNG (base64, optionally a data: URI) recoloured to `ink`, its shape
  /// kept by its alpha, at most 1600 px on the long edge.
  static func inkImage(_ base64: String, ink: CGColor) throws -> CGImage {
    let b64 = base64.range(of: "base64,").map { String(base64[$0.upperBound...]) } ?? base64
    guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters),
          let src = CGImageSourceCreateWithData(data as CFData, nil) else { throw fail(20, "Bad signature image") }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceThumbnailMaxPixelSize: 1600,
      kCGImageSourceCreateThumbnailWithTransform: true,
    ]
    guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) ?? CGImageSourceCreateImageAtIndex(src, 0, nil)
    else { throw fail(20, "Bad signature image") }
    guard let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw fail(21, "Out of memory") }
    let r = CGRect(x: 0, y: 0, width: img.width, height: img.height)
    ctx.draw(img, in: r)
    ctx.setBlendMode(.sourceIn)
    ctx.setFillColor(ink)
    ctx.fill(r)
    guard let out = ctx.makeImage() else { throw fail(21, "Out of memory") }
    return out
  }

  static func parseMarks(_ list: [[String: Any]], pageCount: Int) throws -> [Mark] {
    try list.map { m in
      guard let page = m["page"] as? Int, page >= 0, page < pageCount,
            let r = m["rect"] as? [Double], r.count == 4, r.allSatisfy({ $0.isFinite }), r[2] > 0, r[3] > 0,
            let kind = m["kind"] as? String, ["text", "check", "cross", "image"].contains(kind) else {
        throw fail(22, "Bad addition")
      }
      let ink = color(m["color"] as? String)
      let text = (m["text"] as? String) ?? ""
      if kind == "text" && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw fail(22, "Empty text") }
      let image = kind == "image" ? try inkImage((m["image"] as? String) ?? "", ink: ink) : nil
      let size = CGFloat((m["fontSize"] as? Double) ?? 12)
      return Mark(page: page, rect: CGRect(x: r[0], y: r[1], width: r[2], height: r[3]), kind: kind, text: text,
                  fontSize: max(2, min(size, 400)), color: ink, image: image)
    }
  }

  /// Fills `inputPath`'s form fields and adds `marks`, writing the result to
  /// `outputPath` and reading it back (see the header). Returns the page count.
  ///
  /// fields: [{ id: "page:index", name, kind, value?, on? }] (from `info`)
  /// marks:  [{ page, rect: [x, y, w, h] in the page's PDF space, kind:
  ///            "text" | "check" | "cross" | "image", text?, fontSize? (pt),
  ///            color? "#rrggbb", image? base64 PNG }]
  static func fill(inputPath: String, outputPath: String, fields: [[String: Any]], marks rawMarks: [[String: Any]]) throws -> Int {
    let doc = try openUnlocked(inputPath)
    let count = doc.pageCount
    guard count > 0 else { throw fail(4, "The PDF has no pages") }
    guard !fields.isEmpty || !rawMarks.isEmpty else { throw fail(5, "Nothing to fill") }
    if !rawMarks.isEmpty && !canAnnotate(doc) { throw fail(12, PdfEditor.restrictedMessage) }
    if !fields.isEmpty && !canFillForms(doc) { throw fail(12, PdfEditor.restrictedMessage) }
    let marks = try parseMarks(rawMarks, pageCount: count)

    var rotations: [Int] = []
    for i in 0..<count { rotations.append(PdfEditor.normalized(doc.page(at: i)?.rotation ?? 0)) }

    // Form fields, each checked against what `info` said it was.
    typealias Expect = (annotation: PDFAnnotation, page: Int, index: Int, kind: String, value: String?, on: Bool?)
    var expects: [Expect] = []
    for f in fields {
      guard let id = f["id"] as? String, let name = f["name"] as? String, let kind = f["kind"] as? String else {
        throw fail(13, changedMessage)
      }
      let parts = id.split(separator: ":").compactMap { Int($0) }
      guard parts.count == 2, parts[0] >= 0, parts[0] < count, let page = doc.page(at: parts[0]),
            parts[1] >= 0, parts[1] < page.annotations.count else { throw fail(13, changedMessage) }
      let a = page.annotations[parts[1]]
      guard a.type == "Widget", (a.fieldName ?? "") == name, fieldKind(a) == kind, !a.isReadOnly else {
        throw fail(13, changedMessage)
      }
      switch kind {
      case "text", "choice":
        let value = (f["value"] as? String) ?? ""
        a.widgetStringValue = value
        expects.append((a, parts[0], parts[1], kind, value, nil))
      case "checkbox", "radio":
        expects.append((a, parts[0], parts[1], kind, nil, (f["on"] as? Bool) ?? false))
      default:
        throw fail(13, changedMessage)
      }
    }
    // Buttons after: a radio group shares one value, so turning one of its
    // buttons off would turn the chosen one off too. Turn the chosen ones on;
    // only a group with none chosen is turned off.
    let radioGroupsOn = Set(expects.filter { $0.kind == "radio" && $0.on == true }.map { $0.annotation.fieldName ?? "" })
    for e in expects where e.on != nil {
      if e.on == true {
        e.annotation.buttonWidgetState = .onState
      } else if e.kind == "checkbox" || !radioGroupsOn.contains(e.annotation.fieldName ?? "") {
        e.annotation.buttonWidgetState = .offState
      }
    }

    // Additions.
    let runId = markPrefix + UUID().uuidString.prefix(8).lowercased()
    var expectedMarks: [Int: Int] = [:]
    for (n, m) in marks.enumerated() {
      guard let page = doc.page(at: m.page) else { throw fail(6, "Could not read page \(m.page + 1)") }
      let media = page.bounds(for: .mediaBox)
      let rect = m.rect.intersection(media)
      guard !rect.isNull, rect.width >= 1, rect.height >= 1 else { throw fail(22, "Addition off the page") }
      let mark = FillMark(bounds: rect, forType: .stamp, withProperties: nil)
      mark.kind = m.kind
      mark.text = m.text
      mark.fontSize = m.fontSize
      mark.ink = m.color
      mark.image = m.image
      mark.pageRotation = rotations[m.page]
      mark.setValue("\(runId)-\(n)" as NSString, forAnnotationKey: markKey)
      mark.shouldPrint = true
      mark.shouldDisplay = true
      page.addAnnotation(mark)
      expectedMarks[m.page, default: 0] += 1
    }

    let url = URL(fileURLWithPath: outputPath)
    try? FileManager.default.removeItem(at: url)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let wasEncrypted = doc.isEncrypted
    guard doc.write(to: url, withOptions: PdfEditor.keepProtectionOptions(doc)) else {
      try? FileManager.default.removeItem(at: url)
      throw fail(8, "Could not write the PDF")
    }

    // Read back: same pages and turns, the field values, every addition with
    // its appearance. Anything else and the file is not handed over.
    func refuse(_ why: String) -> NSError {
      NSLog("PdfFiller: write not verified (%@)", why)
      try? FileManager.default.removeItem(at: url)
      return fail(9, unverifiedMessage)
    }
    guard let check = PDFDocument(url: url), !check.isLocked, check.pageCount == count else { throw refuse("pages") }
    if wasEncrypted && !check.isEncrypted { throw refuse("protection") }
    for i in 0..<count where PdfEditor.normalized(check.page(at: i)?.rotation ?? -1) != rotations[i] { throw refuse("rotation") }
    for e in expects {
      guard let page = check.page(at: e.page) else { throw refuse("field page") }
      // The same widget, found by field name and place (indexes can shift on write).
      let match = page.annotations.first {
        $0.type == "Widget" && ($0.fieldName ?? "") == (e.annotation.fieldName ?? "") && $0.bounds.equalTo(e.annotation.bounds)
      }
      guard let w = match else { throw refuse("field \(e.annotation.fieldName ?? "")") }
      if let v = e.value, (w.widgetStringValue ?? "") != v { throw refuse("value of \(e.annotation.fieldName ?? "")") }
      if let on = e.on, (w.buttonWidgetState == .onState) != on { throw refuse("state of \(e.annotation.fieldName ?? "")") }
    }
    if !marks.isEmpty {
      guard let cg = CGPDFDocument(url as CFURL) else { throw refuse("cgpdf") }
      for (page, n) in expectedMarks where appearancesWritten(cg, pageIndex: page, prefix: runId) != n {
        throw refuse("appearances on page \(page + 1)")
      }
    }
    return check.pageCount
  }

  /// How many annotations on the page have a /SKFill starting with `prefix` AND a
  /// normal appearance stream with content, read with Core Graphics (not PDFKit).
  static func appearancesWritten(_ doc: CGPDFDocument, pageIndex: Int, prefix: String) -> Int {
    guard let page = doc.page(at: pageIndex + 1), let dict = page.dictionary else { return 0 }
    var annots: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(dict, "Annots", &annots), let list = annots else { return 0 }
    var found = 0
    for i in 0..<CGPDFArrayGetCount(list) {
      var a: CGPDFDictionaryRef?
      guard CGPDFArrayGetDictionary(list, i, &a), let annot = a else { continue }
      var nm: CGPDFStringRef?
      guard CGPDFDictionaryGetString(annot, "SKFill", &nm), let s = nm,
            let name = CGPDFStringCopyTextString(s) as String?, name.hasPrefix(prefix) else { continue }
      var ap: CGPDFDictionaryRef?
      var normal: CGPDFStreamRef?
      guard CGPDFDictionaryGetDictionary(annot, "AP", &ap), let apd = ap,
            CGPDFDictionaryGetStream(apd, "N", &normal), let stream = normal else { continue }
      var format = CGPDFDataFormat.raw
      guard let data = CGPDFStreamCopyData(stream, &format), CFDataGetLength(data) > 8 else { continue }
      found += 1
    }
    return found
  }
}

/// An addition (text, check mark, cross, signature): a Stamp annotation whose
/// appearance PDFKit records from `draw` when the document is written. Drawn
/// in the annotation's own box, turned against the page's rotation so it reads
/// upright on screen and on paper.
final class FillMark: PDFAnnotation {
  var kind = "text"
  var text = ""
  var fontSize: CGFloat = 12
  var ink: CGColor = CGColor(red: 0.07, green: 0.07, blue: 0.07, alpha: 1)
  var image: CGImage?
  var pageRotation = 0

  override func draw(with box: PDFDisplayBox, in context: CGContext) {
    let b = bounds
    let turned = pageRotation % 180 != 0
    let w = turned ? b.height : b.width
    let h = turned ? b.width : b.height
    context.saveGState()
    // The page is shown turned clockwise by its rotation: turn this the other way.
    context.translateBy(x: b.midX, y: b.midY)
    context.rotate(by: CGFloat(pageRotation) * .pi / 180)
    let r = CGRect(x: -w / 2, y: -h / 2, width: w, height: h)
    switch kind {
    case "text": drawText(in: r, context)
    case "check": drawCheck(in: r, context)
    case "cross": drawCross(in: r, context)
    case "image":
      if let img = image {
        context.interpolationQuality = .high
        context.draw(img, in: r)
      }
    default: break
    }
    context.restoreGState()
  }

  private func drawText(in r: CGRect, _ context: CGContext) {
    let font = CTFontCreateWithName("Helvetica" as CFString, fontSize, nil)
    let ascent = CTFontGetAscent(font)
    let descent = CTFontGetDescent(font)
    let leading = CTFontGetLeading(font)
    let lineHeight = ascent + descent + leading
    let attrs: [NSAttributedString.Key: Any] = [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): ink,
    ]
    context.textMatrix = .identity
    var y = r.maxY - ascent
    for line in text.components(separatedBy: "\n") {
      let ct = CTLineCreateWithAttributedString(NSAttributedString(string: line, attributes: attrs))
      context.textPosition = CGPoint(x: r.minX, y: y)
      CTLineDraw(ct, context)
      y -= lineHeight
    }
  }

  private func drawCheck(in r: CGRect, _ context: CGContext) {
    let s = min(r.width, r.height)
    context.setStrokeColor(ink)
    context.setLineWidth(max(0.5, s * 0.13))
    context.setLineCap(.round)
    context.setLineJoin(.round)
    // Points as fractions of the box, y up.
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: r.minX + x * r.width, y: r.minY + y * r.height) }
    context.move(to: p(0.16, 0.52))
    context.addLine(to: p(0.40, 0.24))
    context.addLine(to: p(0.86, 0.80))
    context.strokePath()
  }

  private func drawCross(in r: CGRect, _ context: CGContext) {
    let s = min(r.width, r.height)
    context.setStrokeColor(ink)
    context.setLineWidth(max(0.5, s * 0.13))
    context.setLineCap(.round)
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: r.minX + x * r.width, y: r.minY + y * r.height) }
    context.move(to: p(0.2, 0.2))
    context.addLine(to: p(0.8, 0.8))
    context.move(to: p(0.2, 0.8))
    context.addLine(to: p(0.8, 0.2))
    context.strokePath()
  }
}

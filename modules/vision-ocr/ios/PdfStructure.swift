import CoreGraphics
import Foundation
import PDFKit

/// What PDFKit doesn't say about a PDF, read with Core Graphics (an
/// independent parser), and the two things Scan Kit fixes up after PDFKit
/// writes a file: its permissions (checked never to widen) and its form's
/// /NeedAppearances flag.
enum PdfStructure {
  // MARK: Permissions

  /// The permission bits of an encrypted PDF as PDFKit reports them, or nil
  /// for an unencrypted one (which allows everything).
  static func permissionBits(_ doc: PDFDocument) -> UInt? {
    doc.isEncrypted ? doc.accessPermissions.rawValue : nil
  }

  /// nil when `written` allows nothing that `source` didn't; else what it
  /// widened, for the log. An unencrypted source allows everything, so any
  /// result is fine; an encrypted source must stay encrypted, and no
  /// permission may go from off to on (the author's restrictions are never
  /// loosened by an edit).
  static func widenedPermissions(source: PDFDocument, written: PDFDocument) -> String? {
    guard source.isEncrypted else { return nil }
    guard written.isEncrypted else { return "encryption removed" }
    let was = source.accessPermissions.rawValue
    let now = written.accessPermissions.rawValue
    if now & ~was != 0 { return "permission bits \(was) -> \(now)" }
    let pairs: [(String, Bool, Bool)] = [
      ("printing", source.allowsPrinting, written.allowsPrinting),
      ("copying", source.allowsCopying, written.allowsCopying),
      ("assembly", source.allowsDocumentAssembly, written.allowsDocumentAssembly),
      ("changes", source.allowsDocumentChanges, written.allowsDocumentChanges),
      ("commenting", source.allowsCommenting, written.allowsCommenting),
      ("forms", source.allowsFormFieldEntry, written.allowsFormFieldEntry),
      ("accessibility", source.allowsContentAccessibility, written.allowsContentAccessibility),
    ]
    for (name, before, after) in pairs where after && !before { return name }
    return nil
  }

  // MARK: Form facts (digital signatures, XFA)

  struct FormFacts {
    /// A signature field holds a signature (/V): changing the file invalidates it.
    var signed = false
    /// Certified (an author signature with DocMDP, /Perms in the catalog).
    var certified = false
    /// An XFA form: Acrobat shows the XFA layer; other readers (and Scan Kit)
    /// only the AcroForm fields, if it has any.
    var xfa = false
  }

  static func catalogAcroForm(_ cg: CGPDFDocument) -> CGPDFDictionaryRef? {
    guard let catalog = cg.catalog else { return nil }
    var form: CGPDFDictionaryRef?
    return CGPDFDictionaryGetDictionary(catalog, "AcroForm", &form) ? form : nil
  }

  static func formFacts(path: String) -> FormFacts {
    guard let cg = CGPDFDocument(URL(fileURLWithPath: path) as CFURL), cg.isUnlocked else { return FormFacts() }
    return formFacts(cg)
  }

  static func formFacts(_ cg: CGPDFDocument) -> FormFacts {
    var facts = FormFacts()
    if let catalog = cg.catalog {
      var perms: CGPDFDictionaryRef?
      var mdp: CGPDFObjectRef?
      if CGPDFDictionaryGetDictionary(catalog, "Perms", &perms), let p = perms,
         CGPDFDictionaryGetObject(p, "DocMDP", &mdp) {
        facts.certified = true
        facts.signed = true
      }
    }
    guard let form = catalogAcroForm(cg) else { return facts }
    var xfa: CGPDFObjectRef?
    if CGPDFDictionaryGetObject(form, "XFA", &xfa), let x = xfa, CGPDFObjectGetType(x) != .null {
      facts.xfa = true
    }
    var fields: CGPDFArrayRef?
    if CGPDFDictionaryGetArray(form, "Fields", &fields), let list = fields {
      var budget = 5000 // a malformed tree must not run forever
      for i in 0..<CGPDFArrayGetCount(list) {
        var f: CGPDFDictionaryRef?
        if CGPDFArrayGetDictionary(list, i, &f), let field = f,
           hasSignedField(field, inheritedSig: false, depth: 0, budget: &budget) {
          facts.signed = true
          break
        }
      }
    }
    // Some writers only set /SigFlags (bit 1: signatures exist) and keep the
    // signature widgets out of /Fields; look at the pages' widgets too.
    if !facts.signed {
      var budget = 5000
      outer: for n in stride(from: 1, through: cg.numberOfPages, by: 1) {
        guard let dict = cg.page(at: n)?.dictionary else { continue }
        var annots: CGPDFArrayRef?
        guard CGPDFDictionaryGetArray(dict, "Annots", &annots), let list = annots else { continue }
        for i in 0..<CGPDFArrayGetCount(list) {
          var a: CGPDFDictionaryRef?
          if CGPDFArrayGetDictionary(list, i, &a), let annot = a,
             hasSignedField(annot, inheritedSig: false, depth: 0, budget: &budget) {
            facts.signed = true
            break outer
          }
        }
      }
    }
    return facts
  }

  /// A /FT /Sig field (type inherited from its parents) with a value, here or below.
  static func hasSignedField(_ field: CGPDFDictionaryRef, inheritedSig: Bool, depth: Int, budget: inout Int) -> Bool {
    budget -= 1
    guard budget > 0, depth < 32 else { return false }
    var ft: UnsafePointer<CChar>?
    var isSig = inheritedSig
    if CGPDFDictionaryGetName(field, "FT", &ft), let name = ft { isSig = String(cString: name) == "Sig" }
    if isSig {
      var v: CGPDFObjectRef?
      if CGPDFDictionaryGetObject(field, "V", &v), let value = v, CGPDFObjectGetType(value) != .null { return true }
    }
    var kids: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(field, "Kids", &kids), let list = kids else { return false }
    for i in 0..<CGPDFArrayGetCount(list) {
      var k: CGPDFDictionaryRef?
      if CGPDFArrayGetDictionary(list, i, &k), let kid = k,
         hasSignedField(kid, inheritedSig: isSig, depth: depth + 1, budget: &budget) { return true }
    }
    return false
  }

  // MARK: Form appearances (/NeedAppearances)

  /// True when every visible widget on every page has a normal appearance
  /// for its current state, so a reader can draw the form as written.
  static func everyWidgetHasAppearance(_ cg: CGPDFDocument) -> Bool {
    for n in stride(from: 1, through: cg.numberOfPages, by: 1) {
      guard let dict = cg.page(at: n)?.dictionary else { return false }
      var annots: CGPDFArrayRef?
      guard CGPDFDictionaryGetArray(dict, "Annots", &annots), let list = annots else { continue }
      for i in 0..<CGPDFArrayGetCount(list) {
        var a: CGPDFDictionaryRef?
        guard CGPDFArrayGetDictionary(list, i, &a), let annot = a else { continue }
        var sub: UnsafePointer<CChar>?
        guard CGPDFDictionaryGetName(annot, "Subtype", &sub), let s = sub, String(cString: s) == "Widget" else { continue }
        var flags: CGPDFInteger = 0
        if CGPDFDictionaryGetInteger(annot, "F", &flags), flags & 2 != 0 { continue } // hidden
        var ap: CGPDFDictionaryRef?
        guard CGPDFDictionaryGetDictionary(annot, "AP", &ap), let apd = ap else { return false }
        var stream: CGPDFStreamRef?
        if CGPDFDictionaryGetStream(apd, "N", &stream) { continue }
        var states: CGPDFDictionaryRef?
        guard CGPDFDictionaryGetDictionary(apd, "N", &states), let st = states else { return false }
        var asName: UnsafePointer<CChar>?
        guard CGPDFDictionaryGetName(annot, "AS", &asName), let state = asName else { return false }
        let key = String(cString: state)
        // "Off" may legitimately have no appearance (nothing is drawn).
        if key != "Off" && !CGPDFDictionaryGetStream(st, key, &stream) { return false }
      }
    }
    return true
  }

  /// PDFKit writes /NeedAppearances true into every form it saves, so
  /// readers that honour it (poppler: Chrome on Linux, Android viewers,
  /// Evince; pdf.js) throw away the appearances PDFKit drew and rebuild
  /// their own from the field dictionaries: a chosen radio button comes out
  /// blank, a choice field shows its first option. When every widget has an
  /// appearance for its state, this sets the flag to false in place.
  ///
  /// The edit is the same number of bytes ("/NeedAppearances true " becomes
  /// "/NeedAppearances false", taking one whitespace byte), inside the
  /// AcroForm object located through the cross-reference table, so no
  /// offset moves and nothing else in the file changes (booleans are never
  /// encrypted). Anything unexpected (an xref stream, the flag not found in
  /// that object) leaves the file untouched. Returns true if it changed it.
  @discardableResult
  static func settleNeedAppearances(at url: URL) -> Bool {
    guard let cg = CGPDFDocument(url as CFURL), cg.isUnlocked, let form = catalogAcroForm(cg) else { return false }
    var need: CGPDFBoolean = 0
    guard CGPDFDictionaryGetBoolean(form, "NeedAppearances", &need), need != 0 else { return false }
    guard everyWidgetHasAppearance(cg) else { return false }
    guard var data = try? Data(contentsOf: url), let range = acroFormObjectRange(data) else { return false }
    guard let patched = patchNeedAppearances(data.subdata(in: range)), patched.count == range.count else { return false }
    data.replaceSubrange(range, with: patched)
    let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).na")
    do { try data.write(to: tmp) } catch { try? FileManager.default.removeItem(at: tmp); return false }
    // The patched file must read exactly as before, minus the flag.
    guard let check = CGPDFDocument(tmp as CFURL), check.isUnlocked, check.numberOfPages == cg.numberOfPages,
          let checkForm = catalogAcroForm(check) else {
      try? FileManager.default.removeItem(at: tmp)
      return false
    }
    var after: CGPDFBoolean = 1
    let has = CGPDFDictionaryGetBoolean(checkForm, "NeedAppearances", &after)
    guard !has || after == 0, rename(tmp.path, url.path) == 0 else {
      try? FileManager.default.removeItem(at: tmp)
      return false
    }
    return true
  }

  /// "/NeedAppearances<ws>true<ws>" -> "/NeedAppearances<ws>false", same length; nil if not exactly once.
  static func patchNeedAppearances(_ obj: Data) -> Data? {
    let bytes = [UInt8](obj)
    let key = Array("/NeedAppearances".utf8)
    var hits: [Int] = []
    var i = 0
    while i + key.count <= bytes.count {
      if bytes[i] == key[0] && Array(bytes[i..<(i + key.count)]) == key { hits.append(i) }
      i += 1
    }
    guard hits.count == 1, let start = hits.first else { return nil }
    func isSpace(_ b: UInt8) -> Bool { b == 0x20 || b == 0x0a || b == 0x0d || b == 0x09 || b == 0x0c }
    var j = start + key.count
    let wsStart = j
    while j < bytes.count, isSpace(bytes[j]) { j += 1 }
    let ws = Array(bytes[wsStart..<j])
    guard j + 4 <= bytes.count, Array(bytes[j..<(j + 4)]) == Array("true".utf8) else { return nil }
    let after = j + 4
    var out = Array(bytes[0..<start]) + key
    if after < bytes.count, isSpace(bytes[after]) {
      out += ws + Array("false".utf8) // the space after "true" is taken
      out += bytes[(after + 1)...]
    } else if ws.count >= 2 {
      out += Array(ws.dropLast()) + Array("false".utf8)
      out += bytes[after...]
    } else {
      return nil
    }
    return Data(out)
  }

  /// The byte range of the AcroForm object ("N 0 obj … endobj"; the catalog
  /// itself when the form is inline), found through a classic xref table.
  static func acroFormObjectRange(_ data: Data) -> Range<Int>? {
    let bytes = [UInt8](data)
    guard let sx = lastIndex(of: Array("startxref".utf8), in: bytes) else { return nil }
    guard let xrefAt = readInt(bytes, from: sx + 9)?.value, xrefAt >= 0, xrefAt < bytes.count else { return nil }
    guard bytes.count >= xrefAt + 4, Array(bytes[xrefAt..<(xrefAt + 4)]) == Array("xref".utf8) else { return nil }
    // Every xref section of the file, newest first (/Prev chain), so the newest entry wins.
    var offsets: [Int: Int] = [:]
    var sectionAt: Int? = xrefAt
    var rootNum: Int?
    var seen = Set<Int>()
    while let at = sectionAt, !seen.contains(at), at + 4 <= bytes.count, Array(bytes[at..<(at + 4)]) == Array("xref".utf8) {
      seen.insert(at)
      var p = at + 4
      while true {
        guard let first = readInt(bytes, from: p) else { return nil }
        if first.value < 0 { return nil }
        guard let count = readInt(bytes, from: first.end) else { break }
        p = count.end
        while p < bytes.count, bytes[p] == 0x20 || bytes[p] == 0x0a || bytes[p] == 0x0d { p += 1 }
        for k in 0..<count.value {
          let e = p + k * 20
          guard e + 18 <= bytes.count, let off = Int(String(decoding: bytes[e..<(e + 10)], as: UTF8.self)) else { return nil }
          if bytes[e + 17] == UInt8(ascii: "n"), offsets[first.value + k] == nil { offsets[first.value + k] = off }
        }
        p += count.value * 20
        // Another subsection, or the trailer.
        var q = p
        while q < bytes.count, bytes[q] == 0x20 || bytes[q] == 0x0a || bytes[q] == 0x0d { q += 1 }
        if q + 7 <= bytes.count, Array(bytes[q..<(q + 7)]) == Array("trailer".utf8) { p = q + 7; break }
        p = q
      }
      guard let end = firstIndex(of: Array("startxref".utf8), in: bytes, from: p) ?? Optional(bytes.count) else { return nil }
      let trailer = String(decoding: bytes[p..<min(end, bytes.count)], as: UTF8.self)
      if rootNum == nil { rootNum = refNumber(after: "/Root", in: trailer) }
      sectionAt = refNumberPlain(after: "/Prev", in: trailer)
    }
    guard let root = rootNum, let rootAt = offsets[root], let rootRange = objectRange(bytes, at: rootAt, number: root) else { return nil }
    let catalog = String(decoding: bytes[rootRange], as: UTF8.self)
    if let formNum = refNumber(after: "/AcroForm", in: catalog) {
      guard let at = offsets[formNum] else { return nil }
      return objectRange(bytes, at: at, number: formNum)
    }
    return catalog.contains("/AcroForm") ? rootRange : nil
  }

  private static func objectRange(_ bytes: [UInt8], at: Int, number: Int) -> Range<Int>? {
    let head = Array("\(number) 0 obj".utf8)
    guard at + head.count <= bytes.count, Array(bytes[at..<(at + head.count)]) == head,
          let end = firstIndex(of: Array("endobj".utf8), in: bytes, from: at) else { return nil }
    // A stream object is never the catalog or the AcroForm.
    if firstIndex(of: Array("stream".utf8), in: Array(bytes[at..<end]), from: 0) != nil { return nil }
    return at..<end
  }

  /// "N 0 R" right after `key` in `text`.
  private static func refNumber(after key: String, in text: String) -> Int? {
    guard let r = text.range(of: key) else { return nil }
    let rest = text[r.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
    let parts = rest.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\r" }).prefix(3)
    guard parts.count == 3, parts[parts.startIndex + 2].hasPrefix("R"), let n = Int(parts[parts.startIndex]) else { return nil }
    return n
  }

  private static func refNumberPlain(after key: String, in text: String) -> Int? {
    guard let r = text.range(of: key) else { return nil }
    let rest = text[r.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
    return Int(rest.prefix(while: { $0.isNumber }))
  }

  private static func readInt(_ bytes: [UInt8], from: Int) -> (value: Int, end: Int)? {
    var p = from
    while p < bytes.count, bytes[p] == 0x20 || bytes[p] == 0x0a || bytes[p] == 0x0d || bytes[p] == 0x09 { p += 1 }
    let start = p
    while p < bytes.count, bytes[p] >= 0x30 && bytes[p] <= 0x39 { p += 1 }
    guard p > start, let v = Int(String(decoding: bytes[start..<p], as: UTF8.self)) else { return nil }
    return (v, p)
  }

  private static func firstIndex(of needle: [UInt8], in hay: [UInt8], from: Int) -> Int? {
    guard !needle.isEmpty, hay.count >= needle.count else { return nil }
    var i = max(0, from)
    while i + needle.count <= hay.count {
      if hay[i] == needle[0] && Array(hay[i..<(i + needle.count)]) == needle { return i }
      i += 1
    }
    return nil
  }

  private static func lastIndex(of needle: [UInt8], in hay: [UInt8]) -> Int? {
    guard hay.count >= needle.count else { return nil }
    var i = hay.count - needle.count
    while i >= 0 {
      if hay[i] == needle[0] && Array(hay[i..<(i + needle.count)]) == needle { return i }
      i -= 1
    }
    return nil
  }
}

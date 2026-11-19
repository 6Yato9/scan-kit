import Compression
import CoreGraphics
import Foundation
import PDFKit

/// "Remove restrictions" (Tools, round 13b): what a PDF's author forbids
/// (printing, copying, page changes, comments, forms…), and an unencrypted
/// copy of it with every restriction gone.
///
/// The copy keeps the PDF a PDF: pages are never redrawn, so text stays
/// selectable and searchable, and form fields, annotations, links and
/// bookmarks come with it. Written in the first way that verifies:
///
///  1. A structural rewrite (`Rewriter`), what `qpdf --decrypt` does: every
///     object reachable from the document catalog is written out again with
///     CoreGraphics' decrypted values (strings as they are, streams decoded
///     and deflated again, JPEG and JPEG 2000 images byte for byte), keeping
///     the file's own structure: form fields stay linked to their widgets,
///     page labels, named destinations, tags and metadata stay. The
///     catalog's /Perms (DocMDP / usage-rights signatures, which restrict
///     changes too and can't verify after any rewrite) is left out.
///  2. PDFKit's plain write. It drops the encryption of an AES-256 (R6) file
///     that opened without a password (it re-encrypts older RC4 / AES-128
///     files with their own key, so it can't be the only way), but it
///     re-creates the form: qpdf then finds widgets the /AcroForm no longer
///     reaches. Good enough as a fallback; PDFKit itself reads it fine.
///  3. Last resort: encrypted, but with every permission granted and no
///     password to open (`encrypted: true` in the result).
///
/// Each attempt is read back and checked against the original before it is
/// accepted: unlocked, same page count, the same text on every page, the same
/// annotations per page, the same number of form fields and bookmarks, and
/// for the rewrite the same look (pages rendered small and compared).
/// A PDF that needs a password is opened with `password` first; the copy
/// never has one.
enum PdfUnrestrict {
  static let lockedMessage = "locked"
  static let wrongPasswordMessage = "wrong-password"

  static func fail(_ code: Int, _ message: String) -> NSError {
    NSError(domain: "PdfUnrestrict", code: code, userInfo: [NSLocalizedDescriptionKey: message])
  }

  // MARK: Reading the restrictions

  /// The eight permission bits PDFKit reports (PDFAccessPermissions).
  static func permissions(_ doc: PDFDocument) -> [String: Bool] {
    let raw = doc.accessPermissions.rawValue
    func bit(_ n: UInt) -> Bool { raw & (1 << n) != 0 }
    return [
      "printLow": bit(0),
      "printHigh": bit(1),
      "changeContent": bit(2),
      "assemblePages": bit(3),
      "copy": bit(4),
      "accessibility": bit(5),
      "comment": bit(6),
      "fillForms": bit(7),
    ]
  }

  /// { pageCount, encrypted, locked, passwordAccepted, permissions }.
  /// `locked`: it still needs a password (none given, or `password` didn't
  /// open it; `passwordAccepted` tells which). Permissions are those of the
  /// unlocked document, all false while it is locked.
  static func info(path: String, password: String?) throws -> [String: Any] {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { throw fail(1, "Could not open the PDF") }
    var locked = doc.isLocked
    var accepted = false
    if locked, let pw = password, !pw.isEmpty, doc.unlock(withPassword: pw) {
      locked = false
      accepted = true
    }
    let none = ["printLow", "printHigh", "changeContent", "assemblePages", "copy", "accessibility", "comment", "fillForms"]
      .reduce(into: [String: Bool]()) { $0[$1] = false }
    var result: [String: Any] = [
      "pageCount": doc.pageCount,
      "encrypted": doc.isEncrypted,
      "locked": locked,
      "passwordAccepted": accepted,
      // An unencrypted PDF has no restrictions: PDFKit reports every bit set.
      "permissions": locked ? none : permissions(doc),
    ]
    // Round 14 (lib/pdf-session.ts keeps a protected PDF protected through
    // edits): which password opened it, and the author's exact permission
    // bits to write back (PdfProtector.protectKeeping).
    if accepted, let pw = password {
      let owner = doc.permissionsStatus == .owner
      let standard = PdfPasswordCheck.standard(path: path)
      result["ownerUnlocked"] = owner
      // Owner status also comes with user = owner (Scan Kit's own Protect PDF):
      // whether the password is ALSO the open password.
      if !owner {
        result["userPassword"] = true
      } else if let s = standard, let isUser = PdfPasswordCheck.check(s, password: pw) {
        result["userPassword"] = isUser
      } else {
        result["userPassword"] = NSNull() // unknown: treated as the owner password only
      }
      result["permissionBits"] = Int(standard.map { PdfPasswordCheck.permissionBits($0) } ?? doc.accessPermissions.rawValue)
    }
    return result
  }

  // MARK: Writing the unrestricted copy

  /// Writes the copy to `outputPath`; resolves { pageCount, encrypted, method }.
  /// Throws "locked" when a password is needed and none was given,
  /// "wrong-password" when `password` doesn't open it.
  static func unrestrict(inputPath: String, outputPath: String, password: String?) throws -> [String: Any] {
    let inURL = URL(fileURLWithPath: inputPath)
    guard let doc = PDFDocument(url: inURL) else { throw fail(1, "Could not open the PDF") }
    if doc.isLocked {
      guard let pw = password, !pw.isEmpty else { throw fail(2, lockedMessage) }
      guard doc.unlock(withPassword: pw) else { throw fail(3, wrongPasswordMessage) }
    }
    guard doc.pageCount > 0 else { throw fail(4, "The PDF has no pages") }
    let expected = Fingerprint(doc: doc, cg: CGPDFDocument(inURL as CFURL), password: password)

    let out = URL(fileURLWithPath: outputPath)
    let tmp = out.deletingLastPathComponent()
      .appendingPathComponent(".unrestrict-\(UUID().uuidString).pdf")
    defer { try? FileManager.default.removeItem(at: tmp) }
    func accept(_ method: String, encrypted: Bool) throws -> [String: Any] {
      try? FileManager.default.removeItem(at: out)
      try FileManager.default.moveItem(at: tmp, to: out)
      return ["pageCount": doc.pageCount, "encrypted": encrypted, "method": method]
    }

    // 1. Structural rewrite from CoreGraphics' decrypted objects.
    try? FileManager.default.removeItem(at: tmp)
    if let cg = CGPDFDocument(inURL as CFURL) {
      if !cg.isUnlocked, let pw = password { _ = cg.unlockWithPassword(pw) }
      if cg.isUnlocked {
        let written = (try? autoreleasepool { try Rewriter(doc: cg).write(to: tmp) }) != nil
        if written, expected.matches(tmp, requireClear: true, compareLook: true) {
          return try accept("rewrite", encrypted: false)
        }
      }
    }

    // 2. PDFKit's own write.
    try? FileManager.default.removeItem(at: tmp)
    if autoreleasepool(invoking: { doc.write(to: tmp) }),
       expected.matches(tmp, requireClear: true, compareLook: false) {
      return try accept("pdfkit", encrypted: false)
    }

    // 3. Every permission granted, no password to open.
    try? FileManager.default.removeItem(at: tmp)
    let options: [PDFDocumentWriteOption: Any] = [
      .ownerPasswordOption: UUID().uuidString + UUID().uuidString,
      .accessPermissionsOption: NSNumber(value: UInt(255)),
    ]
    if autoreleasepool(invoking: { doc.write(to: tmp, withOptions: options) }),
       expected.matches(tmp, requireClear: false, compareLook: false) {
      return try accept("permissions", encrypted: true)
    }
    throw fail(5, "Could not write an unrestricted copy")
  }

  // MARK: Verification

  /// What the copy must still have.
  struct Fingerprint {
    let pageCount: Int
    let texts: [String]
    let annotations: [Int]
    let fields: Int
    let bookmarks: Int
    let looks: [[UInt8]]

    init(doc: PDFDocument, cg: CGPDFDocument?, password: String?) {
      pageCount = doc.pageCount
      texts = (0..<doc.pageCount).map { Fingerprint.norm(doc.page(at: $0)?.string) }
      annotations = (0..<doc.pageCount).map { doc.page(at: $0)?.annotations.count ?? 0 }
      bookmarks = Fingerprint.count(doc.outlineRoot)
      if let cg, !cg.isUnlocked, let pw = password { _ = cg.unlockWithPassword(pw) }
      fields = cg.map(Fingerprint.fieldCount) ?? 0
      looks = cg.map(Fingerprint.looks) ?? []
    }

    static func norm(_ s: String?) -> String {
      (s ?? "").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    static func count(_ outline: PDFOutline?) -> Int {
      guard let outline else { return 0 }
      var n = 0
      for i in 0..<outline.numberOfChildren {
        n += 1 + count(outline.child(at: i))
      }
      return n
    }

    /// Top-level entries of the catalog's /AcroForm /Fields (-1: no AcroForm).
    static func fieldCount(_ doc: CGPDFDocument) -> Int {
      guard let catalog = doc.catalog else { return -1 }
      var form: CGPDFDictionaryRef?
      guard CGPDFDictionaryGetDictionary(catalog, "AcroForm", &form), let form else { return -1 }
      var fields: CGPDFArrayRef?
      guard CGPDFDictionaryGetArray(form, "Fields", &fields), let fields else { return 0 }
      return CGPDFArrayGetCount(fields)
    }

    /// Pages' content drawn small in grey (up to 24, spread over the
    /// document): catches a rewrite that decoded an image or a font wrongly.
    static func looks(_ doc: CGPDFDocument) -> [[UInt8]] {
      let n = doc.numberOfPages
      guard n > 0 else { return [] }
      let picks = n <= 24 ? Array(1...n) : (0..<24).map { 1 + $0 * (n - 1) / 23 }
      return picks.map { i in autoreleasepool { look(doc.page(at: i)) } }
    }

    static let side = 48
    static func look(_ page: CGPDFPage?) -> [UInt8] {
      var px = [UInt8](repeating: 255, count: side * side)
      guard let page else { return px }
      px.withUnsafeMutableBytes { buf in
        guard let ctx = CGContext(data: buf.baseAddress, width: side, height: side, bitsPerComponent: 8,
                                  bytesPerRow: side, space: CGColorSpaceCreateDeviceGray(),
                                  bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: side, height: side))
        let rect = CGRect(x: 0, y: 0, width: side, height: side)
        ctx.concatenate(page.getDrawingTransform(.cropBox, rect: rect, rotate: 0, preserveAspectRatio: true))
        ctx.clip(to: page.getBoxRect(.cropBox))
        ctx.drawPDFPage(page)
      }
      return px
    }

    func matches(_ url: URL, requireClear: Bool, compareLook: Bool) -> Bool {
      guard let doc = PDFDocument(url: url), !doc.isLocked, doc.pageCount == pageCount else { return false }
      if requireClear && doc.isEncrypted { return false }
      if !requireClear && doc.accessPermissions.rawValue & 255 != 255 { return false }
      for i in 0..<pageCount {
        guard let page = doc.page(at: i) else { return false }
        // A PDF that forbids copying may give PDFKit no text to compare.
        if !texts[i].isEmpty && Fingerprint.norm(page.string) != texts[i] { return false }
        if page.annotations.count != annotations[i] { return false }
      }
      if Fingerprint.count(doc.outlineRoot) != bookmarks { return false }
      guard let cg = CGPDFDocument(url as CFURL), cg.isUnlocked else { return false }
      if Fingerprint.fieldCount(cg) != fields { return false }
      if compareLook {
        let after = Fingerprint.looks(cg)
        guard after.count == looks.count else { return false }
        for (a, b) in zip(looks, after) {
          var total = 0
          for k in 0..<a.count { total += abs(Int(a[k]) - Int(b[k])) }
          // Mean difference per pixel: antialiasing noise is well under 2.
          if total > a.count * 4 { return false }
        }
      }
      return true
    }
  }

  // MARK: Structural rewrite

  /// Writes every object reachable from the catalog (and the Info
  /// dictionary) as an unencrypted PDF. Containers referenced more than once
  /// (or that must be: pages, annotations, form fields) become indirect
  /// objects; the rest stay inline. CoreGraphics caches each parsed object,
  /// so the same object always has the same pointer.
  final class Rewriter {
    private let doc: CGPDFDocument
    private var handle: FileHandle?
    private var position = 0
    private var buffer = Data()
    private var refCount: [OpaquePointer: Int] = [:]
    private var forced = Set<OpaquePointer>()
    private var numbers: [OpaquePointer: Int] = [:]
    private var queue: [CGPDFObjectRef] = []
    private var offsets: [Int] = [0]
    private var root: OpaquePointer?
    private var infoPtr: OpaquePointer?
    /// Keys whose array elements are written as indirect objects.
    private static let indirectElements: Set<String> = ["Kids", "Annots", "Fields"]
    /// Values written as indirect objects.
    private static let indirectValues: Set<String> = ["Parent", "P", "Popup", "IRT", "First", "Last", "Next", "Prev"]
    /// Stream dictionary keys rewritten for the new data.
    private static let streamSkip: Set<String> = ["Length", "Filter", "DecodeParms", "DL", "F", "FFilter", "FDecodeParms"]

    init(doc: CGPDFDocument) { self.doc = doc }

    /// One identity for dictionaries, arrays and streams (their refs are pointer wrappers).
    static func raw<T>(_ ref: T) -> OpaquePointer { unsafeBitCast(ref, to: OpaquePointer.self) }

    func write(to url: URL) throws {
      guard let catalog = doc.catalog else { throw PdfUnrestrict.fail(10, "No catalog") }
      FileManager.default.createFile(atPath: url.path, contents: nil)
      handle = try FileHandle(forWritingTo: url)
      defer { try? handle?.close() }

      root = Rewriter.raw(catalog)
      infoPtr = doc.info.map { Rewriter.raw($0) }
      count(container: Rewriter.raw(catalog), kind: .dictionary)
      if let info = infoPtr { count(container: info, kind: .dictionary) }

      var major: Int32 = 1, minor: Int32 = 7
      doc.getVersion(majorVersion: &major, minorVersion: &minor)
      if major < 1 || (major == 1 && minor < 4) { major = 1; minor = 4 }
      emit("%PDF-\(major).\(minor)\n%\u{E2}\u{E3}\u{CF}\u{D3}\n".data(using: .isoLatin1)!)

      let rootNumber = number(for: Rewriter.raw(catalog), object: nil, dictionary: catalog)
      let infoNumber = infoPtr.map { number(for: $0, object: nil, dictionary: doc.info) }
      while !pendingDicts.isEmpty || !queue.isEmpty {
        try autoreleasepool {
          if !pendingDicts.isEmpty {
            let (num, dict) = pendingDicts.removeFirst()
            try startObject(num)
            writeDictionary(dict, isCatalog: Rewriter.raw(dict) == root)
            try endObject()
          } else {
            let obj = queue.removeFirst()
            try writeIndirect(obj)
          }
        }
      }

      try flush()
      let xref = position
      var table = "xref\n0 \(offsets.count)\n0000000000 65535 f \n"
      for off in offsets.dropFirst() { table += String(format: "%010d 00000 n \n", off) }
      table += "trailer\n<< /Size \(offsets.count) /Root \(rootNumber) 0 R"
      if let infoNumber { table += " /Info \(infoNumber) 0 R" }
      if let ids = doc.fileIdentifier, CGPDFArrayGetCount(ids) == 2 {
        var parts: [String] = []
        for i in 0..<2 {
          var s: CGPDFStringRef?
          if CGPDFArrayGetString(ids, i, &s), let s { parts.append(hex(s)) }
        }
        if parts.count == 2 { table += " /ID [\(parts[0]) \(parts[1])]" }
      }
      table += " >>\nstartxref\n\(xref)\n%%EOF\n"
      emit(Data(table.utf8))
      try flush()
    }

    // Pass 1: how many times each container is referenced.

    private enum Kind { case dictionary, array, stream }

    private func count(container: OpaquePointer, kind: Kind) {
      var stack: [(OpaquePointer, Kind, String?)] = [(container, kind, nil)]
      refCount[container, default: 0] += 1
      while let (ptr, kind, _) = stack.popLast() {
        func visit(_ obj: CGPDFObjectRef, key: String?, element: Bool) {
          guard let (child, childKind) = Rewriter.container(obj) else { return }
          refCount[child, default: 0] += 1
          if element || (key.map { Rewriter.indirectValues.contains($0) } ?? false) { forced.insert(child) }
          if refCount[child] == 1 { stack.append((child, childKind, key)) }
        }
        switch kind {
        case .dictionary, .stream:
          let dict = kind == .stream
            ? CGPDFStreamGetDictionary(unsafeBitCast(ptr, to: CGPDFStreamRef.self))
            : unsafeBitCast(ptr, to: CGPDFDictionaryRef.self)
          guard let dict else { continue }
          CGPDFDictionaryApplyBlock(dict, { key, value, _ in
            let k = String(cString: key)
            if kind == .stream && Rewriter.streamSkip.contains(k) { return true }
            if ptr == self.root && k == "Perms" { return true }
            if Rewriter.indirectElements.contains(k), let arr = Rewriter.array(value) {
              let a = Rewriter.raw(arr)
              self.refCount[a, default: 0] += 1
              if self.refCount[a] == 1 {
                for i in 0..<CGPDFArrayGetCount(arr) {
                  var el: CGPDFObjectRef?
                  if CGPDFArrayGetObject(arr, i, &el), let el { visit(el, key: k, element: true) }
                }
              }
              return true
            }
            visit(value, key: k, element: false)
            return true
          }, nil)
        case .array:
          let arr = unsafeBitCast(ptr, to: CGPDFArrayRef.self)
          for i in 0..<CGPDFArrayGetCount(arr) {
            var el: CGPDFObjectRef?
            if CGPDFArrayGetObject(arr, i, &el), let el { visit(el, key: nil, element: false) }
          }
        }
      }
    }

    private static func container(_ obj: CGPDFObjectRef) -> (OpaquePointer, Kind)? {
      switch CGPDFObjectGetType(obj) {
      case .dictionary:
        var d: CGPDFDictionaryRef?
        return CGPDFObjectGetValue(obj, .dictionary, &d) && d != nil ? (raw(d!), .dictionary) : nil
      case .array:
        var a: CGPDFArrayRef?
        return CGPDFObjectGetValue(obj, .array, &a) && a != nil ? (raw(a!), .array) : nil
      case .stream:
        var s: CGPDFStreamRef?
        return CGPDFObjectGetValue(obj, .stream, &s) && s != nil ? (raw(s!), .stream) : nil
      default:
        return nil
      }
    }

    private static func array(_ obj: CGPDFObjectRef) -> CGPDFArrayRef? {
      var a: CGPDFArrayRef?
      return CGPDFObjectGetValue(obj, .array, &a) ? a : nil
    }

    private func isIndirect(_ ptr: OpaquePointer, kind: Kind) -> Bool {
      kind == .stream || ptr == root || ptr == infoPtr || forced.contains(ptr) || (refCount[ptr] ?? 0) > 1
    }

    // Pass 2: writing.

    /// Catalog and Info have no CGPDFObjectRef of their own.
    private var pendingDicts: [(Int, CGPDFDictionaryRef)] = []

    private func number(for ptr: OpaquePointer, object: CGPDFObjectRef?, dictionary: CGPDFDictionaryRef? = nil) -> Int {
      if let n = numbers[ptr] { return n }
      let n = offsets.count
      offsets.append(0)
      numbers[ptr] = n
      if let object { queue.append(object) } else if let dictionary { pendingDicts.append((n, dictionary)) }
      return n
    }

    private func startObject(_ num: Int) throws {
      try flushIfLarge()
      offsets[num] = position + buffer.count
      emit("\(num) 0 obj\n")
    }

    private func endObject() throws {
      emit("\nendobj\n")
      try flushIfLarge()
    }

    private func writeIndirect(_ obj: CGPDFObjectRef) throws {
      guard let (ptr, kind) = Rewriter.container(obj), let num = numbers[ptr] else { return }
      try startObject(num)
      switch kind {
      case .dictionary:
        var d: CGPDFDictionaryRef?
        _ = CGPDFObjectGetValue(obj, .dictionary, &d)
        if let d { writeDictionary(d, isCatalog: ptr == root) }
      case .array:
        var a: CGPDFArrayRef?
        _ = CGPDFObjectGetValue(obj, .array, &a)
        if let a { writeArray(a) }
      case .stream:
        var s: CGPDFStreamRef?
        _ = CGPDFObjectGetValue(obj, .stream, &s)
        if let s { try writeStream(s) }
      }
      try endObject()
    }

    private func writeValue(_ obj: CGPDFObjectRef) {
      switch CGPDFObjectGetType(obj) {
      case .null:
        emit("null")
      case .boolean:
        var b: CGPDFBoolean = 0
        _ = CGPDFObjectGetValue(obj, .boolean, &b)
        emit(b != 0 ? "true" : "false")
      case .integer:
        var i: CGPDFInteger = 0
        _ = CGPDFObjectGetValue(obj, .integer, &i)
        emit(String(i))
      case .real:
        var r: CGPDFReal = 0
        _ = CGPDFObjectGetValue(obj, .real, &r)
        emit(Rewriter.real(Double(r)))
      case .name:
        var n: UnsafePointer<CChar>?
        _ = CGPDFObjectGetValue(obj, .name, &n)
        emit(n.map { Rewriter.name(String(cString: $0)) } ?? "null")
      case .string:
        var s: CGPDFStringRef?
        _ = CGPDFObjectGetValue(obj, .string, &s)
        emit(s.map(hex) ?? "()")
      case .dictionary, .array, .stream:
        guard let (ptr, kind) = Rewriter.container(obj) else { emit("null"); return }
        if isIndirect(ptr, kind: kind) {
          emit("\(number(for: ptr, object: obj)) 0 R")
        } else if kind == .dictionary {
          var d: CGPDFDictionaryRef?
          _ = CGPDFObjectGetValue(obj, .dictionary, &d)
          if let d { writeDictionary(d, isCatalog: false) } else { emit("null") }
        } else {
          var a: CGPDFArrayRef?
          _ = CGPDFObjectGetValue(obj, .array, &a)
          if let a { writeArray(a) } else { emit("null") }
        }
      @unknown default:
        emit("null")
      }
    }

    private func writeDictionary(_ dict: CGPDFDictionaryRef, isCatalog: Bool) {
      emit("<<")
      writeEntries(dict, isCatalog: isCatalog, skip: [])
      emit(" >>")
    }

    private func writeEntries(_ dict: CGPDFDictionaryRef, isCatalog: Bool, skip: Set<String>) {
      CGPDFDictionaryApplyBlock(dict, { key, value, _ in
        let k = String(cString: key)
        if skip.contains(k) || (isCatalog && k == "Perms") { return true }
        self.emit(" " + Rewriter.name(k) + " ")
        self.writeValue(value)
        return true
      }, nil)
    }

    private func writeArray(_ arr: CGPDFArrayRef) {
      emit("[")
      for i in 0..<CGPDFArrayGetCount(arr) {
        var el: CGPDFObjectRef?
        if i > 0 { emit(" ") }
        if CGPDFArrayGetObject(arr, i, &el), let el { writeValue(el) } else { emit("null") }
      }
      emit("]")
    }

    private func writeStream(_ stream: CGPDFStreamRef) throws {
      guard let dict = CGPDFStreamGetDictionary(stream) else { throw PdfUnrestrict.fail(11, "Stream without dictionary") }
      var format = CGPDFDataFormat.raw
      guard let cfData = CGPDFStreamCopyData(stream, &format) else { throw PdfUnrestrict.fail(12, "Unreadable stream") }
      let decoded = cfData as Data
      var body = decoded
      var filter: String?
      var keepParms: CGPDFObjectRef?
      switch format {
      case .jpegEncoded, .JPEG2000:
        filter = format == .jpegEncoded ? "/DCTDecode" : "/JPXDecode"
        keepParms = Rewriter.lastDecodeParms(dict)
      default:
        if decoded.count > 64, let z = Rewriter.zlib(decoded) {
          body = z
          filter = "/FlateDecode"
        }
      }
      emit("<<")
      writeEntries(dict, isCatalog: false, skip: Rewriter.streamSkip)
      emit(" /Length \(body.count)")
      if let filter { emit(" /Filter \(filter)") }
      if let keepParms {
        emit(" /DecodeParms ")
        writeValue(keepParms)
      }
      emit(" >>\nstream\n")
      emit(body)
      emit("\nendstream")
    }

    /// The DecodeParms of the last filter (a JPEG's /ColorTransform).
    private static func lastDecodeParms(_ dict: CGPDFDictionaryRef) -> CGPDFObjectRef? {
      var obj: CGPDFObjectRef?
      guard CGPDFDictionaryGetObject(dict, "DecodeParms", &obj), let obj else { return nil }
      if CGPDFObjectGetType(obj) == .dictionary { return obj }
      if let arr = array(obj), CGPDFArrayGetCount(arr) > 0 {
        var last: CGPDFObjectRef?
        if CGPDFArrayGetObject(arr, CGPDFArrayGetCount(arr) - 1, &last), let last,
           CGPDFObjectGetType(last) == .dictionary { return last }
      }
      return nil
    }

    // Output.

    private func emit(_ s: String) { buffer.append(contentsOf: Array(s.utf8)) }
    private func emit(_ d: Data) { buffer.append(d) }

    private func flushIfLarge() throws {
      if buffer.count > 1 << 20 { try flush() }
    }

    private func flush() throws {
      guard !buffer.isEmpty, let handle else { return }
      try handle.write(contentsOf: buffer)
      position += buffer.count
      buffer.removeAll(keepingCapacity: true)
    }

    // Encoding.

    private func hex(_ s: CGPDFStringRef) -> String {
      guard let bytes = CGPDFStringGetBytePtr(s) else { return "<>" }
      let n = CGPDFStringGetLength(s)
      var out = "<"
      out.reserveCapacity(n * 2 + 2)
      let digits = Array("0123456789ABCDEF")
      for i in 0..<n {
        out.append(digits[Int(bytes[i] >> 4)])
        out.append(digits[Int(bytes[i] & 0x0F)])
      }
      return out + ">"
    }

    static func name(_ s: String) -> String {
      var out = "/"
      for b in s.utf8 {
        let delimiter = "()<>[]{}/%#".utf8.contains(b)
        if b < 0x21 || b > 0x7E || delimiter {
          out += String(format: "#%02X", b)
        } else {
          out.append(Character(UnicodeScalar(b)))
        }
      }
      return out
    }

    static func real(_ v: Double) -> String {
      guard v.isFinite else { return "0" }
      if v == v.rounded() && abs(v) < 1e15 { return String(Int64(v)) }
      var s = String(format: "%.6f", v)
      while s.hasSuffix("0") { s.removeLast() }
      if s.hasSuffix(".") { s.removeLast() }
      return s == "-0" ? "0" : s
    }

    /// zlib (RFC 1950) data: a header, raw DEFLATE, the Adler-32 checksum.
    static func zlib(_ data: Data) -> Data? {
      let capacity = data.count + data.count / 8 + 1024
      var deflated = Data(count: capacity)
      let written = deflated.withUnsafeMutableBytes { dst -> Int in
        data.withUnsafeBytes { src -> Int in
          guard let d = dst.bindMemory(to: UInt8.self).baseAddress,
                let s = src.bindMemory(to: UInt8.self).baseAddress else { return 0 }
          return compression_encode_buffer(d, capacity, s, data.count, nil, COMPRESSION_ZLIB)
        }
      }
      guard written > 0 else { return nil }
      var a: UInt32 = 1, b: UInt32 = 0
      data.withUnsafeBytes { raw in
        let bytes = raw.bindMemory(to: UInt8.self)
        var i = 0
        while i < bytes.count {
          let end = min(i + 5552, bytes.count)
          while i < end { a += UInt32(bytes[i]); b += a; i += 1 }
          a %= 65521; b %= 65521
        }
      }
      var out = Data([0x78, 0x9C])
      out.append(deflated.prefix(written))
      let adler = (b << 16) | a
      out.append(contentsOf: [UInt8(adler >> 24), UInt8((adler >> 16) & 0xFF), UInt8((adler >> 8) & 0xFF), UInt8(adler & 0xFF)])
      return out
    }
  }
}

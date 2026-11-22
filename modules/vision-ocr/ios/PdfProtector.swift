import CommonCrypto
import CryptoKit
import Foundation
import PDFKit

/// Writes a password-protected copy of a PDF with PDFKit (AES encryption, iOS
/// handles the cipher). For a PDF without protection (scans, plain PDFs) the
/// same password is used for opening and for owner permissions, so nobody can
/// strip the protection without it.
///
/// A PDF that already has an owner password with restrictions (it opens
/// without a password but limits printing, copying or changes: a bank
/// statement) keeps them (owner decision, round 15; Android does the same):
/// writing user = owner = password would hand whoever knows the new open
/// password every right the author withheld. Its exact permissions
/// (PdfPasswordCheck.permissionBits, read from /P) are written under a new
/// random owner password with `password` to open it, through
/// `protectKeeping`, which reads the result back and refuses it if the open
/// password became an owner password or any permission widened.
enum PdfProtector {
  static func protect(inputPath: String, outputPath: String, password: String) throws {
    guard !password.isEmpty else {
      throw NSError(domain: "PdfProtector", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Password is empty"])
    }
    guard let doc = PDFDocument(url: URL(fileURLWithPath: inputPath)) else {
      throw NSError(domain: "PdfProtector", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Could not open the PDF"])
    }
    if doc.isEncrypted && !doc.isLocked {
      // Owner-password restrictions: keep the author's exact permissions.
      let bits = PdfPasswordCheck.standard(path: inputPath).map(PdfPasswordCheck.permissionBits)
        ?? doc.accessPermissions.rawValue
      try protectKeeping(inputPath: inputPath, outputPath: outputPath,
                         userPassword: password, ownerPassword: nil, permissions: bits)
      return
    }
    let options: [PDFDocumentWriteOption: Any] = [
      .userPasswordOption: password,
      .ownerPasswordOption: password,
    ]
    let out = URL(fileURLWithPath: outputPath)
    try? FileManager.default.removeItem(at: out)
    // PDFKit's write fails (leaving an empty file) for a password it can't
    // encode: anything outside ASCII (measured: "Café", "Łódź", emoji).
    guard doc.write(to: out, withOptions: options) else {
      try? FileManager.default.removeItem(at: out)
      throw NSError(domain: "PdfProtector", code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "Could not write the protected PDF"])
    }
    // Verify: the result must actually be locked and unlock with the password.
    guard let check = PDFDocument(url: out), check.isEncrypted, check.isLocked,
          check.unlock(withPassword: password) else {
      try? FileManager.default.removeItem(at: out)
      throw NSError(domain: "PdfProtector", code: 4,
                    userInfo: [NSLocalizedDescriptionKey: "Protection could not be verified"])
    }
  }
}

// MARK: - Keeping a protected PDF's protection (round 14)
//
// A PDF unlocked for the session in Scan Kit (lib/pdf-session.ts) is edited
// from its decrypted copy and encrypted again before it replaces the stored
// file. `protect` above would write user = owner = password and no
// permissions: anyone with the open password would get owner rights, and the
// author's restrictions would be gone. `protectKeeping` writes the open
// password as it was, a separate owner password (random, or the same one when
// the file had user = owner) and the author's permission bits, and reads the
// result back: locked, opens with the password, same page count, and (with a
// separate owner password) as a USER with no permission widened.
extension PdfProtector {
  static func protectKeeping(
    inputPath: String,
    outputPath: String,
    userPassword: String,
    ownerPassword: String?,
    permissions: UInt
  ) throws {
    func fail(_ code: Int, _ message: String) -> NSError {
      NSError(domain: "PdfProtector", code: code, userInfo: [NSLocalizedDescriptionKey: message])
    }
    guard !userPassword.isEmpty else { throw fail(11, "Password is empty") }
    guard let doc = PDFDocument(url: URL(fileURLWithPath: inputPath)), !doc.isLocked else {
      throw fail(12, "Could not open the PDF")
    }
    var options: [PDFDocumentWriteOption: Any]
    if let owner = ownerPassword, !owner.isEmpty {
      // The file had user = owner: the open password grants everything, as before.
      options = [.ownerPasswordOption: owner, .accessPermissionsOption: NSNumber(value: permissions & ~PDFAccessPermissions.allowsDocumentChanges.rawValue)]
    } else {
      options = PdfEditor.protectionOptions(permissions: permissions)
    }
    options[.userPasswordOption] = userPassword
    let out = URL(fileURLWithPath: outputPath)
    try? FileManager.default.removeItem(at: out)
    guard doc.write(to: out, withOptions: options) else {
      try? FileManager.default.removeItem(at: out)
      throw fail(13, "Could not write the protected PDF")
    }
    guard let check = PDFDocument(url: out), check.isEncrypted, check.isLocked,
          check.unlock(withPassword: userPassword), check.pageCount == doc.pageCount else {
      try? FileManager.default.removeItem(at: out)
      throw fail(14, "Protection could not be verified")
    }
    if ownerPassword == nil || ownerPassword?.isEmpty == true {
      // The open password must not have become the owner password, and no
      // permission may have gone from off to on.
      let pairs: [(Bool, PDFAccessPermissions)] = [
        (check.allowsPrinting, .allowsLowQualityPrinting),
        (check.allowsCopying, .allowsContentCopying),
        (check.allowsDocumentAssembly, .allowsDocumentAssembly),
        (check.allowsCommenting, .allowsCommenting),
        (check.allowsFormFieldEntry, .allowsFormFieldEntry),
        (check.allowsContentAccessibility, .allowsContentAccessibility),
      ]
      let widened = pairs.contains { allowed, bit in allowed && permissions & bit.rawValue == 0 }
      if check.permissionsStatus == .owner || widened {
        try? FileManager.default.removeItem(at: out)
        throw fail(15, "Protection could not be verified")
      }
    }
  }
}

// MARK: - Which password opened it (round 14)
//
// PDFKit reports `permissionsStatus == .owner` both for a file whose user and
// owner passwords are the same (Scan Kit's own Protect PDF writes those) and
// for one opened with a separate owner password, whose open password Scan Kit
// then doesn't know. This tells them apart by running the standard security
// handler's USER password check (ISO 32000 algorithms 2, 4/5, 11 and 2.B) on
// the file's /Encrypt dictionary. Nil when it can't be read (unusual
// structure, another security handler): callers treat that as unknown.
enum PdfPasswordCheck {
  static let pad: [UInt8] = [
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
  ]

  struct Standard {
    var r = 0, v = 0, length = 40, p: Int64 = 0
    var o: [UInt8] = [], u: [UInt8] = []
    var encryptMetadata = true
    var id0: [UInt8] = []
  }

  /// What the file's /P allows, as PDFKit's PDFAccessPermissions bits (exact,
  /// where PDFKit's getters round "print" up to full-quality printing).
  static func permissionBits(_ s: Standard) -> UInt {
    let p = UInt32(truncatingIfNeeded: s.p)
    func on(_ bit: Int) -> Bool { p & (1 << (bit - 1)) != 0 }
    let print = on(3), modify = on(4), copy = on(5), annotate = on(6)
    let r3 = s.r >= 3
    var bits: UInt = 0
    if print { bits |= PDFAccessPermissions.allowsLowQualityPrinting.rawValue }
    if print && (!r3 || on(12)) { bits |= PDFAccessPermissions.allowsHighQualityPrinting.rawValue }
    if modify { bits |= PDFAccessPermissions.allowsDocumentChanges.rawValue }
    if modify || (r3 && on(11)) { bits |= PDFAccessPermissions.allowsDocumentAssembly.rawValue }
    if copy { bits |= PDFAccessPermissions.allowsContentCopying.rawValue }
    if copy || (r3 && on(10)) { bits |= PDFAccessPermissions.allowsContentAccessibility.rawValue }
    if annotate { bits |= PDFAccessPermissions.allowsCommenting.rawValue }
    if annotate || (r3 && on(9)) { bits |= PDFAccessPermissions.allowsFormFieldEntry.rawValue }
    return bits
  }

  /// The file's standard security handler values, or nil.
  static func standard(path: String) -> Standard? {
    guard let data = FileManager.default.contents(atPath: path) else { return nil }
    return standard([UInt8](data))
  }

  static func isUserPassword(path: String, password: String) -> Bool? {
    guard let data = FileManager.default.contents(atPath: path), let s = standard([UInt8](data)) else { return nil }
    return check(s, password: password)
  }

  static func check(_ s: Standard, password: String) -> Bool? {
    switch s.r {
    case 2, 3, 4:
      guard s.o.count >= 32, s.u.count >= 16, !s.id0.isEmpty else { return nil }
      let pw = [UInt8]((password.data(using: .isoLatin1) ?? Data(password.utf8)).prefix(32))
      var input = Array((pw + pad).prefix(32)) + Array(s.o.prefix(32))
      let p = UInt32(truncatingIfNeeded: s.p)
      input += [UInt8(p & 0xff), UInt8((p >> 8) & 0xff), UInt8((p >> 16) & 0xff), UInt8((p >> 24) & 0xff)]
      input += s.id0
      if s.r >= 4 && !s.encryptMetadata { input += [0xff, 0xff, 0xff, 0xff] }
      let n = s.r == 2 ? 5 : max(5, min(16, s.length / 8))
      var h = md5(input)
      if s.r >= 3 { for _ in 0..<50 { h = md5(Array(h.prefix(n))) } }
      let key = Array(h.prefix(n))
      if s.r == 2 {
        guard let x = rc4(key, pad), s.u.count >= 32 else { return nil }
        return x == Array(s.u.prefix(32))
      }
      guard var x = rc4(key, md5(pad + s.id0)) else { return nil }
      for i in 1...19 {
        guard let y = rc4(key.map { $0 ^ UInt8(i) }, x) else { return nil }
        x = y
      }
      return Array(x.prefix(16)) == Array(s.u.prefix(16))
    case 5, 6:
      guard s.u.count >= 48 else { return nil }
      let pw = Array(Array(password.utf8).prefix(127))
      let salt = Array(s.u[32..<40])
      let hash = s.r == 5 ? sha256(pw + salt) : hash2B(pw, salt: salt)
      guard let h = hash else { return nil }
      return Array(h.prefix(32)) == Array(s.u.prefix(32))
    default:
      return nil
    }
  }

  // MARK: Crypto

  static func md5(_ b: [UInt8]) -> [UInt8] { Array(Insecure.MD5.hash(data: b)) }
  static func sha256(_ b: [UInt8]) -> [UInt8]? { Array(SHA256.hash(data: b)) }

  static func rc4(_ key: [UInt8], _ data: [UInt8]) -> [UInt8]? {
    var s = Array(0...255).map { UInt8($0) }
    var j = 0
    for i in 0..<256 {
      j = (j + Int(s[i]) + Int(key[i % key.count])) & 0xff
      s.swapAt(i, j)
    }
    var i = 0
    j = 0
    return data.map { byte in
      i = (i + 1) & 0xff
      j = (j + Int(s[i])) & 0xff
      s.swapAt(i, j)
      return byte ^ s[(Int(s[i]) + Int(s[j])) & 0xff]
    }
  }

  static func aes128CbcNoPad(key: [UInt8], iv: [UInt8], _ data: [UInt8]) -> [UInt8]? {
    var out = [UInt8](repeating: 0, count: data.count)
    var moved = 0
    let status = CCCrypt(CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmAES), 0,
                         key, kCCKeySizeAES128, iv, data, data.count, &out, out.count, &moved)
    return status == kCCSuccess && moved == data.count ? out : nil
  }

  /// ISO 32000-2 algorithm 2.B (user password: no U data).
  static func hash2B(_ pw: [UInt8], salt: [UInt8]) -> [UInt8]? {
    var k = Array(SHA256.hash(data: pw + salt))
    var round = 0
    while true {
      let block = pw + k
      var k1: [UInt8] = []
      k1.reserveCapacity(block.count * 64)
      for _ in 0..<64 { k1 += block }
      guard let e = aes128CbcNoPad(key: Array(k[0..<16]), iv: Array(k[16..<32]), k1) else { return nil }
      let mod = e.prefix(16).reduce(0) { $0 + Int($1) } % 3
      k = mod == 0 ? Array(SHA256.hash(data: e)) : mod == 1 ? Array(SHA384.hash(data: e)) : Array(SHA512.hash(data: e))
      round += 1
      if round >= 64 && Int(e[e.count - 1]) <= round - 32 { break }
      if round > 2000 { return nil }
    }
    return Array(k.prefix(32))
  }

  // MARK: Reading /Encrypt and /ID

  static func standard(_ b: [UInt8]) -> Standard? {
    // The newest trailer (or cross-reference stream dictionary) names them.
    guard let encRef = lastReference(b, key: "/Encrypt"), let objStart = lastObject(b, number: encRef),
          let dictStart = find(b, "<<", from: objStart) else { return nil }
    var lexer = Lexer(b, at: dictStart)
    guard let dict = lexer.dictionary() else { return nil }
    guard case .name("Standard")? = dict["Filter"] else { return nil }
    var s = Standard()
    if case .number(let r)? = dict["R"] { s.r = Int(r) }
    if case .number(let v)? = dict["V"] { s.v = Int(v) }
    if case .number(let l)? = dict["Length"] { s.length = Int(l) }
    if case .number(let p)? = dict["P"] { s.p = Int64(p) }
    if case .string(let o)? = dict["O"] { s.o = o }
    if case .string(let u)? = dict["U"] { s.u = u }
    if case .bool(let m)? = dict["EncryptMetadata"] { s.encryptMetadata = m }
    if s.r <= 4 {
      guard let idAt = lastKey(b, "/ID") else { return nil }
      var lx = Lexer(b, at: idAt + 3)
      guard case .array(let ids)? = lx.value(), case .string(let id0)? = ids.first else { return nil }
      s.id0 = id0
    }
    return s
  }

  static func find(_ b: [UInt8], _ s: String, from: Int) -> Int? {
    let n = Array(s.utf8)
    guard from >= 0, b.count >= n.count else { return nil }
    var i = from
    while i + n.count <= b.count {
      if b[i] == n[0] && Array(b[i..<(i + n.count)]) == n { return i }
      i += 1
    }
    return nil
  }

  /// The last `key` (a name not followed by more name characters).
  static func lastKey(_ b: [UInt8], _ key: String) -> Int? {
    let n = Array(key.utf8)
    var i = b.count - n.count
    while i >= 0 {
      if b[i] == n[0] && Array(b[i..<(i + n.count)]) == n {
        let next = i + n.count < b.count ? b[i + n.count] : 0x20
        if !Lexer.isRegular(next) { return i }
      }
      i -= 1
    }
    return nil
  }

  /// The object number in the last "`key` n g R".
  static func lastReference(_ b: [UInt8], key: String) -> Int? {
    guard let at = lastKey(b, key) else { return nil }
    var lx = Lexer(b, at: at + key.utf8.count)
    guard case .number(let n)? = lx.token(), case .number? = lx.token(), case .keyword("R")? = lx.token() else { return nil }
    return Int(n)
  }

  /// Where the last "n g obj" starts.
  static func lastObject(_ b: [UInt8], number: Int) -> Int? {
    let head = Array("\(number) ".utf8)
    var i = b.count - head.count
    while i >= 0 {
      if (i == 0 || !Lexer.isRegular(b[i - 1])) && Array(b[i..<(i + head.count)]) == head {
        var lx = Lexer(b, at: i + head.count)
        if case .number? = lx.token(), case .keyword("obj")? = lx.token() { return lx.i }
      }
      i -= 1
    }
    return nil
  }

  indirect enum Obj {
    case number(Double), name(String), string([UInt8]), bool(Bool), keyword(String)
    case array([Obj]), dict([String: Obj]), open(String)
  }

  struct Lexer {
    let b: [UInt8]
    var i: Int
    init(_ b: [UInt8], at i: Int) { self.b = b; self.i = i }

    static func isWhite(_ c: UInt8) -> Bool { c == 0x20 || c == 0x0A || c == 0x0D || c == 0x09 || c == 0x0C || c == 0x00 }
    static func isDelim(_ c: UInt8) -> Bool { "()<>[]{}/%".utf8.contains(c) }
    static func isRegular(_ c: UInt8) -> Bool { !isWhite(c) && !isDelim(c) }

    mutating func skip() {
      while i < b.count {
        if Lexer.isWhite(b[i]) { i += 1 } else if b[i] == 0x25 { while i < b.count && b[i] != 0x0A && b[i] != 0x0D { i += 1 } } else { break }
      }
    }

    mutating func token() -> Obj? {
      skip()
      guard i < b.count else { return nil }
      let c = b[i]
      if c == 0x3C && i + 1 < b.count && b[i + 1] == 0x3C { i += 2; return .open("<<") }
      if c == 0x3E && i + 1 < b.count && b[i + 1] == 0x3E { i += 2; return .open(">>") }
      if c == 0x5B { i += 1; return .open("[") }
      if c == 0x5D { i += 1; return .open("]") }
      if c == 0x2F {
        i += 1
        var name: [UInt8] = []
        while i < b.count && Lexer.isRegular(b[i]) { name.append(b[i]); i += 1 }
        return .name(String(decoding: name, as: UTF8.self))
      }
      if c == 0x3C { return hexString() }
      if c == 0x28 { return literalString() }
      var word: [UInt8] = []
      while i < b.count && Lexer.isRegular(b[i]) { word.append(b[i]); i += 1 }
      let w = String(decoding: word, as: UTF8.self)
      if let d = Double(w) { return .number(d) }
      if w == "true" { return .bool(true) }
      if w == "false" { return .bool(false) }
      return w.isEmpty ? nil : .keyword(w)
    }

    mutating func hexString() -> Obj? {
      i += 1
      var digits: [UInt8] = []
      while i < b.count && b[i] != 0x3E {
        let c = b[i]
        if let v = Lexer.hex(c) { digits.append(v) }
        i += 1
      }
      i += 1
      if digits.count % 2 == 1 { digits.append(0) }
      var out: [UInt8] = []
      var k = 0
      while k < digits.count { out.append(digits[k] << 4 | digits[k + 1]); k += 2 }
      return .string(out)
    }

    static func hex(_ c: UInt8) -> UInt8? {
      switch c {
      case 0x30...0x39: return c - 0x30
      case 0x41...0x46: return c - 0x41 + 10
      case 0x61...0x66: return c - 0x61 + 10
      default: return nil
      }
    }

    mutating func literalString() -> Obj? {
      i += 1
      var depth = 1
      var out: [UInt8] = []
      while i < b.count {
        let c = b[i]
        i += 1
        if c == 0x5C {
          guard i < b.count else { break }
          let e = b[i]
          i += 1
          switch e {
          case 0x6E: out.append(0x0A)
          case 0x72: out.append(0x0D)
          case 0x74: out.append(0x09)
          case 0x62: out.append(0x08)
          case 0x66: out.append(0x0C)
          case 0x0D: if i < b.count && b[i] == 0x0A { i += 1 }
          case 0x0A: break
          case 0x30...0x37:
            var v = Int(e - 0x30)
            var k = 0
            while k < 2 && i < b.count && (0x30...0x37).contains(b[i]) { v = v * 8 + Int(b[i] - 0x30); i += 1; k += 1 }
            out.append(UInt8(v & 0xff))
          default: out.append(e)
          }
        } else if c == 0x28 {
          depth += 1
          out.append(c)
        } else if c == 0x29 {
          depth -= 1
          if depth == 0 { return .string(out) }
          out.append(c)
        } else {
          out.append(c)
        }
      }
      return nil
    }

    /// A value: dictionaries and arrays parsed whole; "n g R" read as a keyword "R" reference (unused here).
    mutating func value() -> Obj? {
      guard let t = token() else { return nil }
      switch t {
      case .open("<<"):
        var d: [String: Obj] = [:]
        while true {
          guard let k = token() else { return nil }
          if case .open(">>") = k { return .dict(d) }
          guard case .name(let key) = k, let v = value() else { return nil }
          d[key] = v
        }
      case .open("["):
        var a: [Obj] = []
        while true {
          let save = i
          if case .open("]")? = token() { return .array(a) }
          i = save
          guard let v = value() else { return nil }
          a.append(v)
        }
      case .number(let n):
        // "n g R": a reference.
        let save = i
        if case .number? = token(), case .keyword("R")? = token() { return .keyword("ref:\(Int(n))") }
        i = save
        return .number(n)
      default:
        return t
      }
    }

    mutating func dictionary() -> [String: Obj]? {
      guard case .dict(let d)? = value() else { return nil }
      return d
    }
  }
}

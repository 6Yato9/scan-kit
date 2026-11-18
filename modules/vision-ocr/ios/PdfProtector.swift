import Foundation
import PDFKit

/// Writes a password-protected copy of a PDF with PDFKit (AES encryption, iOS
/// handles the cipher). The same password is used for opening and for owner
/// permissions, so nobody can strip the protection without it.
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
    let options: [PDFDocumentWriteOption: Any] = [
      .userPasswordOption: password,
      .ownerPasswordOption: password,
    ]
    let out = URL(fileURLWithPath: outputPath)
    try? FileManager.default.removeItem(at: out)
    guard doc.write(to: out, withOptions: options) else {
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

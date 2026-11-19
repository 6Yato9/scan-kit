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
    for i in 0..<doc.pageCount {
      guard let page = doc.page(at: i) else { out.append(""); continue }
      // Plus what was filled in (round 13b): form values and Fill & sign
      // text, which live in annotations, not in the page's text, so search
      // finds the name the user typed.
      var extra: [String] = []
      for a in page.annotations {
        if a.type == "Widget", a.widgetFieldType == .text || a.widgetFieldType == .choice,
           let v = a.widgetStringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty {
          extra.append(v)
        } else if a.value(forAnnotationKey: PdfFiller.markKey) != nil,
                  let c = a.contents?.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty {
          extra.append(c)
        }
      }
      let text = page.string ?? ""
      out.append(extra.isEmpty ? text : ([text] + extra).filter { !$0.isEmpty }.joined(separator: "\n"))
    }
    return out
  }

  /// Writes an unencrypted copy of a password-protected PDF (the session's
  /// working copy, lib/pdf-session.ts; Create PDF's locked Files sources:
  /// VisionOcr.unlockPdf). The stored PDF itself is never replaced by it.
  /// Throws "wrong-password" when the password doesn't unlock it.
  ///
  /// Round 13b: this used to rebuild the pages into a fresh PDFDocument,
  /// which kept pages, metadata and bookmarks but dropped the document's
  /// AcroForm, so a fillable form came out with no form fields. It now goes
  /// through PdfUnrestrict's decrypt-rewrite (what `qpdf --decrypt` does:
  /// every object written again, unencrypted, pages never redrawn), which
  /// keeps form fields linked to their widgets, annotations, bookmarks, page
  /// labels and text, and reads the copy back before accepting it (unlocked,
  /// same pages, same text per page, same annotations, same number of form
  /// fields and bookmarks, same look). Its later fallbacks (PDFKit's own
  /// write; every permission granted with no open password) still open
  /// without a password, which is all this promises.
  static func unlock(inputPath: String, outputPath: String, password: String) throws {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: inputPath)) else {
      throw NSError(domain: "PdfTools", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not open the PDF"])
    }
    if doc.isLocked && !doc.unlock(withPassword: password) {
      throw NSError(domain: "PdfTools", code: 3, userInfo: [NSLocalizedDescriptionKey: "wrong-password"])
    }
    let url = URL(fileURLWithPath: outputPath)
    do {
      _ = try autoreleasepool {
        try PdfUnrestrict.unrestrict(inputPath: inputPath, outputPath: outputPath, password: password)
      }
    } catch {
      try? FileManager.default.removeItem(at: url)
      let message = (error as NSError).localizedDescription
      if message == PdfUnrestrict.lockedMessage || message == PdfUnrestrict.wrongPasswordMessage {
        throw NSError(domain: "PdfTools", code: 3, userInfo: [NSLocalizedDescriptionKey: "wrong-password"])
      }
      throw NSError(domain: "PdfTools", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not write the unlocked PDF"])
    }
    // Callers read every page from this copy (the session's working copy,
    // Create PDF's source), so it must be complete: opens without a password AND every page present
    // (PdfUnrestrict verified more; this is the promise callers rely on).
    guard let check = PDFDocument(url: url), !check.isLocked, check.pageCount == doc.pageCount else {
      try? FileManager.default.removeItem(at: url)
      throw NSError(domain: "PdfTools", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not write the unlocked PDF"])
    }
  }
}

import ExpoModulesCore
import UIKit
import Vision

/// Text recognition with Apple's Vision framework.
///
/// Used on iOS in place of Google ML Kit, whose prebuilt frameworks have no
/// arm64-simulator slice (so the app could not run on Apple-silicon
/// simulators), and which is less accurate than Vision on iOS anyway.
///
/// `recognize(uri)` resolves to the same shape lib/ocr.ts consumes:
///   { text, lines: [{ text, left, top, width, height }] }
/// with line frames in the pixel space of the upright image.
public class VisionOcrModule: Module {
  /// Read aloud (Speech.swift); created on first use.
  private lazy var speech = SpeechController { [weak self] name, body in self?.sendEvent(name, body) }

  public func definition() -> ModuleDefinition {
    Name("VisionOcr")

    // Read aloud progress (SpeechController).
    Events("onSpeechProgress", "onSpeechState")

    View(PdfDocumentView.self) {
      Events("onPageChange", "onLoadError")
      Prop("source") { (view: PdfDocumentView, uri: String) in view.setSource(uri) }
      Prop("backgroundHex") { (view: PdfDocumentView, hex: String) in view.setBackground(hex) }
      Prop("initialPage") { (view: PdfDocumentView, page: Int) in view.setInitialPage(page) }
    }

    // Must stay the SECOND view: the first one is the module's default view
    // (requireNativeView('VisionOcr') = PdfDocumentView in shipped JS).
    View(DocumentCameraView.self) {
      Events("onDetection", "onCapture", "onCaptureStart", "onCameraError", "onCameraState")
      Prop("autoCapture") { (view: DocumentCameraView, on: Bool) in view.setAutoCapture(on) }
      Prop("flash") { (view: DocumentCameraView, mode: String) in view.setFlash(mode) }
      Prop("torch") { (view: DocumentCameraView, on: Bool) in view.setTorch(on) }
      Prop("active") { (view: DocumentCameraView, on: Bool) in view.setActive(on) }
      Prop("simulatorImageUri") { (view: DocumentCameraView, uri: String?) in view.setSimulatorImage(uri) }
      Prop("simulatorJitter") { (view: DocumentCameraView, amount: Double?) in view.setSimulatorJitter(amount ?? 0) }
      OnViewDidUpdateProps { (view: DocumentCameraView) in view.propsDidUpdate() }
      AsyncFunction("capture") { (view: DocumentCameraView, promise: Promise) in view.capture(promise) }
      AsyncFunction("rearm") { (view: DocumentCameraView) in view.rearm() }
    }

    /// Page outline in a photo: [x0,y0,...,x3,y3] TL, TR, BR, BL, normalised
    /// 0...1, top-left origin, upright (EXIF applied). null when not confident.
    AsyncFunction("detectQuad") { (uri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let quad = try DocumentGeometry.detectQuad(path: DocumentGeometry.path(uri.components(separatedBy: "?")[0]))
          promise.resolve(quad.map { DocumentGeometry.flatten($0) })
        } catch let e as DocumentGeometry.Failure {
          promise.reject(e.code, e.message)
        } catch {
          promise.reject("ERR_DETECT_QUAD", error.localizedDescription)
        }
      }
    }

    /// Perspective-corrected crop of `quad` from the upright source, written
    /// as an upright JPEG with the long edge capped at maxEdge.
    AsyncFunction("warpQuad") { (srcUri: String, quad: [Double], outUri: String, quality: Double, maxEdge: Double, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let pts = try DocumentGeometry.parseQuad(quad)
          guard quality.isFinite, maxEdge.isFinite, maxEdge >= 1 else {
            throw DocumentGeometry.Failure(code: "ERR_BAD_ARGS", message: "quality must be 0...1 and maxEdge >= 1")
          }
          let out = DocumentGeometry.path(outUri)
          let (w, h) = try DocumentGeometry.warp(srcPath: DocumentGeometry.path(srcUri.components(separatedBy: "?")[0]),
                                                 quad: pts, outPath: out,
                                                 quality: min(1, max(0, quality)), maxEdge: Int(maxEdge))
          promise.resolve(["uri": URL(fileURLWithPath: out).absoluteString, "width": w, "height": h])
        } catch let e as DocumentGeometry.Failure {
          promise.reject(e.code, e.message)
        } catch {
          promise.reject("ERR_WARP", error.localizedDescription)
        }
      }
    }

    /// Upright (EXIF baked in) JPEG copy with the long edge capped at maxEdge.
    AsyncFunction("normalizeImage") { (srcUri: String, outUri: String, maxEdge: Double, quality: Double, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          guard quality.isFinite, maxEdge.isFinite, maxEdge >= 1 else {
            throw DocumentGeometry.Failure(code: "ERR_BAD_ARGS", message: "quality must be 0...1 and maxEdge >= 1")
          }
          let out = DocumentGeometry.path(outUri)
          let (w, h) = try DocumentGeometry.normalize(srcPath: DocumentGeometry.path(srcUri.components(separatedBy: "?")[0]),
                                                      outPath: out, maxEdge: Int(maxEdge),
                                                      quality: min(1, max(0, quality)))
          promise.resolve(["uri": URL(fileURLWithPath: out).absoluteString, "width": w, "height": h])
        } catch let e as DocumentGeometry.Failure {
          promise.reject(e.code, e.message)
        } catch {
          promise.reject("ERR_NORMALIZE", error.localizedDescription)
        }
      }
    }

    AsyncFunction("recognize") { (uri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          promise.resolve(try Self.recognize(uri: uri))
        } catch {
          promise.reject("ERR_VISION_OCR", error.localizedDescription)
        }
      }
    }

    /// Write a password-protected copy of a PDF. Resolves to the output file URI.
    AsyncFunction("protectPdf") { (inputUri: String, outputUri: String, password: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          func path(_ u: String) -> String { URL(string: u).flatMap { $0.isFileURL ? $0.path : nil } ?? u }
          try PdfProtector.protect(inputPath: path(inputUri), outputPath: path(outputUri), password: password)
          promise.resolve(URL(fileURLWithPath: path(outputUri)).absoluteString)
        } catch {
          promise.reject("ERR_PDF_PROTECT", error.localizedDescription)
        }
      }
    }

    /// Render every page of a PDF to JPEGs. Resolves to the file URIs in order.
    AsyncFunction("renderPdfPages") { (inputUri: String, outputDirUri: String, maxEdge: Double, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          func path(_ u: String) -> String { URL(string: u).flatMap { $0.isFileURL ? $0.path : nil } ?? u }
          let paths = try PdfRasterizer.render(inputPath: path(inputUri), outputDir: path(outputDirUri),
                                               maxEdge: CGFloat(maxEdge), quality: 0.9)
          promise.resolve(paths.map { URL(fileURLWithPath: $0).absoluteString })
        } catch {
          promise.reject("ERR_PDF_RENDER", error.localizedDescription)
        }
      }
    }

    /// Concatenate PDFs in order; each page keeps its own size and text layer.
    AsyncFunction("mergePdfs") { (inputUris: [String], outputUri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          func path(_ u: String) -> String { URL(string: u).flatMap { $0.isFileURL ? $0.path : nil } ?? u }
          try PdfMerger.merge(inputPaths: inputUris.map(path), outputPath: path(outputUri))
          promise.resolve(URL(fileURLWithPath: path(outputUri)).absoluteString)
        } catch {
          let message = error.localizedDescription
          promise.reject(message == PdfEditor.restrictedMessage ? "ERR_PDF_RESTRICTED" : "ERR_PDF_MERGE", message)
        }
      }
    }

    /// Embedded text of each page of a PDF ("" for image-only pages).
    AsyncFunction("pdfPageTexts") { (uri: String, password: String?, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let path = URL(string: uri).flatMap { $0.isFileURL ? $0.path : nil } ?? uri
          promise.resolve(try PdfTools.pageTexts(path: path, password: password))
        } catch {
          promise.reject("ERR_PDF_TEXT", error.localizedDescription)
        }
      }
    }

    /// Write an unencrypted copy of a password-protected PDF.
    AsyncFunction("unlockPdf") { (inputUri: String, outputUri: String, password: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          func path(_ u: String) -> String { URL(string: u).flatMap { $0.isFileURL ? $0.path : nil } ?? u }
          try PdfTools.unlock(inputPath: path(inputUri), outputPath: path(outputUri), password: password)
          promise.resolve(URL(fileURLWithPath: path(outputUri)).absoluteString)
        } catch {
          promise.reject("ERR_PDF_UNLOCK", error.localizedDescription)
        }
      }
    }

    /// Page edits that keep a PDF a PDF (PdfEditor): rotate, delete, reorder,
    /// blank pages, split. Writes `outputUri` and verifies it before resolving
    /// to its page count. Rejects ERR_PDF_LOCKED (message "locked") when the
    /// PDF needs a password, ERR_PDF_RESTRICTED (message "restricted") when its
    /// permissions don't allow changing pages, ERR_PDF_EDIT otherwise.
    AsyncFunction("pdfEditPages") { (inputUri: String, outputUri: String, sources: [Int], rotations: [Int], password: String?, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        func path(_ u: String) -> String { URL(string: u).flatMap { $0.isFileURL ? $0.path : nil } ?? u }
        do {
          let n = try autoreleasepool {
            try PdfEditor.compose(inputPath: path(inputUri), outputPath: path(outputUri),
                                  sources: sources, rotations: rotations, password: password)
          }
          promise.resolve(n)
        } catch {
          let message = error.localizedDescription
          let code = message == PdfEditor.lockedMessage ? "ERR_PDF_LOCKED"
            : message == PdfEditor.restrictedMessage ? "ERR_PDF_RESTRICTED" : "ERR_PDF_EDIT"
          promise.reject(code, message)
        }
      }
    }

    /// { pageCount, locked, encrypted } of a PDF, without changing it.
    AsyncFunction("pdfInfo") { (uri: String, password: String?, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let path = URL(string: uri).flatMap { $0.isFileURL ? $0.path : nil } ?? uri
          promise.resolve(try PdfEditor.info(path: path, password: password))
        } catch {
          promise.reject("ERR_PDF_INFO", error.localizedDescription)
        }
      }
    }

    /// Moves a file over another in one atomic rename (the old file is never
    /// missing or partial at any instant). Resolves to the destination URI.
    AsyncFunction("replaceFile") { (srcUri: String, destUri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        func path(_ u: String) -> String { URL(string: u).flatMap { $0.isFileURL ? $0.path : nil } ?? u }
        do {
          try PdfEditor.replace(srcPath: path(srcUri), destPath: path(destUri))
          promise.resolve(URL(fileURLWithPath: path(destUri)).absoluteString)
        } catch {
          promise.reject("ERR_REPLACE_FILE", error.localizedDescription)
        }
      }
    }

    /// One share sheet with several files (a document's pages as images).
    /// Resolves when the sheet is dismissed, whatever the user chose.
    AsyncFunction("shareFiles") { (uris: [String], title: String?, promise: Promise) in
      let urls = uris.compactMap { URL(string: $0) }.filter { $0.isFileURL }
      guard !urls.isEmpty else { promise.reject("ERR_SHARE_FILES", "No files"); return }
      guard var top = self.appContext?.utilities?.currentViewController() else {
        promise.reject("ERR_SHARE_FILES", "No view controller"); return
      }
      // Present from the top-most controller that isn't being dismissed.
      while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
      let vc = UIActivityViewController(activityItems: urls, applicationActivities: nil)
      vc.title = title
      vc.completionWithItemsHandler = { _, _, _, _ in promise.resolve(nil) }
      if let pop = vc.popoverPresentationController {
        pop.sourceView = top.view
        pop.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.maxY, width: 0, height: 0)
      }
      top.present(vc, animated: true)
    }.runOnQueue(.main)

    /// Copy a file the system handed us (Open in / Files, possibly a
    /// security-scoped URL outside the sandbox when opened in place) into the
    /// app. Uses NSFileCoordinator so iCloud/provider files are materialised.
    AsyncFunction("copyIncomingFile") { (sourceUri: String, destUri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        guard let src = URL(string: sourceUri), src.isFileURL,
              let dst = URL(string: destUri), dst.isFileURL else {
          promise.reject("ERR_COPY_INCOMING", "Bad file URL"); return
        }
        let scoped = src.startAccessingSecurityScopedResource()
        defer { if scoped { src.stopAccessingSecurityScopedResource() } }
        var coordError: NSError?
        var copyError: Error?
        NSFileCoordinator().coordinate(readingItemAt: src, options: [.withoutChanges], error: &coordError) { readURL in
          do {
            try FileManager.default.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? FileManager.default.removeItem(at: dst)
            try FileManager.default.copyItem(at: readURL, to: dst)
            // A fresh modification date: the startup sweep ages staged files by it.
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: dst.path)
          } catch { copyError = error }
        }
        if let e = coordError ?? (copyError as NSError?) {
          promise.reject("ERR_COPY_INCOMING", e.localizedDescription)
        } else {
          promise.resolve(dst.absoluteString)
        }
      }
    }

    /// Detect a document in a photo and return a perspective-corrected copy.
    /// Resolves to { uri, detected }. When nothing confident is found, resolves
    /// with the input uri and detected: false.
    AsyncFunction("detectDocument") { (uri: String, quality: Double, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let input = URL(string: uri).flatMap { $0.isFileURL ? $0.path : nil } ?? uri
          let out = FileManager.default.temporaryDirectory
            .appendingPathComponent("doc-\(UUID().uuidString).jpg").path
          // Auto-crop on import: stricter minimum area than detectQuad (no
          // one reviews this crop), corners on the paper edge (no inset).
          let quad: [CGPoint]? = try autoreleasepool {
            let src = try DocumentGeometry.source(path: input)
            guard let cg = DocumentGeometry.upright(source: src, maxPixel: 2048) else { return nil }
            return DocumentGeometry.detect(cg, minArea: 0.30)
          }
          if let quad = quad {
            _ = try DocumentGeometry.warp(srcPath: input, quad: quad, outPath: out, quality: quality, maxEdge: 4096)
            promise.resolve(["uri": URL(fileURLWithPath: out).absoluteString, "detected": true])
          } else {
            promise.resolve(["uri": uri, "detected": false])
          }
        } catch {
          promise.reject("ERR_DOC_DETECT", error.localizedDescription)
        }
      }
    }

    // MARK: Acting on recognised text (TextActions.swift, Speech.swift,
    // EventEditor.swift, ContactCard.swift). All on device.

    /// Phone numbers, emails, links, addresses and dates in `text`
    /// (NSDataDetector): [{ type, text, range: [start, length], value, … }].
    AsyncFunction("detectData") { (text: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        promise.resolve(TextActions.detectData(text))
      }
    }

    /// QR codes and barcodes in an image file (Vision).
    AsyncFunction("detectBarcodes") { (uri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          promise.resolve(try autoreleasepool { try TextActions.detectBarcodes(path: TextActions.filePath(uri)) })
        } catch {
          promise.reject("ERR_BARCODES", error.localizedDescription)
        }
      }
    }

    /// Dominant language of `text` (BCP-47, e.g. "fr"), or null.
    AsyncFunction("detectLanguage") { (text: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        promise.resolve(TextActions.dominantLanguage(text))
      }
    }

    /// { people, organizations, places } named in `text` (NLTagger).
    AsyncFunction("nameEntities") { (text: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        promise.resolve(TextActions.nameEntities(text))
      }
    }

    /// Starts reading `text` aloud (stopping anything being read); resolves { id, language }.
    AsyncFunction("speak") { (text: String, language: String?, rate: Double?, promise: Promise) in
      promise.resolve(self.speech.speak(text, language: language, rate: rate))
    }.runOnQueue(.main)

    AsyncFunction("pauseSpeaking") { (promise: Promise) in
      self.speech.pause()
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("resumeSpeaking") { (promise: Promise) in
      self.speech.resume()
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("stopSpeaking") { (promise: Promise) in
      self.speech.stop()
      promise.resolve(nil)
    }.runOnQueue(.main)

    /// The system New Event editor, prefilled; resolves saved | cancelled | denied | unavailable.
    AsyncFunction("presentEventEditor") { (title: String, startMs: Double, endMs: Double, allDay: Bool, notes: String?, location: String?, promise: Promise) in
      EventEditorPresenter.present(
        from: self.appContext?.utilities?.currentViewController(),
        title: title,
        start: Date(timeIntervalSince1970: startMs / 1000),
        end: Date(timeIntervalSince1970: max(endMs, startMs) / 1000),
        allDay: allDay, notes: notes, location: location
      ) { promise.resolve($0) }
    }.runOnQueue(.main)

    /// The system New Contact form, prefilled; resolves saved | cancelled | unavailable.
    AsyncFunction("presentNewContact") { (fields: [String: Any], promise: Promise) in
      NewContactPresenter.present(from: self.appContext?.utilities?.currentViewController(), fields: fields) {
        promise.resolve($0)
      }
    }.runOnQueue(.main)

    /// Writes the contact as a vCard file; resolves its file URI.
    AsyncFunction("writeVCard") { (fields: [String: Any], outputUri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let out = TextActions.filePath(outputUri)
          try ContactCard.writeVCard(fields, outPath: out)
          promise.resolve(URL(fileURLWithPath: out).absoluteString)
        } catch {
          promise.reject("ERR_VCARD", error.localizedDescription)
        }
      }
    }
  }

  private static func loadImage(_ uri: String) throws -> UIImage {
    let path: String
    if let url = URL(string: uri), url.isFileURL {
      path = url.path
    } else {
      path = uri
    }
    guard let image = UIImage(contentsOfFile: path) else {
      throw NSError(domain: "VisionOcr", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Could not read image at \(uri)"])
    }
    return image
  }

  private static func cgOrientation(_ o: UIImage.Orientation) -> CGImagePropertyOrientation {
    switch o {
    case .up: return .up
    case .down: return .down
    case .left: return .left
    case .right: return .right
    case .upMirrored: return .upMirrored
    case .downMirrored: return .downMirrored
    case .leftMirrored: return .leftMirrored
    case .rightMirrored: return .rightMirrored
    @unknown default: return .up
    }
  }

  private static func recognize(uri: String) throws -> [String: Any] {
    let image = try loadImage(uri)
    guard let cgImage = image.cgImage else {
      throw NSError(domain: "VisionOcr", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Unsupported image format"])
    }

    // Vision reports boxes normalised to the image *as oriented*, so size the
    // output space to the upright image (width/height swap for 90° EXIF turns).
    let orientation = cgOrientation(image.imageOrientation)
    let rotated = [.left, .right, .leftMirrored, .rightMirrored].contains(orientation)
    let width = CGFloat(rotated ? cgImage.height : cgImage.width)
    let height = CGFloat(rotated ? cgImage.width : cgImage.height)

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if #available(iOS 16.0, *) {
      request.automaticallyDetectsLanguage = true
    }

    let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
    try handler.perform([request])

    // Reading order: group observations into visual rows (boxes that overlap
    // vertically by at least half the smaller height), rows top to bottom,
    // cells left to right. A plain sort on midY interleaves table columns
    // whenever the page is even slightly skewed.
    let all = (request.results ?? []).filter { $0.topCandidates(1).first != nil }
    let byTop = all.sorted { $0.boundingBox.maxY > $1.boundingBox.maxY }
    var rows: [[VNRecognizedTextObservation]] = []
    for obs in byTop {
      let b = obs.boundingBox
      if let i = rows.firstIndex(where: { row in
        row.contains { other in
          let o = other.boundingBox
          let overlap = min(b.maxY, o.maxY) - max(b.minY, o.minY)
          return overlap >= min(b.height, o.height) * 0.5
        }
      }) {
        rows[i].append(obs)
      } else {
        rows.append([obs])
      }
    }

    var lines: [[String: Any]] = []
    var texts: [String] = []
    for row in rows {
      let cells = row.sorted { $0.boundingBox.minX < $1.boundingBox.minX }
      var rowText: [String] = []
      for observation in cells {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let box = observation.boundingBox  // normalised, origin bottom-left
        lines.append([
          "text": candidate.string,
          "left": Double(box.minX * width),
          "top": Double((1 - box.maxY) * height),
          "width": Double(box.width * width),
          "height": Double(box.height * height),
        ])
        rowText.append(candidate.string)
      }
      texts.append(rowText.joined(separator: "  "))
    }

    return ["text": texts.joined(separator: "\n"), "lines": lines]
  }
}

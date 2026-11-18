import ExpoModulesCore
import PDFKit
import UIKit

/// Native PDF viewer (PDFKit) for imported PDF documents: continuous vertical
/// scroll, pinch zoom, page shadows on a caller-chosen background — so it sits
/// inside the app's always-dark viewer instead of WebKit's grey PDF chrome.
public class PdfDocumentView: ExpoView {
  let pdfView = PDFView()
  let onPageChange = EventDispatcher()
  let onLoadError = EventDispatcher()
  private var loadedPath: String?
  private var lastFitScale: CGFloat = 0
  /// Page to show once the document is loaded and laid out (initialPage prop).
  private var pendingPage: Int?

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    pdfView.autoScales = true
    pdfView.displayMode = .singlePageContinuous
    pdfView.displayDirection = .vertical
    pdfView.pageShadowsEnabled = true
    // Same breathing room around a page as scanned pages get in the viewer.
    pdfView.pageBreakMargins = UIEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
    addSubview(pdfView)
    NotificationCenter.default.addObserver(
      self, selector: #selector(pageChanged), name: .PDFViewPageChanged, object: pdfView)
  }

  deinit { NotificationCenter.default.removeObserver(self) }

  public override func layoutSubviews() {
    super.layoutSubviews()
    let wasFitted = pdfView.document != nil && abs(pdfView.scaleFactor - lastFitScale) < 0.001
    pdfView.frame = bounds
    // Keep a user's zoom across relayouts (banner dismissed, rotation); only
    // refit when the page was at fit-to-width.
    if pdfView.document != nil && (wasFitted || lastFitScale == 0) {
      pdfView.scaleFactor = pdfView.scaleFactorForSizeToFit
    }
    lastFitScale = pdfView.scaleFactorForSizeToFit
    applyPendingPage()
  }

  func setSource(_ uri: String) {
    let path = URL(string: uri).flatMap { $0.isFileURL ? $0.path : nil } ?? uri
    guard path != loadedPath else { return }
    loadedPath = path
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
      pdfView.document = nil
      onLoadError(["message": "Could not open the PDF"])
      return
    }
    if doc.isLocked {
      pdfView.document = nil
      onLoadError(["message": "locked"])
      return
    }
    pdfView.document = doc
    pdfView.scaleFactor = pdfView.scaleFactorForSizeToFit
    lastFitScale = pdfView.scaleFactor
    pageChanged()
    applyPendingPage()
  }

  /// Opens the document at this page (zero-based) instead of the first, e.g.
  /// the page that was on screen before an edit reloaded the file. Applied once.
  func setInitialPage(_ page: Int) {
    pendingPage = page > 0 ? page : nil
    applyPendingPage()
  }

  private func applyPendingPage() {
    guard let index = pendingPage, let doc = pdfView.document, bounds.width > 0, bounds.height > 0 else { return }
    pendingPage = nil
    guard let page = doc.page(at: min(index, doc.pageCount - 1)) else { return }
    // After this layout pass, so the fit scale is in place before scrolling.
    DispatchQueue.main.async { [weak self] in
      guard let self = self, self.pdfView.document === doc else { return }
      self.pdfView.go(to: page)
      self.pageChanged()
    }
  }

  func setBackground(_ hex: String) {
    pdfView.backgroundColor = UIColor(hexString: hex) ?? .black
    backgroundColor = pdfView.backgroundColor
  }

  @objc private func pageChanged() {
    guard let doc = pdfView.document, let page = pdfView.currentPage else { return }
    onPageChange(["page": doc.index(for: page), "count": doc.pageCount])
  }
}

private extension UIColor {
  convenience init?(hexString: String) {
    var s = hexString.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
    self.init(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
              blue: CGFloat(v & 0xff) / 255, alpha: 1)
  }
}

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
  /// A new document opens at its top, whatever its first layouts do to the offset.
  private var pinTopOnLayout = false

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
    // PDFKit keeps the offset, not the top, when the view is resized (the
    // convert banner appearing above it, an iPad rotation): a document showing
    // its top keeps showing it, instead of opening with its first lines hidden.
    let keepTop = pendingPage == nil && (pinTopOnLayout || showsDocumentTop())
    if bounds.width > 0 && bounds.height > 0 { pinTopOnLayout = false }
    pdfView.frame = bounds
    // Keep a user's zoom across relayouts (banner dismissed, rotation); only
    // refit when the page was at fit-to-width.
    if pdfView.document != nil && (wasFitted || lastFitScale == 0) {
      pdfView.scaleFactor = pdfView.scaleFactorForSizeToFit
    }
    lastFitScale = pdfView.scaleFactorForSizeToFit
    if keepTop && pdfView.document != nil {
      // After this layout pass, once the fit scale is in place.
      DispatchQueue.main.async { [weak self] in
        guard let self = self, let first = self.pdfView.document?.page(at: 0) else { return }
        self.scrollToTop(of: first)
      }
    }
    applyPendingPage()
  }

  /// Scrolls so this page's top sits where the first page's top does at the
  /// start of the document. PDFView.go(to:) can't be used for this: with a
  /// page taller than the view (an iPad in portrait) it stops some way down
  /// the page, so a PDF opened with its first lines hidden under the banner.
  private func scrollToTop(of page: PDFPage) {
    guard let scroll = pdfView.subviews.lazy.compactMap({ $0 as? UIScrollView }).first,
          let first = pdfView.document?.page(at: 0) else {
      pdfView.go(to: page)
      return
    }
    func contentTop(_ p: PDFPage) -> CGFloat {
      scroll.contentOffset.y + pdfView.convert(CGPoint(x: 0, y: p.bounds(for: pdfView.displayBox).maxY), from: p).y
    }
    let inset = scroll.adjustedContentInset
    let lowest = -inset.top
    let highest = max(lowest, scroll.contentSize.height - scroll.bounds.height + inset.bottom)
    let y = min(highest, max(lowest, lowest + contentTop(page) - contentTop(first)))
    scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: y), animated: false)
  }

  /// Whether the top of the first page is in view (nothing scrolled past it).
  private func showsDocumentTop() -> Bool {
    guard let first = pdfView.document?.page(at: 0), pdfView.bounds.height > 0 else { return false }
    let top = pdfView.convert(CGPoint(x: 0, y: first.bounds(for: pdfView.displayBox).maxY), from: first)
    return top.y >= -1
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
    pinTopOnLayout = true
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
      self.scrollToTop(of: page)
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

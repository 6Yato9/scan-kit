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

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    pdfView.autoScales = true
    pdfView.displayMode = .singlePageContinuous
    pdfView.displayDirection = .vertical
    pdfView.pageShadowsEnabled = true
    pdfView.pageBreakMargins = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
    addSubview(pdfView)
    NotificationCenter.default.addObserver(
      self, selector: #selector(pageChanged), name: .PDFViewPageChanged, object: pdfView)
  }

  deinit { NotificationCenter.default.removeObserver(self) }

  public override func layoutSubviews() {
    super.layoutSubviews()
    pdfView.frame = bounds
    if pdfView.document != nil { pdfView.scaleFactor = pdfView.scaleFactorForSizeToFit }
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
    pageChanged()
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

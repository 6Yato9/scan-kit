import Foundation
import ImageIO
import NaturalLanguage
import UIKit
import Vision

/// On-device helpers for acting on a page's recognised text (round 12):
/// data detection (NSDataDetector), barcode reading (Vision), the dominant
/// language and named entities (NaturalLanguage). Nothing here touches the
/// network.
enum TextActions {
  // MARK: Detected data

  /// Phone numbers, email addresses, links, postal addresses and dates in
  /// `text`. Ranges are UTF-16 offsets (NSString), the same units as a
  /// JavaScript string index.
  static func detectData(_ text: String) -> [[String: Any]] {
    let types: NSTextCheckingResult.CheckingType = [.phoneNumber, .link, .address, .date]
    guard !text.isEmpty, let detector = try? NSDataDetector(types: types.rawValue) else { return [] }
    let ns = text as NSString
    var out: [[String: Any]] = []
    detector.enumerateMatches(in: text, options: [], range: NSRange(location: 0, length: ns.length)) { match, _, _ in
      guard let match = match, match.range.location != NSNotFound, match.range.length > 0 else { return }
      let matched = ns.substring(with: match.range)
      var item: [String: Any] = [
        "text": matched,
        "range": [match.range.location, match.range.length],
      ]
      switch match.resultType {
      case .phoneNumber:
        item["type"] = "phone"
        item["value"] = match.phoneNumber ?? matched
      case .link:
        guard let url = match.url else { return }
        if url.scheme?.lowercased() == "mailto" {
          item["type"] = "email"
          let address = url.absoluteString.dropFirst("mailto:".count)
          item["value"] = address.removingPercentEncoding ?? String(address)
        } else {
          item["type"] = "url"
          item["value"] = url.absoluteString
        }
      case .address:
        item["type"] = "address"
        item["value"] = matched
        var parts: [String: String] = [:]
        for (key, value) in match.addressComponents ?? [:] where !value.isEmpty {
          switch key {
          case .street: parts["street"] = value
          case .city: parts["city"] = value
          case .state: parts["state"] = value
          case .zip: parts["postalCode"] = value
          case .country: parts["country"] = value
          case .name: parts["name"] = value
          case .organization: parts["organization"] = value
          default: break
          }
        }
        item["address"] = parts
      case .date:
        guard let date = match.date else { return }
        item["type"] = "date"
        item["value"] = matched
        item["date"] = date.timeIntervalSince1970 * 1000
        item["duration"] = match.duration
        item["hasTime"] = mentionsTime(matched)
        if let tz = match.timeZone { item["timeZone"] = tz.identifier }
      default:
        return
      }
      out.append(item)
    }
    return out
  }

  /// Whether a matched date string names a time of day ("10:30", "3 pm",
  /// "noon"), as opposed to a day only. NSDataDetector fills in noon for a
  /// bare day, which would make a timed calendar event out of "12 March".
  static func mentionsTime(_ s: String) -> Bool {
    let pattern = #"\d{1,2}[:.h]\d{2}|\b\d{1,2}\s?(am|pm|a\.m\.|p\.m\.)|\b(noon|midnight|midi|minuit)\b|\b\d{1,2}\s?h\b"#
    return s.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
  }

  // MARK: Language and names

  /// BCP-47 code of the text's dominant language ("en", "fr", "zh-Hans"), or nil.
  static func dominantLanguage(_ text: String) -> String? {
    let sample = String(text.prefix(4000))
    guard !sample.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return NLLanguageRecognizer.dominantLanguage(for: sample)?.rawValue
  }

  /// People's and organisations' names NaturalLanguage finds in `text`.
  static func nameEntities(_ text: String) -> [String: [String]] {
    var people: [String] = []
    var orgs: [String] = []
    var places: [String] = []
    let tagger = NLTagger(tagSchemes: [.nameType])
    tagger.string = text
    let options: NLTagger.Options = [.omitPunctuation, .omitWhitespace, .joinNames]
    tagger.enumerateTags(in: text.startIndex..<text.endIndex, unit: .word, scheme: .nameType, options: options) { tag, range in
      let word = String(text[range])
      switch tag {
      case .personalName?: if !people.contains(word) { people.append(word) }
      case .organizationName?: if !orgs.contains(word) { orgs.append(word) }
      case .placeName?: if !places.contains(word) { places.append(word) }
      default: break
      }
      return true
    }
    return ["people": people, "organizations": orgs, "places": places]
  }

  // MARK: Barcodes

  /// QR codes and barcodes in an image file, top to bottom. Each:
  /// { symbology, payload, left, top, width, height } with the box normalised
  /// 0...1 in the upright image, top-left origin.
  static func detectBarcodes(path: String) throws -> [[String: Any]] {
    guard let image = uprightImage(path: path, maxPixel: 3000) else {
      throw NSError(domain: "VisionOcr", code: 10, userInfo: [NSLocalizedDescriptionKey: "Could not read the image"])
    }
    let results: [VNBarcodeObservation]
    do {
      results = try runBarcodes(image, legacy: false)
    } catch {
      // The newer, model-based revisions can't create their inference context
      // in the simulator; the first revision runs anywhere.
      results = try runBarcodes(image, legacy: true)
    }
    var seen = Set<String>()
    var out: [[String: Any]] = []
    let sorted = results.sorted { $0.boundingBox.maxY > $1.boundingBox.maxY }
    for obs in sorted {
      guard let payload = obs.payloadStringValue, !payload.isEmpty else { continue }
      let symbology = symbologyName(obs.symbology)
      let key = symbology + "\u{1}" + payload
      if seen.contains(key) { continue }
      seen.insert(key)
      let b = obs.boundingBox
      out.append([
        "symbology": symbology,
        "payload": payload,
        "left": Double(b.minX),
        "top": Double(1 - b.maxY),
        "width": Double(b.width),
        "height": Double(b.height),
      ])
    }
    return out
  }

  private static func runBarcodes(_ image: CGImage, legacy: Bool) throws -> [VNBarcodeObservation] {
    let request = VNDetectBarcodesRequest()
    if legacy {
      request.revision = VNDetectBarcodesRequestRevision1
    }
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])
    return request.results ?? []
  }

  /// Names matching expo-camera's barcode types where they overlap (the QR
  /// tool shows both the same way).
  static func symbologyName(_ s: VNBarcodeSymbology) -> String {
    switch s {
    case .qr: return "qr"
    case .aztec: return "aztec"
    case .pdf417: return "pdf417"
    case .dataMatrix: return "datamatrix"
    case .ean13: return "ean13"
    case .ean8: return "ean8"
    case .upce: return "upc_e"
    case .code128: return "code128"
    case .code39, .code39Checksum, .code39FullASCII, .code39FullASCIIChecksum: return "code39"
    case .code93, .code93i: return "code93"
    case .itf14: return "itf14"
    case .i2of5, .i2of5Checksum: return "itf"
    default:
      return s.rawValue.replacingOccurrences(of: "VNBarcodeSymbology", with: "").lowercased()
    }
  }

  // MARK: Images

  /// The image at `path`, EXIF orientation applied, long edge at most maxPixel.
  static func uprightImage(path: String, maxPixel: Int) -> CGImage? {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let src = CGImageSourceCreateWithURL(url, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
  }

  static func filePath(_ uri: String) -> String {
    let clean = uri.components(separatedBy: "?")[0]
    if let url = URL(string: clean), url.isFileURL { return url.path }
    return clean
  }
}

/// Finds the controller to present from, and settles a presentation that
/// ends without its delegate being told (a parent dismissed it: the sheet it
/// was shown over went away when App Lock engaged).
enum Presenter {
  static func top(from root: UIViewController?) -> UIViewController? {
    guard var top = root else { return nil }
    while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
    return top
  }

  /// Calls `gone` once `vc` is no longer on screen, checked twice a second
  /// after it has been presented. The caller makes `gone` idempotent.
  static func watch(_ vc: UIViewController, gone: @escaping () -> Void) {
    var shown = false
    Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { timer in
      let onScreen = vc.presentingViewController != nil || vc.view.window != nil
      if onScreen { shown = true; return }
      if shown || !vc.isBeingPresented {
        timer.invalidate()
        gone()
      }
    }
  }
}

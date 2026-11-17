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
  public func definition() -> ModuleDefinition {
    Name("VisionOcr")

    AsyncFunction("recognize") { (uri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          promise.resolve(try Self.recognize(uri: uri))
        } catch {
          promise.reject("ERR_VISION_OCR", error.localizedDescription)
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

    // Vision returns observations roughly in reading order already; sort
    // top-to-bottom, then left-to-right, so the joined text reads naturally.
    let observations = (request.results ?? []).sorted { a, b in
      let dy = b.boundingBox.midY - a.boundingBox.midY
      if abs(dy) > min(a.boundingBox.height, b.boundingBox.height) * 0.5 {
        return dy < 0  // larger midY = higher on the page (origin bottom-left)
      }
      return a.boundingBox.minX < b.boundingBox.minX
    }

    var lines: [[String: Any]] = []
    var texts: [String] = []
    for observation in observations {
      guard let candidate = observation.topCandidates(1).first else { continue }
      let box = observation.boundingBox  // normalised, origin bottom-left
      lines.append([
        "text": candidate.string,
        "left": Double(box.minX * width),
        "top": Double((1 - box.maxY) * height),
        "width": Double(box.width * width),
        "height": Double(box.height * height),
      ])
      texts.append(candidate.string)
    }

    return ["text": texts.joined(separator: "\n"), "lines": lines]
  }
}

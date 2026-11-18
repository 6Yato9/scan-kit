import CoreImage
import UIKit
import Vision

/// Finds a document in a photo and returns a perspective-corrected crop of it.
///
/// Used when importing photos from the library: the in-app scanner (VisionKit)
/// already crops, but an imported photo of a page on a desk still has the desk
/// around it. Uses VNDetectDocumentSegmentationRequest (purpose-built for
/// documents) and falls back to rectangle detection.
enum DocumentDetector {
  struct Quad {
    let topLeft: CGPoint, topRight: CGPoint, bottomRight: CGPoint, bottomLeft: CGPoint
  }

  /// Returns the path of the corrected JPEG, or nil when no confident document
  /// outline was found (the caller then keeps the original photo).
  static func detectAndCorrect(path: String, outputPath: String, quality: Double) throws -> String? {
    guard let uiImage = UIImage(contentsOfFile: path), let upright = normalised(uiImage),
          let cg = upright.cgImage else {
      throw NSError(domain: "DocumentDetector", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Could not read image"])
    }
    guard let detected = try detect(cg) else { return nil }
    // Detected edges sit on the paper/background boundary, so a hairline of
    // desk survives the warp. Pull each corner slightly toward the centre.
    let quad = inset(detected, by: 0.012)

    let ci = CIImage(cgImage: cg)
    let w = ci.extent.width, h = ci.extent.height
    // Vision: normalised, origin bottom-left — same as Core Image's space.
    func p(_ v: CGPoint) -> CIVector { CIVector(x: v.x * w, y: v.y * h) }
    guard let filter = CIFilter(name: "CIPerspectiveCorrection") else { return nil }
    filter.setValue(ci, forKey: kCIInputImageKey)
    filter.setValue(p(quad.topLeft), forKey: "inputTopLeft")
    filter.setValue(p(quad.topRight), forKey: "inputTopRight")
    filter.setValue(p(quad.bottomRight), forKey: "inputBottomRight")
    filter.setValue(p(quad.bottomLeft), forKey: "inputBottomLeft")
    guard let out = filter.outputImage else { return nil }

    let context = CIContext(options: nil)
    guard let rendered = context.createCGImage(out, from: out.extent.integral),
          let data = UIImage(cgImage: rendered).jpegData(compressionQuality: CGFloat(quality)) else {
      return nil
    }
    try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
    return outputPath
  }

  private static func detect(_ cg: CGImage) throws -> Quad? {
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])

    // Each detector is optional: document segmentation needs the Neural Engine
    // and fails outright on simulators and some older devices, which must not
    // stop the rectangle fallback from running.
    let segmentation = VNDetectDocumentSegmentationRequest()
    do {
      try handler.perform([segmentation])
      if let r = segmentation.results?.first, r.confidence >= 0.6, plausible(r) {
        return Quad(topLeft: r.topLeft, topRight: r.topRight, bottomRight: r.bottomRight, bottomLeft: r.bottomLeft)
      }
    } catch {
      NSLog("[DocumentDetector] segmentation unavailable: %@", error.localizedDescription)
    }

    let rects = VNDetectRectanglesRequest()
    rects.minimumConfidence = 0.6
    rects.minimumSize = 0.3
    rects.maximumObservations = 1
    rects.quadratureTolerance = 30
    rects.minimumAspectRatio = 0.3
    do {
      try handler.perform([rects])
      if let r = rects.results?.first, plausible(r) {
        return Quad(topLeft: r.topLeft, topRight: r.topRight, bottomRight: r.bottomRight, bottomLeft: r.bottomLeft)
      }
    } catch {
      NSLog("[DocumentDetector] rectangle detection failed: %@", error.localizedDescription)
    }
    return nil
  }

  private static func inset(_ q: Quad, by f: CGFloat) -> Quad {
    let cx = (q.topLeft.x + q.topRight.x + q.bottomRight.x + q.bottomLeft.x) / 4
    let cy = (q.topLeft.y + q.topRight.y + q.bottomRight.y + q.bottomLeft.y) / 4
    func m(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x + (cx - p.x) * f * 2, y: p.y + (cy - p.y) * f * 2) }
    return Quad(topLeft: m(q.topLeft), topRight: m(q.topRight), bottomRight: m(q.bottomRight), bottomLeft: m(q.bottomLeft))
  }

  /// Reject outlines that are tiny or that are essentially the whole frame
  /// (nothing to crop — keep the original untouched).
  private static func plausible(_ r: VNRectangleObservation) -> Bool {
    let pts = [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft]
    // Shoelace area in normalised units.
    var area: CGFloat = 0
    for i in 0..<4 {
      let a = pts[i], b = pts[(i + 1) % 4]
      area += a.x * b.y - b.x * a.y
    }
    area = abs(area) / 2
    return area >= 0.15 && area <= 0.97
  }

  /// Bake EXIF orientation into the pixels so Vision and Core Image agree.
  private static func normalised(_ image: UIImage) -> UIImage? {
    if image.imageOrientation == .up { return image }
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: image.size))
    }
  }
}

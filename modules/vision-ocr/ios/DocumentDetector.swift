import CoreImage
import ImageIO
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
    // Decode at most 4096 px on the long edge with EXIF orientation applied:
    // a 48 MP photo decoded at full size costs ~200 MB per buffer, and pages
    // larger than this exceed what the filter pipeline can process anyway.
    guard let cg = uprightThumbnail(path: path, maxPixel: 4096) else {
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

    guard let rendered = ciContext.createCGImage(out, from: out.extent.integral),
          let data = UIImage(cgImage: rendered).jpegData(compressionQuality: CGFloat(quality)) else {
      return nil
    }
    try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
    return outputPath
  }

  private static func detect(_ cg: CGImage) throws -> Quad? {
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    var candidates: [VNRectangleObservation] = []

    // Run both detectors and keep the plausible outline covering the most of
    // the frame. Document segmentation is the better detector on a device, but
    // without the Neural Engine (simulators, some older devices) it can return
    // a confident outline of just part of the page — e.g. a strip around a
    // boxed total — while rectangle detection finds the whole sheet. The page
    // is the dominant object in a photo of a page, so larger wins.
    let segmentation = VNDetectDocumentSegmentationRequest()
    do {
      try handler.perform([segmentation])
      if let r = segmentation.results?.first, r.confidence >= 0.6, plausible(r) {
        candidates.append(r)
      }
    } catch {
      NSLog("[DocumentDetector] segmentation unavailable: %@", error.localizedDescription)
    }

    let rects = VNDetectRectanglesRequest()
    rects.minimumConfidence = 0.6
    rects.minimumSize = 0.3
    rects.maximumObservations = 3
    rects.quadratureTolerance = 30
    rects.minimumAspectRatio = 0.3
    do {
      try handler.perform([rects])
      candidates.append(contentsOf: (rects.results ?? []).filter(plausible))
    } catch {
      NSLog("[DocumentDetector] rectangle detection failed: %@", error.localizedDescription)
    }

    guard let best = candidates.max(by: { area($0) < area($1) }) else { return nil }
    return Quad(topLeft: best.topLeft, topRight: best.topRight, bottomRight: best.bottomRight, bottomLeft: best.bottomLeft)
  }

  private static func area(_ r: VNRectangleObservation) -> CGFloat {
    let pts = [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft]
    var a: CGFloat = 0
    for i in 0..<4 {
      let p = pts[i], q = pts[(i + 1) % 4]
      a += p.x * q.y - q.x * p.y
    }
    return abs(a) / 2
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
    let a = area(r)
    return a >= 0.15 && a <= 0.97
  }


  private static let ciContext = CIContext(options: [.cacheIntermediates: false])

  /// Decode an upright (EXIF-applied), size-capped bitmap so Vision and Core
  /// Image agree on orientation and memory stays bounded.
  private static func uprightThumbnail(path: String, maxPixel: Int) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
  }
}

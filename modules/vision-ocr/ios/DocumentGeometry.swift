import CoreImage
import Foundation
import ImageIO
import Vision

/// Page-outline detection and perspective correction on image files.
///
/// Conventions shared with JS (modules/vision-ocr/src/quad.ts):
/// a quad is 4 points top-left, top-right, bottom-right, bottom-left,
/// normalised 0...1 with a TOP-LEFT origin, in the image's UPRIGHT orientation
/// (EXIF orientation applied). Vision and Core Image use a bottom-left origin;
/// every conversion happens in this file.
///
/// Memory: inputs can be 12-48 MP photos on a phone. Images are only ever
/// decoded through CGImageSource thumbnails (subsampled decode, orientation
/// applied, capped size), never via UIImage, and each function decodes once.
/// No UIKit here so the file also compiles in a macOS test harness.
enum DocumentGeometry {
  struct Failure: Error {
    let code: String
    let message: String
  }

  /// Corner tolerance for warp input: corners may sit a hair outside the
  /// image (a user dragging a handle to the edge), never further.
  static let inputSlack: CGFloat = 0.01

  static let ciContext = CIContext(options: [
    .cacheIntermediates: false,
    // 8-bit working buffers: half the memory of the default half-float
    // format, and a resampling warp gains nothing from the extra precision.
    .workingFormat: NSNumber(value: CIFormat.RGBA8.rawValue),
  ])

  // MARK: - Files

  static func path(_ uri: String) -> String {
    if let url = URL(string: uri), url.isFileURL { return url.path }
    return uri
  }

  /// Pixel size of the image as displayed (EXIF orientation applied).
  static func uprightSize(source: CGImageSource) -> CGSize? {
    guard let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
          let h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
          w > 0, h > 0 else { return nil }
    let o = (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    return o >= 5 ? CGSize(width: h, height: w) : CGSize(width: w, height: h)
  }

  static func source(path: String) throws -> CGImageSource {
    guard FileManager.default.fileExists(atPath: path),
          let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL,
                                               [kCGImageSourceShouldCache: false] as CFDictionary) else {
      throw Failure(code: "ERR_IMAGE_READ", message: "Could not read image at \(path)")
    }
    return src
  }

  /// Upright (EXIF-applied) bitmap with the long edge capped at `maxPixel`.
  /// Never upscales.
  static func upright(source: CGImageSource, maxPixel: Int) -> CGImage? {
    var cap = maxPixel
    if let size = uprightSize(source: source) {
      cap = min(cap, Int(max(size.width, size.height).rounded()))
    }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: max(1, cap),
      kCGImageSourceShouldCacheImmediately: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary)
  }

  static func writeJPEG(_ image: CGImage, to path: String, quality: Double) throws {
    let url = URL(fileURLWithPath: path)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil) else {
      throw Failure(code: "ERR_IMAGE_WRITE", message: "Could not encode JPEG")
    }
    // No orientation property: the pixels are already upright.
    CGImageDestinationAddImage(dest, image, [
      kCGImageDestinationLossyCompressionQuality: max(0.05, min(1, quality)),
    ] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else {
      throw Failure(code: "ERR_IMAGE_WRITE", message: "Could not encode JPEG")
    }
    do {
      try (data as Data).write(to: url, options: .atomic)
    } catch {
      throw Failure(code: "ERR_IMAGE_WRITE", message: error.localizedDescription)
    }
  }

  // MARK: - Detection

  /// Page outline in an upright bitmap, or nil when not confident.
  static func detect(_ image: CGImage, minArea: CGFloat = 0.15) -> [CGPoint]? {
    detect(handler: VNImageRequestHandler(cgImage: image, options: [:]), minArea: minArea)
  }

  /// Runs document segmentation and rectangle detection and keeps the largest
  /// plausible outline. Segmentation is the better detector on a device, but
  /// without the Neural Engine (simulators, older devices) it can return a
  /// confident outline of just part of the page (a boxed total), while
  /// rectangle detection finds the whole sheet. The page is the dominant
  /// object in a photo of a page, so larger wins.
  ///
  /// The corners are returned exactly where the detector put them, ON the
  /// paper edge: no inward safety inset (an inset is what cut page corners).
  static func detect(handler: VNImageRequestHandler, minArea: CGFloat = 0.15,
                     maxArea: CGFloat = 0.985, useRectangles: Bool = true) -> [CGPoint]? {
    var segmented: [CGPoint]?
    var rectangles: [[CGPoint]] = []

    let segmentation = VNDetectDocumentSegmentationRequest()
    do {
      try handler.perform([segmentation])
      if let r = segmentation.results?.first, r.confidence >= 0.6 {
        segmented = topLeftOrigin(r)
      }
    } catch {
      NSLog("[DocumentGeometry] segmentation unavailable: %@", error.localizedDescription)
    }

    if useRectangles {
      let rects = VNDetectRectanglesRequest()
      rects.minimumConfidence = 0.6
      rects.minimumSize = 0.3
      rects.maximumObservations = 3
      rects.quadratureTolerance = 30
      rects.minimumAspectRatio = 0.3
      do {
        try handler.perform([rects])
        rectangles = (rects.results ?? []).map(topLeftOrigin)
      } catch {
        NSLog("[DocumentGeometry] rectangle detection failed: %@", error.localizedDescription)
      }
    }

    func plausible(_ q: [CGPoint]) -> Bool {
      let a = area(q)
      guard a >= minArea && a <= maxArea && isConvexClockwise(q) else { return false }
      // A band of background or shadow cut off by the frame (seen from the
      // simulator's segmentation: a strip along the bottom edge) has three or
      // four corners on the image border. A real page only does that when it
      // nearly fills the frame.
      let onBorder = q.filter { min($0.x, $0.y, 1 - $0.x, 1 - $0.y) < 0.02 }.count
      return onBorder < 3 || a >= 0.8
    }
    let rects = rectangles.filter(plausible)
    let seg = segmented.flatMap { plausible($0) ? $0 : nil }
    // Rectangle detection fits straight edges to image gradients, so its
    // corners are the more precise ones (within ~0.3% of the true corner on
    // test photos; segmentation is a low-resolution mask, up to ~0.7%). When
    // both found the same sheet, take the rectangle's corners.
    if let seg = seg, let match = rects.first(where: { maxCornerDistance($0, seg) < 0.03 }) {
      return match
    }
    let all = rects + (seg.map { [$0] } ?? [])
    return all.max(by: { area($0) < area($1) })
  }

  static func maxCornerDistance(_ a: [CGPoint], _ b: [CGPoint]) -> CGFloat {
    (0..<4).map { hypot(a[$0].x - b[$0].x, a[$0].y - b[$0].y) }.max() ?? .infinity
  }

  /// Vision observation (bottom-left origin) -> TL, TR, BR, BL with top-left origin.
  static func topLeftOrigin(_ r: VNRectangleObservation) -> [CGPoint] {
    [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft].map { CGPoint(x: $0.x, y: 1 - $0.y) }
  }

  // MARK: - Quad maths (normalised, top-left origin)

  static func area(_ q: [CGPoint]) -> CGFloat {
    var a: CGFloat = 0
    for i in 0..<4 {
      let p = q[i], n = q[(i + 1) % 4]
      a += p.x * n.y - n.x * p.y
    }
    return abs(a) / 2
  }

  /// TL -> TR -> BR -> BL turns clockwise on screen (y down): every cross
  /// product of consecutive edges is positive. Rejects self-intersecting,
  /// concave, mirrored and degenerate quads.
  static func isConvexClockwise(_ q: [CGPoint], aspect: CGFloat = 1) -> Bool {
    guard q.count == 4 else { return false }
    for i in 0..<4 {
      let a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4]
      let cross = (b.x - a.x) * aspect * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) * aspect
      if !(cross > 1e-6) { return false }
    }
    return true
  }

  /// Validates JS input: 8 finite numbers within -0.01...1.01 forming a
  /// non-degenerate convex quad in TL, TR, BR, BL order. Returns the points
  /// clamped into the image.
  static func parseQuad(_ values: [Double]) throws -> [CGPoint] {
    guard values.count == 8 else {
      throw Failure(code: "ERR_BAD_QUAD", message: "A quad needs 8 numbers, got \(values.count)")
    }
    let lo = -Double(inputSlack), hi = 1 + Double(inputSlack)
    for v in values where !v.isFinite || v < lo || v > hi {
      throw Failure(code: "ERR_BAD_QUAD", message: "Quad values must be finite and within 0...1")
    }
    let pts = stride(from: 0, to: 8, by: 2).map {
      CGPoint(x: min(1, max(0, values[$0])), y: min(1, max(0, values[$0 + 1])))
    }
    guard isConvexClockwise(pts), area(pts) >= 0.0005 else {
      throw Failure(code: "ERR_BAD_QUAD",
                    message: "Quad must be convex, non-degenerate, ordered top-left, top-right, bottom-right, bottom-left")
    }
    return pts
  }

  static func flatten(_ q: [CGPoint]) -> [Double] {
    q.flatMap { [Double($0.x), Double($0.y)] }
  }

  // MARK: - Public operations

  /// Page outline of the photo at `path`, or nil when not confident.
  static func detectQuad(path: String) throws -> [CGPoint]? {
    try autoreleasepool {
      let src = try source(path: path)
      guard let cg = upright(source: src, maxPixel: 2048) else {
        throw Failure(code: "ERR_IMAGE_READ", message: "Could not decode image")
      }
      return detect(cg)
    }
  }

  /// Bakes EXIF orientation into the pixels and caps the long edge.
  static func normalize(srcPath: String, outPath: String, maxEdge: Int, quality: Double) throws -> (Int, Int) {
    try autoreleasepool {
      let src = try source(path: srcPath)
      guard let cg = upright(source: src, maxPixel: max(1, maxEdge)) else {
        throw Failure(code: "ERR_IMAGE_READ", message: "Could not decode image")
      }
      try writeJPEG(cg, to: outPath, quality: quality)
      return (cg.width, cg.height)
    }
  }

  /// Perspective-corrects `quad` of the upright source into an upright JPEG
  /// with the long edge capped at `maxEdge`. An axis-aligned quad is a plain
  /// crop (so the full-image quad returns the image unchanged in geometry).
  static func warp(srcPath: String, quad: [CGPoint], outPath: String, quality: Double, maxEdge: Int) throws -> (Int, Int) {
    try autoreleasepool {
      let src = try source(path: srcPath)
      guard let full = uprightSize(source: src) else {
        throw Failure(code: "ERR_IMAGE_READ", message: "Could not read image size")
      }
      // Output size at full resolution, to pick the decode scale: decode just
      // enough pixels for the capped output (+25% so the final Lanczos pass
      // has detail to work with), never the whole 48 MP when 4 MP will do.
      func dist(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
        hypot((a.x - b.x) * full.width, (a.y - b.y) * full.height)
      }
      let outW = max(dist(quad[0], quad[1]), dist(quad[3], quad[2]))
      let outH = max(dist(quad[0], quad[3]), dist(quad[1], quad[2]))
      let cap = CGFloat(max(1, maxEdge))
      let scale = min(1, cap * 1.25 / max(outW, outH, 1))
      let decodeLong = Int((max(full.width, full.height) * scale).rounded(.up))
      guard let cg = upright(source: src, maxPixel: decodeLong) else {
        throw Failure(code: "ERR_IMAGE_READ", message: "Could not decode image")
      }

      let W = CGFloat(cg.width), H = CGFloat(cg.height)
      // Core Image space: pixels, bottom-left origin.
      let px = quad.map { CGPoint(x: $0.x * W, y: (1 - $0.y) * H) }
      let input = CIImage(cgImage: cg)
      var output: CIImage
      let tol: CGFloat = 0.75
      // Upright axis-aligned rectangle (TL really top-left): a plain crop.
      // A turned corner order (the page rotated) goes through the warp.
      let axisAligned = abs(px[0].y - px[1].y) < tol && abs(px[3].y - px[2].y) < tol
        && abs(px[0].x - px[3].x) < tol && abs(px[1].x - px[2].x) < tol
        && px[0].x < px[1].x && px[0].y > px[3].y
      if axisAligned {
        let minX = (px[0].x + px[3].x) / 2, maxX = (px[1].x + px[2].x) / 2
        let minY = (px[3].y + px[2].y) / 2, maxY = (px[0].y + px[1].y) / 2
        let rect = CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
          .integral.intersection(input.extent)
        guard rect.width >= 1, rect.height >= 1 else {
          throw Failure(code: "ERR_BAD_QUAD", message: "Quad is empty")
        }
        output = input.cropped(to: rect)
      } else {
        guard let f = CIFilter(name: "CIPerspectiveCorrection") else {
          throw Failure(code: "ERR_WARP", message: "Perspective correction unavailable")
        }
        f.setValue(input, forKey: kCIInputImageKey)
        f.setValue(CIVector(cgPoint: px[0]), forKey: "inputTopLeft")
        f.setValue(CIVector(cgPoint: px[1]), forKey: "inputTopRight")
        f.setValue(CIVector(cgPoint: px[2]), forKey: "inputBottomRight")
        f.setValue(CIVector(cgPoint: px[3]), forKey: "inputBottomLeft")
        guard let o = f.outputImage else {
          throw Failure(code: "ERR_WARP", message: "Perspective correction failed")
        }
        output = o
      }
      output = output.transformed(by: CGAffineTransform(translationX: -output.extent.minX, y: -output.extent.minY))

      let long = max(output.extent.width, output.extent.height)
      if long > cap + 0.5 {
        let s = cap / long
        let lanczos = CIFilter(name: "CILanczosScaleTransform")!
        lanczos.setValue(output.clampedToExtent(), forKey: kCIInputImageKey)
        lanczos.setValue(s, forKey: kCIInputScaleKey)
        lanczos.setValue(1.0, forKey: kCIInputAspectRatioKey)
        let target = CGRect(x: 0, y: 0,
                            width: max(1, (output.extent.width * s).rounded()),
                            height: max(1, (output.extent.height * s).rounded()))
        output = lanczos.outputImage!.cropped(to: target)
      }
      let rect = CGRect(x: 0, y: 0, width: max(1, output.extent.width.rounded()),
                        height: max(1, output.extent.height.rounded()))
      let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
      let space = cg.colorSpace.flatMap { $0.model == .rgb ? $0 : nil } ?? srgb
      guard let rendered = ciContext.createCGImage(output, from: rect, format: .RGBA8, colorSpace: space) else {
        throw Failure(code: "ERR_WARP", message: "Could not render the corrected page")
      }
      try writeJPEG(rendered, to: outPath, quality: quality)
      return (rendered.width, rendered.height)
    }
  }
}

import CoreGraphics
import Foundation

/// Decides when the document camera may auto-capture. Pure logic (no
/// AVFoundation/UIKit) so it is unit-testable in a macOS harness.
///
/// Holding still: a hand-held phone never gives a perfectly still outline, so
/// the hold is a budget, not a streak. Each steady frame adds its duration;
/// an unsteady frame (device motion, blur, refocusing, or an outline far off
/// the recent average) takes `decayRate` times its duration back instead of
/// restarting from zero, and a missed detection or two just pauses it. Only a
/// real move (the smoothed outline leaving `tolerance` of where the page has
/// been resting, a slow average that a sliding page outruns) or losing the
/// page restarts it. Every distance is relative to the page's own size, so a
/// small card and a page filling the frame are judged alike. It still needs
/// genuine steadiness: with decay 2, one bad frame in three never gets there.
///
/// One page, one shot: after a capture it stays disarmed until the page
/// changes — it leaves the frame, a corner moves by `changeDistance`, or its
/// CONTENT changes (the next sheet placed in the same spot, seen through a
/// coarse luminance signature of the page area, `PageSignature`, clearly
/// different from the captured one). Before it
/// fires again it checks that the page isn't the one just captured (the same
/// content, wherever it is): a hand passing over the page, or the same sheet
/// lifted and put back, re-arms it but doesn't shoot it twice.
struct AutoCaptureTracker {
  /// Seconds of steadiness needed before firing.
  var holdDuration: Double = 1.0
  /// How far (relative to the page's size) the smoothed outline may stray
  /// from where the page rests and still count as held.
  var tolerance: CGFloat = 0.03
  /// A raw outline jumping this far (relative) in one frame is a move: the
  /// smoothing snaps to it.
  var jumpTolerance: CGFloat = 0.12
  /// Hold seconds lost per second of unsteady frames.
  var decayRate: Double = 2.0
  /// A frame never counts for more than this (dropped frames, a stall).
  var maxStep: Double = 0.2
  /// The outline may vanish this long (a detector miss) before the hold is lost.
  var missingGrace: Double = 0.25
  /// Smallest outline (fraction of the frame) worth auto-capturing; smaller
  /// ones are shown but the user has to move closer.
  var minArea: CGFloat = 0.18
  /// How long the outline must be gone to re-arm after a capture.
  var rearmMissing: Double = 0.25
  /// Minimum time after a capture before a changed page can re-arm.
  var cooldown: Double = 1.0
  /// Corner movement (normalised) that counts as a different page / position.
  var changeDistance: CGFloat = 0.08
  /// Signature similarity at or above which two views show the same page.
  var sameContent: Double = PageSignature.sameThreshold
  /// Signature similarity below which two views show different pages.
  var differentContent: Double = PageSignature.differentThreshold
  /// Smoothing of the outline (0: frozen, 1: raw).
  var smoothing: CGFloat = 0.5
  /// How fast the resting position follows the outline (per frame).
  var anchorFollow: CGFloat = 0.1

  private(set) var smoothed: [CGPoint]?
  private(set) var anchor: [CGPoint]?
  private(set) var hold: Double = 0
  private(set) var armed = true
  private var lastTime: Double?
  private var missingSince: Double?
  private var capturedQuad: [CGPoint]?
  private var capturedSignature: PageSignature?
  private var capturedAt: Double = -.infinity
  /// The content at the start of the current hold.
  private var holdSignature: PageSignature?

  /// Feed one analysed frame. `signature` is the page content in this frame
  /// (nil when unknown). Returns progress toward auto-capture (0...1) and
  /// whether to fire now. The caller must call `didCapture` when it actually
  /// takes the shot (auto or manual).
  mutating func update(quad: [CGPoint]?, now: Double, steady: Bool,
                       signature: PageSignature? = nil) -> (stability: Double, fire: Bool) {
    let dt = lastTime.map { min(max(0, now - $0), maxStep) } ?? 0
    lastTime = now

    guard let raw = quad else {
      let since = missingSince ?? now
      missingSince = since
      // A missed detection or two only pauses the hold.
      if now - since >= missingGrace {
        smoothed = nil
        anchor = nil
        hold = 0
      }
      if !armed && now - since >= rearmMissing { armed = true }
      return (armed ? hold / holdDuration : 0, false)
    }
    missingSince = nil

    let scale = max(0.05, sqrt(DocumentGeometry.area(raw)))
    // This frame's outline far from the recent average: the detector is
    // unsure (or the page shook), so the frame doesn't count as steady.
    var frameSteady = steady
    if let s = smoothed, DocumentGeometry.maxCornerDistance(s, raw) / scale > tolerance * 1.5 { frameSteady = false }
    if let s = smoothed, DocumentGeometry.maxCornerDistance(s, raw) / scale <= jumpTolerance {
      smoothed = (0..<4).map {
        CGPoint(x: s[$0].x + (raw[$0].x - s[$0].x) * smoothing, y: s[$0].y + (raw[$0].y - s[$0].y) * smoothing)
      }
    } else {
      smoothed = raw
      anchor = nil
      hold = 0
    }
    let s = smoothed ?? raw
    // Content is only compared on steady frames (a blurred frame of the same
    // page can look like another page).
    let content = frameSteady ? signature : nil

    if !armed && now - capturedAt >= cooldown && isNewPage(s, content) {
      armed = true
      // The new page earns its own full hold.
      anchor = nil
      hold = 0
    }

    if let a = anchor {
      if DocumentGeometry.maxCornerDistance(s, a) / scale > tolerance {
        // Moved (or creeping) away from where it has been resting: start over.
        anchor = s
        hold = 0
      } else {
        // Where the page rests: a slow average, so noise doesn't push the
        // outline out of tolerance but a page that keeps sliding does.
        anchor = (0..<4).map {
          CGPoint(x: a[$0].x + (s[$0].x - a[$0].x) * anchorFollow, y: a[$0].y + (s[$0].y - a[$0].y) * anchorFollow)
        }
        if frameSteady {
          hold = min(holdDuration, hold + dt)
        } else {
          hold = max(0, hold - dt * decayRate)
        }
      }
    } else {
      anchor = s
    }

    if armed && isCapturedPage(content) {
      // The page just captured, back after a hand passed over it, or put
      // down again elsewhere: wait for a different one (from here).
      armed = false
      capturedQuad = s
      hold = 0
      anchor = nil
    }
    if let sig = content {
      // Different content under a steady outline (a sheet slid in): the new
      // page earns its own full hold.
      if let held = holdSignature, PageSignature.similarity(sig, held) < differentContent { hold = 0 }
      if hold == 0 { holdSignature = sig }
    }

    guard armed, DocumentGeometry.area(s) >= minArea else { return (0, false) }
    let progress = min(1, max(0, hold / holdDuration))
    return (progress, progress >= 1)
  }

  /// Record a capture of `quad` (nil when the page wasn't detected) showing
  /// `signature` (nil when unknown).
  mutating func didCapture(quad: [CGPoint]?, now: Double, signature: PageSignature? = nil) {
    armed = false
    capturedQuad = quad ?? smoothed
    capturedSignature = signature
    capturedAt = now
    anchor = nil
    hold = 0
    missingSince = nil
    // A manual shot with nothing detected: re-arm on the next outline that
    // appears after the cooldown (there is nothing to compare it with).
    if capturedQuad == nil { capturedQuad = [CGPoint](repeating: CGPoint(x: -1, y: -1), count: 4) }
  }

  /// The same tracker starting afresh on a new stream of frames (the camera
  /// paused for the review, the app was in the background, an interruption):
  /// it forgets the outline and the hold but remembers the last capture, so
  /// the page still under the camera isn't shot again while a new sheet is.
  func restarted() -> AutoCaptureTracker {
    var t = AutoCaptureTracker()
    t.armed = armed
    t.capturedQuad = capturedQuad
    t.capturedSignature = capturedSignature
    t.capturedAt = capturedAt
    return t
  }

  /// Restarts the hold after the shot settles (the photo arrived or failed),
  /// keeping what was captured.
  mutating func captureFinished(now: Double) {
    capturedAt = max(capturedAt, now)
    anchor = nil
    hold = 0
  }

  /// A different page than the last capture: moved, or showing other content.
  private func isNewPage(_ quad: [CGPoint], _ signature: PageSignature?) -> Bool {
    guard let previous = capturedQuad else { return true }
    if DocumentGeometry.maxCornerDistance(quad, previous) > changeDistance { return true }
    if let a = signature, let b = capturedSignature {
      return PageSignature.similarity(a, b) < differentContent
    }
    return false
  }

  /// The same content as the last capture (unknown content: not the same).
  private func isCapturedPage(_ signature: PageSignature?) -> Bool {
    guard let a = signature, let b = capturedSignature else { return false }
    return PageSignature.similarity(a, b) >= sameContent
  }
}

/// A coarse picture of a page's content: mean luminance of a grid of cells
/// laid out in the PAGE's own (perspective-corrected) space, normalised to
/// zero mean and unit variance. Independent of where the page sits in the
/// frame, its size, exposure and contrast; different text, a different
/// layout or a hand over the page change it.
struct PageSignature: Equatable {
  static let columns = 24
  static let rows = 32
  /// Similarity at or above which two signatures are surely the same page,
  /// and below which they are surely different pages. In between nothing is
  /// concluded and the tracker falls back to movement and removal, as before
  /// signatures existed, so a doubtful case is never worse than that.
  /// Calibrated (scratchpad harness) on 13 document photos and synthetic
  /// pages with the outline jittered like a detector's (corner noise sigma
  /// 0.15% of the frame): the same page scored 0.79-0.97, different pages
  /// median 0.32 (66 of 78 pairs below 0.5); real letters and invoices put
  /// down in exactly the same spot 0.42-0.51; the highest, 0.82, was two
  /// pages from one template (the same form filled in differently would be
  /// similar: those need lifting away or the shutter).
  static let sameThreshold = 0.85
  static let differentThreshold = 0.5
  /// Cells skipped at each edge (fraction of the page): the outline may
  /// include a sliver of background.
  static let margin: CGFloat = 0.05
  /// A page this uniform (standard deviation of cell means, 0-255) carries no
  /// content to compare: a blank sheet.
  static let minContrast: Float = 2.5
  /// Each cell is the mean of this many x this many samples: a box filter, so
  /// a cell's value barely changes when the outline shifts by a fraction of
  /// a cell (single samples would land on or off a letter's stroke).
  static let samplesPerSide = 6
  /// Neighbourhood (in cells) of the high-pass filter.
  static let smoothRadius = 3

  let values: [Float]

  /// `luma(x, y)`: brightness 0-255 at a normalised point of the upright
  /// frame (top-left origin). Each cell averages 2x2 samples.
  static func make(quad: [CGPoint], luma: (CGFloat, CGFloat) -> Float) -> PageSignature? {
    guard quad.count == 4, let map = Homography(unitSquareTo: quad) else { return nil }
    var values = [Float](repeating: 0, count: columns * rows)
    let span = 1 - 2 * margin
    let cw = span / CGFloat(columns), ch = span / CGFloat(rows)
    for r in 0..<rows {
      for c in 0..<columns {
        let u0 = margin + CGFloat(c) * cw, v0 = margin + CGFloat(r) * ch
        var sum: Float = 0
        for j in 0..<samplesPerSide {
          for i in 0..<samplesPerSide {
            let p = map.apply(u0 + (CGFloat(i) + 0.5) / CGFloat(samplesPerSide) * cw,
                              v0 + (CGFloat(j) + 0.5) / CGFloat(samplesPerSide) * ch)
            sum += luma(min(1, max(0, p.x)), min(1, max(0, p.y)))
          }
        }
        values[r * columns + c] = sum / Float(samplesPerSide * samplesPerSide)
      }
    }
    // High-pass: each cell minus the mean of its neighbourhood, so lighting
    // gradients and soft shadows (which differ between views of one page and
    // look alike across pages) don't dominate; text blocks, lines and their
    // ends do.
    if smoothRadius > 0 {
      var local = [Float](repeating: 0, count: values.count)
      for r in 0..<rows {
        for c in 0..<columns {
          var sum: Float = 0, k: Float = 0
          for rr in max(0, r - smoothRadius)...min(rows - 1, r + smoothRadius) {
            for cc in max(0, c - smoothRadius)...min(columns - 1, c + smoothRadius) {
              sum += values[rr * columns + cc]; k += 1
            }
          }
          local[r * columns + c] = sum / k
        }
      }
      for i in values.indices { values[i] -= local[i] }
    }
    let n = Float(values.count)
    let mean = values.reduce(0, +) / n
    let variance = values.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / n
    let sd = variance.squareRoot()
    guard sd >= minContrast else { return nil }
    return PageSignature(values: values.map { ($0 - mean) / sd })
  }

  /// Best normalised cross-correlation of `a` and `b` over shifts of up to
  /// one cell (outline jitter): 1 = the same picture, ~0 = unrelated.
  static func similarity(_ a: PageSignature, _ b: PageSignature) -> Double {
    guard a.values.count == columns * rows, b.values.count == columns * rows else { return 0 }
    var best = -1.0
    for dy in -1...1 {
      for dx in -1...1 {
        var sa = 0.0, sb = 0.0, saa = 0.0, sbb = 0.0, sab = 0.0, n = 0.0
        for r in max(0, -dy)..<min(rows, rows - dy) {
          for c in max(0, -dx)..<min(columns, columns - dx) {
            let x = Double(a.values[r * columns + c])
            let y = Double(b.values[(r + dy) * columns + (c + dx)])
            sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; n += 1
          }
        }
        guard n > 1 else { continue }
        let cov = sab / n - (sa / n) * (sb / n)
        let va = saa / n - (sa / n) * (sa / n), vb = sbb / n - (sb / n) * (sb / n)
        guard va > 1e-9, vb > 1e-9 else { continue }
        best = max(best, cov / (va * vb).squareRoot())
      }
    }
    return best
  }
}

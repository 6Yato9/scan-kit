import CoreGraphics
import Foundation

/// Decides when the document camera may auto-capture. Pure logic (no
/// AVFoundation/UIKit) so it is unit-testable in a macOS harness.
///
/// Fires only when a page outline has been detected continuously, every
/// corner has stayed within `tolerance` of where it was when the hold began
/// for `holdDuration` seconds, and the caller reports the frame as steady
/// (low device motion, focus settled, not blurrier than recent frames).
/// After a capture it stays disarmed until the page leaves the frame or a
/// clearly different page appears, so one page is never shot twice.
struct AutoCaptureTracker {
  /// Max corner movement (normalised units) that still counts as "held still".
  var tolerance: CGFloat = 0.015
  /// Seconds the outline must hold still before firing.
  var holdDuration: Double = 1.0
  /// Smallest outline (fraction of the frame) worth auto-capturing; smaller
  /// ones are shown but the user has to move closer.
  var minArea: CGFloat = 0.18
  /// How long the outline must be gone before re-arming after a capture.
  var rearmMissing: Double = 0.4
  /// Minimum time after a capture before a *different* page can re-arm.
  var cooldown: Double = 1.5
  /// Corner movement that counts as a different page / position.
  var changeDistance: CGFloat = 0.08

  private(set) var anchor: [CGPoint]?
  private(set) var stableSince: Double?
  private(set) var armed = true
  private var capturedQuad: [CGPoint]?
  private var capturedAt: Double = -.infinity
  private var missingSince: Double?

  /// Feed one analysed frame. Returns progress toward auto-capture (0...1)
  /// and whether to fire now. The caller must call `didCapture` when it
  /// actually takes the shot (auto or manual).
  mutating func update(quad: [CGPoint]?, now: Double, steady: Bool) -> (stability: Double, fire: Bool) {
    guard let quad = quad else {
      anchor = nil
      stableSince = nil
      if !armed {
        let since = missingSince ?? now
        missingSince = since
        if now - since >= rearmMissing { rearm() }
      }
      return (0, false)
    }
    missingSince = nil

    if !armed {
      guard now - capturedAt >= cooldown,
            let previous = capturedQuad,
            DocumentGeometry.maxCornerDistance(quad, previous) > changeDistance else {
        return (0, false)
      }
      rearm()
    }

    if let a = anchor, DocumentGeometry.maxCornerDistance(quad, a) <= tolerance {
      // Shaking or refocusing restarts the hold even if the outline held.
      if !steady { stableSince = now }
    } else {
      anchor = quad
      stableSince = now
    }

    guard DocumentGeometry.area(quad) >= minArea, let since = stableSince else { return (0, false) }
    let progress = min(1, max(0, (now - since) / holdDuration))
    return (progress, progress >= 1)
  }

  /// Record a capture of `quad` (nil when the page wasn't detected).
  mutating func didCapture(quad: [CGPoint]?, now: Double) {
    armed = false
    capturedQuad = quad ?? anchor
    capturedAt = now
    anchor = nil
    stableSince = nil
    missingSince = nil
    // A manual shot with nothing detected: re-arm on the next outline that
    // appears after the cooldown (there is nothing to compare it with).
    if capturedQuad == nil { capturedQuad = [CGPoint](repeating: CGPoint(x: -1, y: -1), count: 4) }
  }

  private mutating func rearm() {
    armed = true
    capturedQuad = nil
    missingSince = nil
    anchor = nil
    stableSince = nil
  }
}

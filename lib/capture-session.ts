// lib/capture-session.ts
//
// Scan Kit's own camera (app/camera.tsx) is a route, but every place that
// scans wants to `await` it like a picker: the Scan button, the viewer's Add
// pages and Retake, and the camera-first tools. A capture SESSION bridges the
// two: openCaptureSession() presents /camera and returns a promise; the camera
// screen claims the session, lets the user capture and review pages, stores
// the result and closes itself. The promise settles when the screen has gone
// (its unmount), so whatever the caller does next (saving, opening the
// viewer) happens on the screen below, never under a modal that is still
// being dismissed.
//
// Files: every capture is a full upright photo in Caches/scanner-src (written
// by the native view) plus a small rendered preview there. While the session
// is open the camera screen owns them (a cancelled session deletes them all).
// Once settled with pages, the caller owns the photos (`sourceUri`): the save
// paths (lib/save-scan, lib/add-pages, lib/retake-page) delete them after
// storing; previews are deleted by the camera screen. The startup sweep
// (lib/files.ts TEMP_DIRS) removes anything an interrupted session left.
//
// Pure geometry for captured pages (conversion to the save paths' input, the
// split of a book spread, the camera's status line) lives here too, so it is
// unit-tested without the screen.
import { router } from 'expo-router';
import { navigateWhenUnlocked } from './nav-guard';
import {
  FULL_QUAD,
  isConvexQuad,
  rotateCornerOrder,
  warpOutputSize,
  type PageGeometry,
  type Quad,
} from './quad';
import type { SourcePageInput } from './page-source';

/** One page captured by the camera, as the review shows it. */
export type CapturedPage = {
  /** Stable id for lists and animations. */
  key: string;
  /** The full upright photo (Caches/scanner-src). */
  sourceUri: string;
  /** Size of the photo in pixels. */
  width: number;
  height: number;
  /** The page cut from the photo: the outline (or the whole photo) and any turn (lib/quad.ts). */
  geometry: PageGeometry;
  /** True when the outline was found automatically; false = the whole photo. */
  detected: boolean;
  /** The page as it will be saved, rendered small for the review; null while it renders. */
  previewUri: string | null;
};

export type CaptureOptions = {
  /** Shown at the top of the camera, e.g. "Retake page 2", "ID card". */
  title?: string;
  /** At most this many pages (1 for a retake). Default: no limit. */
  maxPages?: number;
  /** The review's confirm action, e.g. "Save", "Add", "Replace". Default "Save". */
  doneLabel?: string;
  /** What the status line says while no page is found, e.g. "Fit both pages of the book in the frame". */
  guidance?: string;
};

type Session = {
  id: string;
  options: CaptureOptions;
  result: CapturedPage[] | null;
  resolve: (pages: CapturedPage[] | null) => void;
  claimed: boolean;
  settled: boolean;
  claimTimer: ReturnType<typeof setTimeout> | null;
};

/** How long the camera route gets to appear before an unclaimed session gives up. */
export const CLAIM_TIMEOUT_MS = 8000;

let current: Session | null = null;
let seq = 0;

function settle(s: Session, pages: CapturedPage[] | null): void {
  if (s.settled) return;
  s.settled = true;
  if (s.claimTimer) clearTimeout(s.claimTimer);
  s.claimTimer = null;
  if (current === s) current = null;
  s.resolve(pages);
}

/** True while a camera session is open (one at a time). */
export function isCaptureSessionOpen(): boolean {
  return !!current && !current.settled;
}

/**
 * Presents the camera and resolves with the reviewed pages, or null when the
 * user closed it (or another session is already open). `present` is for tests;
 * the app presents the /camera route.
 */
export function openCaptureSession(
  options: CaptureOptions = {},
  present: (id: string) => void = id => router.push({ pathname: '/camera', params: { session: id } }),
): Promise<CapturedPage[] | null> {
  if (isCaptureSessionOpen()) return Promise.resolve(null);
  return new Promise(resolve => {
    const s: Session = {
      id: `cap-${Date.now()}-${++seq}`,
      options,
      result: null,
      resolve,
      claimed: false,
      settled: false,
      claimTimer: null,
    };
    current = s;
    // Started from a tap, but the caller may have awaited settings first.
    navigateWhenUnlocked(() => {
      if (s.settled) return;
      try {
        present(s.id);
      } catch (err) {
        console.error('Camera: could not present', err);
        settle(s, null);
        return;
      }
      // A route that never mounts (navigation refused) must not leave the
      // caller waiting for ever.
      s.claimTimer = setTimeout(() => {
        if (!s.claimed) settle(s, null);
      }, CLAIM_TIMEOUT_MS);
    });
  });
}

/** The camera screen takes the session: its options, or null when it is unknown or already over. */
export function claimCaptureSession(id: string | undefined): CaptureOptions | null {
  const s = current;
  if (!s || s.settled || !id || s.id !== id) return null;
  s.claimed = true;
  if (s.claimTimer) clearTimeout(s.claimTimer);
  s.claimTimer = null;
  return s.options;
}

/** The pages the session will resolve with once the camera screen has closed. */
export function setCaptureResult(id: string, pages: CapturedPage[]): void {
  if (current && current.id === id && !current.settled) current.result = pages;
}

/**
 * The camera screen has gone: settles the session with the stored result
 * (null when the user closed without saving). Returns the pages handed over.
 */
export function endCaptureSession(id: string): CapturedPage[] | null {
  const s = current;
  if (!s || s.id !== id || s.settled) return null;
  const pages = s.result;
  settle(s, pages);
  return pages;
}

/** Tests only. */
export function resetCaptureSessionsForTests(): void {
  if (current?.claimTimer) clearTimeout(current.claimTimer);
  current = null;
}

// ── Pages ────────────────────────────────────────────────────────────────────

/** The geometry a fresh capture starts with: its detected outline, else the whole photo. */
export function initialGeometry(quad: number[] | null | undefined): { geometry: PageGeometry; detected: boolean } {
  if (quad && quad.length === 8 && isConvexQuad(quad.map(n => Math.min(1, Math.max(0, n))))) {
    return { geometry: { quad: quad.map(n => Math.min(1, Math.max(0, n))), rotation: 0 }, detected: true };
  }
  return { geometry: { quad: [...FULL_QUAD], rotation: 0 }, detected: false };
}

/**
 * What the save paths take for a reviewed page (lib/page-source
 * SourcePageInput: the outline on the upright photo, then the turn).
 */
export function toSourceInput(sourceUri: string, geometry: PageGeometry): SourcePageInput {
  return {
    sourceUri,
    quad: rotateCornerOrder(geometry.quad, -geometry.rotation),
    rotation: geometry.rotation,
  };
}

/** Area of a quad (normalised units, so 1 = the whole frame). */
export function quadArea(q: Quad): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    a += q[i * 2] * q[j * 2 + 1] - q[j * 2] * q[i * 2 + 1];
  }
  return Math.abs(a) / 2;
}

/**
 * Projective map of the unit square onto quad `q` (corner order TL,TR,BR,BL):
 * where the point (u, v) of the finished page lies on the photo.
 */
export function quadPoint(q: Quad, u: number, v: number): { x: number; y: number } {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  const den = dx1 * dy2 - dx2 * dy1;
  if ((Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) && Math.abs(den) > 1e-12) {
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  const w = g * u + h * v + 1;
  return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w };
}

/**
 * Book mode: a captured spread (the finished page is wider than tall) becomes
 * its left and right page, split down the true middle of the page in
 * perspective; anything else stays one page. Both halves keep the photo, so
 * each can be re-cropped later.
 */
export function splitSpread(geometry: PageGeometry, width: number, height: number): PageGeometry[] {
  const out = warpOutputSize(geometry.quad, width, height);
  if (!(out.width > out.height)) return [geometry];
  const q = geometry.quad;
  const top = quadPoint(q, 0.5, 0);
  const bottom = quadPoint(q, 0.5, 1);
  const left: Quad = [q[0], q[1], top.x, top.y, bottom.x, bottom.y, q[6], q[7]];
  const right: Quad = [top.x, top.y, q[2], q[3], q[4], q[5], bottom.x, bottom.y];
  const clamp = (v: Quad) => v.map(n => Math.min(1, Math.max(0, n)));
  return [
    { quad: clamp(left), rotation: geometry.rotation },
    { quad: clamp(right), rotation: geometry.rotation },
  ];
}

/** How far (normalised) the farthest corner of `b` is from the same corner of `a`. */
export function maxCornerDelta(a: Quad, b: Quad): number {
  let d = 0;
  for (let i = 0; i < 4; i++) d = Math.max(d, Math.hypot(a[i * 2] - b[i * 2], a[i * 2 + 1] - b[i * 2 + 1]));
  return d;
}

/**
 * Back in the camera after the review, auto-capture waits for a NEW page:
 * the outline must disappear or move this far (a corner, normalised) from
 * where the last photo was taken. Same rule the native view applies between
 * shots, which it forgets when the camera pauses for the review.
 */
export const NEW_PAGE_DELTA = 0.08;

// ── Status line ──────────────────────────────────────────────────────────────

/** An outline smaller than this share of the frame is too far away to capture (the native view needs 18%). */
export const MIN_PAGE_AREA = 0.18;

export type CameraStatusInput = {
  /** Live outline from the camera (null = none found). */
  quad: Quad | null;
  /** 0..1 progress toward the automatic shot. */
  stability: number;
  autoCapture: boolean;
  /** The shutter fired and the photo is on its way. */
  capturing: boolean;
  /** Pages captured since the outline last disappeared (the camera waits for a new page). */
  justCaptured: number | null;
  guidance?: string;
};

/** The one line under the preview: what the camera is doing and what the user should do. */
export function cameraStatus(s: CameraStatusInput): string {
  if (s.capturing) return 'Capturing…';
  if (s.justCaptured !== null) {
    return s.autoCapture
      ? `Page ${s.justCaptured} captured. Show the next page.`
      : `Page ${s.justCaptured} captured`;
  }
  if (!s.quad) return s.guidance ?? 'Looking for a page';
  if (quadArea(s.quad) < MIN_PAGE_AREA) return 'Move closer';
  if (!s.autoCapture) return 'Page found. Tap the shutter.';
  return 'Hold still';
}

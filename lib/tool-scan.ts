// lib/tool-scan.ts
// Camera capture for everything that scans: the Scan button
// (contexts/scan-context.tsx), the viewer's Add pages and Retake, and the
// camera-first tools (Book mode, ID card, Extract text, Whiteboard).
//
// Two cameras (Settings › Scan › Camera):
//  - Scan Kit camera (app/camera.tsx, lib/capture-session.ts): the default
//    wherever this build has the native view. Every page keeps its full photo
//    and outline, so a crop can be widened later; pages come back as
//    SourcePageInput (lib/page-source.ts).
//  - Apple's document scanner (VisionKit, react-native-document-scanner-plugin):
//    the fallback, and the only camera of builds without the native view.
//    Pages come back as finished, cropped image URIs.
// Outcomes are normalised into pages, "cancelled" (null) or a ToolScanError
// with copy that is safe to show.
import { Alert, Linking } from 'react-native';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { getScanSettings } from './storage';
import { autoCropDocument } from './document-detect';
import { withSystemUI } from './system-ui';
import { deleteDisposableTemps, moveScannerOutputToCaches } from './files';
import { geometryOfInput, isSourceInput, renderGeometry, type ScanPageInput, type SourcePageInput } from './page-source';
import { openCaptureSession, toSourceInput, type CaptureOptions } from './capture-session';
import { isDocumentCameraAvailable } from '../modules/vision-ocr/src/DocumentCameraView';

const SCAN_QUALITY = { low: 50, medium: 75, high: 90 } as const;

/** Caches folder of the Scan Kit camera's photos (written by the native view) and pages rendered from them. */
export const CAMERA_TEMP_DIR = 'scanner-src';

export class ToolScanError extends Error {
  constructor(
    readonly kind: 'permission' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ToolScanError';
  }
}

export type CameraKind = 'scankit' | 'apple';

/** Whether this build has Scan Kit's own camera view. */
export function scanKitCameraAvailable(): boolean {
  return isDocumentCameraAvailable();
}

/** The camera Scan opens: the user's choice, or Apple's scanner when this build has no camera view. */
export async function cameraChoice(): Promise<CameraKind> {
  if (!scanKitCameraAvailable()) return 'apple';
  try {
    return (await getScanSettings()).camera === 'apple' ? 'apple' : 'scankit';
  } catch {
    return 'scankit';
  }
}

/**
 * Apple's document scanner: every captured page as a finished image (it can
 * capture several in one session — callers must handle all of them), or null
 * when the user cancelled.
 */
export async function scanWithAppleScanner(): Promise<string[] | null> {
  const settings = await getScanSettings();
  let images: string[] | undefined;
  try {
    // Tracked so the app lock doesn't present over the camera (lib/system-ui).
    const res = await withSystemUI(
      () => DocumentScanner.scanDocument({ croppedImageQuality: SCAN_QUALITY[settings.quality] }),
      () => ({ scannedImages: [] as string[] }),
    );
    // Out of Documents (shown in the Files app) straight away.
    images = moveScannerOutputToCaches(res.scannedImages ?? []);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    if (/cancel|user.+(stop|dismiss)/i.test(msg)) return null;
    if (/permission|denied|not.+granted/i.test(msg)) {
      throw new ToolScanError('permission', 'Scan Kit needs camera access to scan. Turn it on in Settings.');
    }
    throw new ToolScanError('unavailable', 'The document camera isn’t available right now. Try again, or import a photo instead.');
  }
  return images && images.length ? images : null;
}

/**
 * Opens the camera the user chose and returns the captured pages, ready for
 * the save paths (saveScan / addPagesToDocument / retakePage): photos with
 * their reviewed crop from Scan Kit's camera, finished images from Apple's
 * scanner. Null when the user cancelled. `options.maxPages` caps both
 * cameras (extra pages from Apple's scanner are deleted).
 *
 * Scan Kit's camera shows camera-permission problems itself, so only Apple's
 * scanner throws ToolScanError.
 */
export async function scanPagesWithCamera(options: CaptureOptions = {}): Promise<ScanPageInput[] | null> {
  if ((await cameraChoice()) === 'scankit') {
    const pages = await openCaptureSession(options);
    return pages && pages.length ? pages.map(p => toSourceInput(p.sourceUri, p.geometry)) : null;
  }
  const images = await scanWithAppleScanner();
  if (!images) return null;
  const max = options.maxPages;
  if (max && max > 0 && images.length > max) {
    deleteTempFiles(images.slice(max));
    return images.slice(0, max);
  }
  return images;
}

/** A fresh file:// URI in Caches/scanner-src for a page rendered from a capture (swept at startup). */
export function cameraTempUri(tag: string): string {
  const dir = new Directory(Paths.cache, CAMERA_TEMP_DIR);
  dir.create({ intermediates: true, idempotent: true });
  return new File(dir, `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`).uri;
}

/**
 * The finished page of a captured photo, rendered (perspective-corrected and
 * turned) into a temp file; the photo itself is left alone.
 */
export async function renderSourcePage(page: SourcePageInput, quality: number, maxEdge?: number): Promise<string> {
  return renderGeometry(page.sourceUri, geometryOfInput(page), cameraTempUri('page'), quality, maxEdge);
}

/**
 * Camera pages as finished images, for tools that read a page rather than
 * keep it (Extract text). Photos are rendered and then deleted.
 */
export async function scanWithCamera(options: CaptureOptions = {}): Promise<string[] | null> {
  const pages = await scanPagesWithCamera(options);
  if (!pages) return null;
  const settings = await getScanSettings();
  const out: string[] = [];
  try {
    for (const p of pages) {
      out.push(isSourceInput(p) ? await renderSourcePage(p, SCAN_QUALITY[settings.quality] / 100) : p);
    }
  } catch (err) {
    deleteTempFiles(out);
    throw err;
  } finally {
    deleteDisposableTemps(pages.filter(isSourceInput).map(p => p.sourceUri));
  }
  return out;
}

/** Shows the right alert for a failed scan. */
export function alertScanError(err: unknown): void {
  if (err instanceof ToolScanError && err.kind === 'permission') {
    Alert.alert('Camera access needed', err.message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Open Settings', onPress: () => Linking.openSettings() },
    ]);
    return;
  }
  Alert.alert(
    'Couldn’t open the camera',
    err instanceof ToolScanError ? err.message : 'Something went wrong starting the scanner. Try again.',
  );
}

/** Best-effort removal of temp files a tool created (manipulator output, etc.). */
export function deleteTempFiles(uris: (string | null | undefined)[]): void {
  for (const uri of uris) {
    if (!uri) continue;
    try {
      const f = new File(uri.split('?')[0]);
      if (f.exists) f.delete();
    } catch {
      // ignore
    }
  }
}

/**
 * Picks photos from the library; null when cancelled. By default each photo is
 * auto-cropped to the page it shows (lib/document-detect: Apple Vision finds the
 * page and corrects perspective; photos without a confident outline pass
 * through unchanged). The picker's own copies are removed once replaced.
 */
export async function pickPhotos(multiple = true, options: { autoCrop?: boolean } = {}): Promise<string[] | null> {
  const res = await withSystemUI(
    () => ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: multiple,
      quality: 1,
    }),
    (): ImagePicker.ImagePickerResult => ({ canceled: true, assets: null }),
  );
  if (res.canceled || !res.assets.length) return null;
  const picked = res.assets.map(a => a.uri);
  if (options.autoCrop === false) return picked;
  const settings = await getScanSettings();
  const cropped: string[] = [];
  for (const uri of picked) {
    const result = await autoCropDocument(uri, SCAN_QUALITY[settings.quality] / 100);
    cropped.push(result.uri);
    if (result.uri.split('?')[0] !== uri.split('?')[0]) deleteDisposableTemps([uri]);
    // No page outline found: kept as photographed. The document saved from it
    // says so (scan-context noteNewDocument → "Couldn't find the page edges · Crop").
    else if (!result.detected) uncroppedPicks.add(result.uri.split('?')[0]);
  }
  return cropped;
}

/** Photos pickPhotos returned uncropped (no page edges found), until a save asks about them. */
const uncroppedPicks = new Set<string>();

/**
 * Which of `pages` (zero-based) are photos pickPhotos couldn't find the page
 * edges in. Each is reported once: asking forgets them.
 */
export function takeUncroppedPages(pages: ScanPageInput[]): number[] {
  const out: number[] = [];
  pages.forEach((p, i) => {
    // Photos kept with their source (lib/page-source) carry their own outline.
    if (typeof p !== 'string') return;
    const key = p.split('?')[0];
    if (uncroppedPicks.delete(key)) out.push(i);
  });
  return out;
}

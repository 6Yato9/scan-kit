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
//    Pages come back as finished, cropped image URIs. iOS only: on Android
//    that package is Google's Play-Services scanner, which is never linked
//    (react-native.config.js) nor loaded.
//  - Android: Scan Kit's camera only (there is no choice to make). A device
//    without any camera (or a build without the view) can't scan: scanning
//    says so and offers to import photos instead (importInstead); those
//    photos come back like Apple's pages.
// Outcomes are normalised into pages, "cancelled" (null) or a ToolScanError
// with copy that is safe to show.
import { Alert, Linking, Platform } from 'react-native';
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

/**
 * Whether the device has a camera at all (Android builds report it; iOS
 * devices always have one, and the camera screen explains the rare case).
 */
export function deviceHasCamera(): boolean {
  try {
    // Loaded here: the module's JS reaches for native code as it loads.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { VisionOcr } = require('../modules/vision-ocr/src') as typeof import('../modules/vision-ocr/src');
    return typeof VisionOcr?.hasCamera === 'function' ? VisionOcr.hasCamera() : true;
  } catch {
    return true;
  }
}

/** The camera Scan opens: the user's choice, or Apple's scanner when this build has no camera view. Android: always Scan Kit's. */
export async function cameraChoice(): Promise<CameraKind> {
  if (Platform.OS === 'android') return 'scankit';
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
  if (Platform.OS !== 'ios') {
    throw new ToolScanError('unavailable', 'The document camera isn’t available right now. Try again, or import a photo instead.');
  }
  const settings = await getScanSettings();
  let images: string[] | undefined;
  try {
    // Loaded here, on iOS only: its JS looks up the native module as it loads,
    // and Android doesn't link it (react-native.config.js).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const scannerModule = require('react-native-document-scanner-plugin');
    const DocumentScanner = (scannerModule.default ?? scannerModule) as typeof import('react-native-document-scanner-plugin').default;
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
  if (Platform.OS === 'android' && (!scanKitCameraAvailable() || !deviceHasCamera())) return importInstead(options);
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

/** Copy of the "no camera" dialog (exported for tests). */
export const NO_CAMERA = {
  title: 'No camera on this device',
  message: 'Scan Kit can’t find a camera to scan with. Import photos of your documents instead: Scan Kit keeps them as pages, like a scan.',
  importLabel: 'Import photos',
} as const;

/**
 * Android without a camera to scan with: says so and offers to import photos
 * instead. The picked photos are the scan's pages (null when the user cancels
 * either step), capped at `maxPages`.
 */
async function importInstead(options: CaptureOptions): Promise<ScanPageInput[] | null> {
  const choice = await new Promise<'import' | 'cancel'>(resolve => {
    Alert.alert(
      NO_CAMERA.title,
      NO_CAMERA.message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve('cancel') },
        { text: NO_CAMERA.importLabel, onPress: () => resolve('import') },
      ],
      { cancelable: true, onDismiss: () => resolve('cancel') },
    );
  });
  if (choice !== 'import') return null;
  const max = options.maxPages;
  const photos = await pickPhotos(max !== 1);
  if (!photos?.length) return null;
  if (max && max > 0 && photos.length > max) {
    deleteTempFiles(photos.slice(max));
    return photos.slice(0, max);
  }
  return photos;
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

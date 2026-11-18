// lib/tool-scan.ts
// Camera capture for the camera-first tools (Book mode, ID card, Extract text,
// Whiteboard). Normalises the document scanner's outcomes into "images",
// "cancelled" (null) or a ToolScanError with copy that is safe to show.
import { Alert, Linking } from 'react-native';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { getScanSettings } from './storage';
import { autoCropDocument } from './document-detect';
import { withSystemUI } from './system-ui';
import { deleteDisposableTemps, moveScannerOutputToCaches } from './files';

const SCAN_QUALITY = { low: 50, medium: 75, high: 90 } as const;

export class ToolScanError extends Error {
  constructor(
    readonly kind: 'permission' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ToolScanError';
  }
}

/**
 * Opens the document camera and returns every captured page (the iOS scanner
 * can capture several in one session — callers must handle all of them), or
 * null when the user cancelled.
 */
export async function scanWithCamera(): Promise<string[] | null> {
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
export function takeUncroppedPages(pages: string[]): number[] {
  const out: number[] = [];
  pages.forEach((p, i) => {
    const key = p.split('?')[0];
    if (uncroppedPicks.delete(key)) out.push(i);
  });
  return out;
}

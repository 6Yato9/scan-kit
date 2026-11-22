// app/+native-intent.tsx
// "Open in Scan Kit": a PDF or an image shared to the app arrives as a file://
// URL (iOS) or a content:// URL (Android). Route it to /import, which saves it
// as a document and opens the viewer. Links into Scan Kit's own storage and
// links aimed at /import from outside go Home (lib/incoming-file); anything
// else (the app's own links) passes through unchanged.
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { Paths } from 'expo-file-system';
import {
  isOwnContentUrl,
  isOwnFileUrl,
  routeForIncomingUrl,
  type IncomingContext,
} from '@/lib/incoming-file';
import { VisionOcr } from '@/modules/vision-ocr/src';

/** The app's container ("…/Application/<id>/"), the parent of Documents. */
function containerRoot(): string {
  const docs = Paths.document.uri.replace(/\/+$/, '');
  return docs.slice(0, docs.lastIndexOf('/') + 1);
}

function incomingContext(): IncomingContext {
  if (Platform.OS === 'android') {
    let shareKey: string | null = null;
    try {
      shareKey = typeof VisionOcr?.incomingShareKey === 'function' ? VisionOcr.incomingShareKey() : null;
    } catch {}
    const pkg = Constants.expoConfig?.android?.package ?? null;
    return { shareKey, fileUrls: false, isOwn: url => isOwnContentUrl(url, pkg) };
  }
  let root = '';
  try {
    root = containerRoot();
  } catch {}
  return { fileUrls: true, isOwn: url => isOwnFileUrl(url, root) };
}

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return routeForIncomingUrl(path, incomingContext());
  } catch {
    // Never let a bad URL crash launch.
    return '/';
  }
}

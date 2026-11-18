// app/+native-intent.tsx
// "Open in Scan Kit": a PDF or an image shared to the app arrives as a file://
// URL. Route it to /import, which saves it as a document and opens the viewer.
// Anything else (the app's own links) passes through unchanged.
import { routeForIncomingUrl } from '@/lib/incoming-file';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return routeForIncomingUrl(path);
  } catch {
    // Never let a bad URL crash launch.
    return '/';
  }
}

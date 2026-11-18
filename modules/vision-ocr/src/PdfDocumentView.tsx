// Native PDFKit viewer for imported PDF documents (iOS). Exposes
// `PdfDocumentView` (or null when the native view isn't in this build — the
// caller then falls back to a WebView).
import { requireNativeView } from 'expo';
import type { ViewProps } from 'react-native';

export type PdfDocumentViewProps = ViewProps & {
  /** file:// URI of the PDF. */
  source: string;
  /** Background behind the pages, e.g. '#111111'. */
  backgroundHex?: string;
  /** Zero-based page to open at instead of the first (applied once per load). */
  initialPage?: number;
  /** `page` is zero-based. */
  onPageChange?: (e: { nativeEvent: { page: number; count: number } }) => void;
  /** `message` is 'locked' for a password-protected PDF; anything else means unreadable. */
  onLoadError?: (e: { nativeEvent: { message: string } }) => void;
};

type ExpoGlobal = { getViewConfig?: (moduleName: string, viewName?: string) => unknown };

/**
 * Whether this build registers the VisionOcr view. The VisionOcr *module* is
 * present in builds older than the view too, so its presence proves nothing:
 * only the view config does. (requireNativeView never throws for a missing
 * view — it warns and returns a component that renders nothing.)
 */
export function hasNativePdfView(expo: ExpoGlobal | undefined = (globalThis as { expo?: ExpoGlobal }).expo): boolean {
  try {
    return !!expo?.getViewConfig?.('VisionOcr');
  } catch {
    return false;
  }
}

function load(): React.ComponentType<PdfDocumentViewProps> | null {
  if (!hasNativePdfView()) return null;
  try {
    return requireNativeView<PdfDocumentViewProps>('VisionOcr');
  } catch {
    return null;
  }
}

export const PdfDocumentView = load();

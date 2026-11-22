// Native viewer for imported PDF documents: PDFKit on iOS, PDFium on Android
// (port phase 3, PdfDocumentView.kt). Exposes `PdfDocumentView` (or null when
// the native view isn't in this build — the caller then falls back).
import { requireNativeView } from 'expo';
import { Platform, type ViewProps } from 'react-native';
import { VisionOcr } from './index';

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
export function hasNativePdfView(
  expo: ExpoGlobal | undefined = (globalThis as { expo?: ExpoGlobal }).expo,
  os: string = Platform.OS,
  androidViewer: boolean = androidHasPdfViewer(),
): boolean {
  // Android builds of port phase 2 registered a placeholder in the PDF
  // viewer's slot (the camera view needs the second one); phase-3 builds
  // say they hold the real viewer (VisionOcr.hasPdfView).
  if (os === 'android' && !androidViewer) return false;
  try {
    return !!expo?.getViewConfig?.('VisionOcr');
  } catch {
    return false;
  }
}

function androidHasPdfViewer(): boolean {
  try {
    return typeof VisionOcr?.hasPdfView === 'function' && VisionOcr.hasPdfView() === true;
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

// Native PDFKit viewer for imported PDF documents (iOS). Exposes
// `PdfDocumentView` (or null when the native view isn't in this build — the
// caller then falls back to a WebView).
import { requireNativeView } from 'expo';
import { NativeModulesProxy } from 'expo-modules-core';
import type { ViewProps } from 'react-native';

export type PdfDocumentViewProps = ViewProps & {
  /** file:// URI of the PDF. */
  source: string;
  /** Background behind the pages, e.g. '#111111'. */
  backgroundHex?: string;
  onPageChange?: (e: { nativeEvent: { page: number; count: number } }) => void;
  onLoadError?: (e: { nativeEvent: { message: string } }) => void;
};

function load(): React.ComponentType<PdfDocumentViewProps> | null {
  try {
    // Present only in dev clients built after the PDF view was added.
    if (!NativeModulesProxy?.VisionOcr && !(globalThis as any).expo?.modules?.VisionOcr) return null;
    return requireNativeView<PdfDocumentViewProps>('VisionOcr');
  } catch {
    return null;
  }
}

export const PdfDocumentView = load();

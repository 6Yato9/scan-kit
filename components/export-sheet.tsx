// components/export-sheet.tsx
// Export / share / print a document.
//
// The native share sheet and print dialog are presented ON TOP of this sheet
// (presenting over an open RN Modal works; presenting while it is dismissing
// does not), so there is no close-then-share timing race. Nothing here ever
// waits on the share sheet: `shareFile` returns as soon as the sheet is up, so
// the UI can't get stuck if expo-sharing never settles. Work in progress shows a
// progress state with Cancel, and closing the sheet cancels it too.
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import JSZip from 'jszip';
import { generatePdf, PageSize, PdfCancelledError, PdfError, PdfQuality, PdfProgressPhase } from '@/lib/pdf';
import {
  cleanFileUri,
  clearExportCache,
  exportFileName,
  makeExportDir,
  placeExportFile,
  printFile,
  shareFile,
  ShareError,
} from '@/lib/share';
import { ocrAvailable } from '@/lib/ocr';
import { BottomSheet, SheetGroup, SheetHeader, SheetRow } from '@/components/bottom-sheet';
import { SectionLabel } from '@/components/section-label';
import { PrimaryButton } from '@/components/primary-button';
import { useToast } from '@/components/toast';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { getDocSettings } from '@/lib/storage';
import { Radius, Spacing, Type } from '@/lib/theme';

type Props = {
  visible: boolean;
  document: Document;
  onClose: () => void;
};

type Action = 'pdf' | 'searchable' | 'small' | 'images' | 'print';

type Busy = { title: string; label: string; progress: number };

type BuiltFile = { uri: string; mimeType: string; UTI: string };

class CancelledError extends Error {}

const PDF_FILE = { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' };

function pdfPhaseLabel(phase: PdfProgressPhase, done: number, total: number): string {
  if (phase === 'rendering') return 'Finishing up';
  const n = Math.min(done + 1, total);
  if (phase === 'reading-text') return `Recognizing text on page ${n} of ${total}`;
  return total === 1 ? 'Preparing page' : `Preparing page ${n} of ${total}`;
}

/** A specific, human message for anything that went wrong. Never shows raw errors. */
function errorMessage(err: unknown, action: Action): { title: string; body: string } {
  const title = action === 'print' ? 'Couldn’t print' : 'Couldn’t export';
  if (err instanceof ShareError) return { title, body: err.message };
  if (err instanceof PdfError) {
    if (err.kind === 'read') return { title, body: `${err.message} Try again, or remove that page from the document.` };
    if (err.kind === 'timeout') {
      return { title, body: 'This document took too long to process. Try “Smaller PDF”, or split it into fewer pages.' };
    }
    if (err.kind === 'empty') return { title, body: 'This document has no pages to export.' };
    return { title, body: 'Something went wrong while creating the PDF. Try again.' };
  }
  if (action === 'images') return { title, body: 'Couldn’t prepare the images. Check that your device has free space and try again.' };
  return { title, body: 'Something went wrong. Try again.' };
}

export function ExportSheet({ visible, document, onClose }: Props) {
  const { colors } = useTheme();
  const toast = useToast();
  const [busy, setBusy] = useState<Busy | null>(null);
  const [pageSize, setPageSize] = useState<PageSize>('A4');
  const [quality, setQuality] = useState<PdfQuality>('standard');
  const abortRef = useRef<AbortController | null>(null);
  // Bumped on every open/close so a late share-sheet callback can't close a
  // sheet the user has since reopened.
  const sessionRef = useRef(0);

  useEffect(() => {
    sessionRef.current += 1;
    if (!visible) {
      abortRef.current?.abort();
      abortRef.current = null;
      setBusy(null);
      return;
    }
    let cancelled = false;
    getDocSettings()
      .then(s => {
        if (cancelled) return;
        setPageSize(s.pdfPageSize);
        setQuality(s.pdfQuality === 'high' ? 'high' : 'standard');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const isPdfDoc = !!document.pdfUri;
  const pageCount = document.pages.length;
  const canSearchable = !isPdfDoc && pageCount > 0 && ocrAvailable();

  const cancelWork = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(null);
  }, []);

  const handleClose = useCallback(() => {
    cancelWork();
    onClose();
  }, [cancelWork, onClose]);

  async function buildPdf(q: PdfQuality, searchable: boolean, signal: AbortSignal, title: string): Promise<string> {
    // Read settings fresh so a change made a moment ago is honoured.
    const settings = await getDocSettings().catch(() => null);
    const size = settings?.pdfPageSize ?? pageSize;
    setBusy({ title, label: 'Preparing', progress: 0 });
    return generatePdf(document.pages, {
      pageSize: size,
      quality: q,
      searchable,
      signal,
      onProgress: (done, total, phase) => {
        if (signal.aborted) return;
        // Reserve the last 15% of the bar for the native render step.
        const progress = phase === 'rendering' ? 0.9 : (done / total) * 0.85 + (phase === 'reading-text' ? 0.4 / total : 0);
        setBusy({ title, label: pdfPhaseLabel(phase, done, total), progress });
      },
    });
  }

  async function buildImages(signal: AbortSignal, dir: string): Promise<BuiltFile> {
    const title = pageCount === 1 ? 'Preparing image' : 'Preparing images';
    if (pageCount === 1) {
      setBusy({ title, label: 'Preparing image', progress: 0.5 });
      const uri = await placeExportFile(document.pages[0], dir, exportFileName(document.name, 'jpg'), 'copy');
      return { uri, mimeType: 'image/jpeg', UTI: 'public.jpeg' };
    }
    // JPEGs don't compress further, so STORE them: far less CPU, and bytes are
    // added as binary instead of base64 strings to keep peak memory down.
    const zip = new JSZip();
    for (let i = 0; i < pageCount; i++) {
      if (signal.aborted) throw new CancelledError();
      setBusy({ title, label: `Adding page ${i + 1} of ${pageCount}`, progress: (i / pageCount) * 0.8 });
      const bytes = await new File(cleanFileUri(document.pages[i])).bytes();
      zip.file(`Page ${String(i + 1).padStart(2, '0')}.jpg`, bytes, { binary: true });
    }
    if (signal.aborted) throw new CancelledError();
    setBusy({ title, label: 'Creating ZIP file', progress: 0.9 });
    const data = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
    if (signal.aborted) throw new CancelledError();
    const uri = `${dir}${encodeURIComponent(exportFileName(document.name, 'zip'))}`;
    const out = new File(uri);
    out.create({ overwrite: true });
    out.write(data);
    return { uri, mimeType: 'application/zip', UTI: 'public.zip-archive' };
  }

  const runningRef = useRef(false);

  async function run(action: Action) {
    if (busy || runningRef.current) return;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    const session = sessionRef.current;
    const check = () => {
      if (signal.aborted) throw new CancelledError();
    };

    try {
      await clearExportCache();
      check();

      if (action === 'print') {
        let uri: string;
        if (isPdfDoc) {
          uri = document.pdfUri!;
        } else {
          const raw = await buildPdf('high', false, signal, 'Preparing to print');
          check();
          // Named after the document so the print job isn't called "<uuid>.pdf".
          uri = await placeExportFile(raw, await makeExportDir(), exportFileName(document.name, 'pdf'), 'move');
        }
        check();
        setBusy(null);
        const outcome = await printFile(uri);
        if (outcome === 'printed' && sessionRef.current === session) {
          toast.show('Sent to printer');
          onClose();
        }
        return;
      }

      const dir = await makeExportDir();
      let file: BuiltFile;
      if (isPdfDoc) {
        setBusy({ title: 'Preparing PDF', label: 'Preparing PDF', progress: 0.5 });
        const uri = await placeExportFile(document.pdfUri!, dir, exportFileName(document.name, 'pdf'), 'copy');
        file = { uri, ...PDF_FILE };
      } else if (action === 'images') {
        file = await buildImages(signal, dir);
      } else {
        const q: PdfQuality = action === 'small' ? 'small' : quality;
        const title = action === 'searchable' ? 'Creating searchable PDF' : 'Creating PDF';
        const raw = await buildPdf(q, action === 'searchable', signal, title);
        check();
        const uri = await placeExportFile(raw, dir, exportFileName(document.name, 'pdf'), 'move');
        file = { uri, ...PDF_FILE };
      }
      check();
      setBusy(null);

      await shareFile(file.uri, {
        mimeType: file.mimeType,
        UTI: file.UTI,
        dialogTitle: document.name,
        // Close once the share sheet is done, unless the user has moved on.
        onFinish: () => {
          if (sessionRef.current === session) onClose();
        },
      });
    } catch (err) {
      if (err instanceof CancelledError || err instanceof PdfCancelledError || signal.aborted) return;
      if (sessionRef.current !== session) return;
      const { title, body } = errorMessage(err, action);
      Alert.alert(title, body);
    } finally {
      runningRef.current = false;
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(null);
      }
    }
  }

  const paperLabel = pageSize === 'Letter' ? 'US Letter' : 'A4';
  const pagesLabel = `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`;

  return (
    <BottomSheet visible={visible} onClose={handleClose} variant="grouped">
      <SheetHeader title="Export" subtitle={document.name} />

      {busy ? (
        <SheetGroup>
          <View style={styles.busy} accessibilityLiveRegion="polite">
            <Text style={[Type.headline, { color: colors.text }]}>{busy.title}</Text>
            <View style={[styles.track, { backgroundColor: colors.secondary }]}>
              <View
                style={[
                  styles.fill,
                  {
                    backgroundColor: colors.accentFill,
                    width: `${Math.round(Math.max(0.04, Math.min(1, busy.progress)) * 100)}%`,
                  },
                ]}
              />
            </View>
            <Text style={[Type.footnote, { color: colors.muted }]}>{busy.label}</Text>
            <PrimaryButton title="Cancel" variant="secondary" onPress={cancelWork} style={styles.cancelBtn} />
          </View>
        </SheetGroup>
      ) : (
        <>
          <SectionLabel style={styles.label}>Share as</SectionLabel>
          <SheetGroup>
            {isPdfDoc ? (
              <SheetRow icon="document-text-outline" label="PDF" detail="The original PDF file" onPress={() => run('pdf')} last />
            ) : (
              <>
                <SheetRow
                  icon="document-text-outline"
                  label="PDF"
                  detail={`${pagesLabel}, ${paperLabel}`}
                  onPress={() => run('pdf')}
                />
                {canSearchable && (
                  <SheetRow
                    icon="search-outline"
                    label="Searchable PDF"
                    detail="Text can be selected, copied and searched"
                    onPress={() => run('searchable')}
                  />
                )}
                <SheetRow
                  icon="contract-outline"
                  label="Smaller PDF"
                  detail="Lower resolution, good for email"
                  onPress={() => run('small')}
                />
                <SheetRow
                  icon="images-outline"
                  label={pageCount === 1 ? 'JPEG image' : 'JPEG images'}
                  detail={pageCount === 1 ? 'The page as a photo' : `${pageCount} images in a ZIP file`}
                  onPress={() => run('images')}
                  last
                />
              </>
            )}
          </SheetGroup>
          <SheetGroup>
            <SheetRow
              icon="print-outline"
              label="Print"
              detail={isPdfDoc ? 'Send to an AirPrint printer' : `Send to an AirPrint printer, ${paperLabel}`}
              onPress={() => run('print')}
              last
            />
          </SheetGroup>
        </>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  label: { marginTop: Spacing.xs },
  busy: { padding: Spacing.lg, gap: Spacing.md },
  track: { height: 6, borderRadius: Radius.pill, overflow: 'hidden' },
  fill: { height: 6, borderRadius: Radius.pill },
  cancelBtn: { marginTop: Spacing.xs },
});

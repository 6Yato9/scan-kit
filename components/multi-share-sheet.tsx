// components/multi-share-sheet.tsx
// Share several documents at once (Files → Select → Share): as one combined
// PDF, or as separate PDFs packed in a ZIP (iOS share sheets take one file).
// With `exportAll` (Settings → Storage → Export all documents) it offers just
// the ZIP: every document as a searchable PDF, ready to save to Files.
//
// Like the export sheet, the native share sheet is presented on top of this
// one (that works; presenting while a modal is dismissing does not), progress
// shows with Cancel, and closing the sheet cancels the work.
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { File, Paths } from 'expo-file-system';
import { generatePdf, PdfCancelledError, PdfError } from '@/lib/pdf';
import { ocrAvailable } from '@/lib/ocr';
import {
  cleanFileUri,
  clearExportCache,
  deleteQuietly,
  exportFileName,
  makeExportDir,
  placeExportFile,
  shareFile,
  ShareError,
} from '@/lib/share';
import { getDocSettings } from '@/lib/storage';
import { BottomSheet, SheetGroup, SheetHeader, SheetRow } from '@/components/bottom-sheet';
import { PrimaryButton } from '@/components/primary-button';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { formatBytes } from '@/components/tool-ui';
import { documentsBytes } from '@/lib/doc-size';
import { zipFiles, ZipCancelledError, ZipLimitError } from '@/lib/zip-stream';
import { uniqueNames } from '@/lib/unique-names';
import { Radius, Spacing, Type } from '@/lib/theme';

type Props = {
  visible: boolean;
  documents: Document[];
  onClose: () => void;
  /** Settings' "Export all documents": the ZIP only, named for the whole library. */
  exportAll?: boolean;
};

type Busy = { title: string; label: string; progress: number };

class CancelledError extends Error {}
class ExportSpaceError extends Error {}

/** Free space the export needs beyond the archive itself (one PDF in flight, headroom). */
const SPACE_MARGIN = 50 * 1024 * 1024;

/**
 * True when there is clearly not enough free space for a ZIP of about `bytes`.
 * Unknown sizes never block: the write itself still fails cleanly.
 */
export function lacksSpaceFor(bytes: number | null, available: number | null | undefined): boolean {
  if (!bytes || !available || !Number.isFinite(available)) return false;
  return bytes + SPACE_MARGIN > available;
}

/** "Invoice and 2 more" — the combined file's name. */
export function combinedName(docs: { name: string }[]): string {
  if (docs.length === 0) return 'Documents';
  if (docs.length === 1) return docs[0].name;
  return `${docs[0].name} and ${docs.length - 1} more`;
}

/** "Scan Kit documents 2026-11-18" — the export-all ZIP's name (local date). */
export function exportAllName(now: Date = new Date()): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return `Scan Kit documents ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function MultiShareSheet({ visible, documents, onClose, exportAll = false }: Props) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState<Busy | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
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
    setSize(null);
    documentsBytes(documents).then(b => { if (!cancelled) setSize(b); }).catch(() => {});
    return () => { cancelled = true; };
  }, [visible, documents]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const n = documents.length;
  const totalPages = documents.reduce((sum, d) => sum + d.pages.length, 0);
  const hasImportedPdf = documents.some(d => !!d.pdfUri);
  const canCombine = !hasImportedPdf && totalPages > 0;
  // Every PDF made here is searchable when text recognition is available, as
  // in the export sheet: that is what people expect from a scanner's PDFs.
  const searchable = ocrAvailable();

  function cancel() {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(null);
  }

  async function run(mode: 'combined' | 'separate') {
    if (runningRef.current || n === 0) return;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    const session = sessionRef.current;
    const check = () => { if (signal.aborted) throw new CancelledError(); };
    // The folder holding the file to share. Deleted once the share sheet has
    // finished with it (or if it is never shown), so a whole-library ZIP
    // doesn't sit in Caches until the next export or launch.
    let exportDir: string | null = null;

    try {
      await clearExportCache();
      const settings = await getDocSettings().catch(() => null);
      const pageSize = settings?.pdfPageSize ?? 'A4';
      // Standard always: the old "PDF image quality" setting was removed.
      const quality = 'standard' as const;
      const dir = await makeExportDir();
      exportDir = dir;
      check();

      let uri: string;
      let mime: { mimeType: string; UTI: string };
      if (mode === 'combined') {
        const title = 'Creating one PDF';
        setBusy({ title, label: 'Preparing', progress: 0 });
        const pages = documents.flatMap(d => d.pages);
        const raw = await generatePdf(pages, {
          pageSize,
          quality,
          searchable,
          signal,
          onProgress: (done, total, phase) => {
            if (signal.aborted) return;
            const label =
              phase === 'rendering'
                ? 'Finishing up'
                : phase === 'reading-text'
                  ? `Reading text on page ${Math.min(done + 1, total)} of ${total}`
                  : `Preparing page ${Math.min(done + 1, total)} of ${total}`;
            setBusy({ title, label, progress: phase === 'rendering' ? 0.9 : (done / total) * 0.85 });
          },
        });
        if (signal.aborted) { try { new File(cleanFileUri(raw)).delete(); } catch {} }
        check();
        uri = await placeExportFile(raw, dir, exportFileName(combinedName(documents), 'pdf'), 'move');
        mime = { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' };
      } else {
        const title = exportAll ? `Exporting ${n} ${n === 1 ? 'document' : 'documents'}` : `Creating ${n} PDFs`;
        let available: number | null = null;
        try { available = Paths.availableDiskSpace; } catch {}
        if (lacksSpaceFor(size, available)) {
          throw new ExportSpaceError();
        }
        const names = uniqueNames(documents.map(d => exportFileName(d.name, 'pdf')));
        const zipName = exportAll ? exportAllName() : `${n} documents`;
        uri = `${dir}${encodeURIComponent(exportFileName(zipName, 'zip'))}`;
        // Streamed straight to the file (lib/zip-stream.ts): each PDF is made,
        // copied in 1 MB chunks and deleted before the next one, so memory
        // stays flat however large the library is.
        await zipFiles(
          uri,
          documents.map((doc, i) => ({
            name: names[i],
            date: new Date(doc.updatedAt || doc.createdAt || Date.now()),
            produce: async () => {
              if (doc.pdfUri) return { uri: doc.pdfUri, temporary: false };
              const label = `“${doc.name}” (${i + 1} of ${n})`;
              const pdf = await generatePdf(doc.pages, {
                pageSize,
                quality,
                searchable,
                signal,
                // Progress moves within each document too, not only between them.
                onProgress: (done, total) => {
                  if (signal.aborted) return;
                  setBusy({ title, label, progress: ((i + Math.min(1, done / Math.max(1, total))) / n) * 0.95 });
                },
              });
              if (signal.aborted) {
                try { new File(cleanFileUri(pdf)).delete(); } catch {}
                throw new CancelledError();
              }
              return { uri: pdf, temporary: true };
            },
          })),
          {
            signal,
            onItem: i => {
              if (!signal.aborted) {
                setBusy({ title, label: `“${documents[i].name}” (${i + 1} of ${n})`, progress: (i / n) * 0.95 });
              }
            },
          },
        );
        check();
        mime = { mimeType: 'application/zip', UTI: 'public.zip-archive' };
      }
      check();
      setBusy(null);
      // Waits while App Lock is on; presents nothing if this sheet was closed meanwhile.
      const shareDir = dir;
      const outcome = await shareFile(uri, {
        ...mime,
        signal,
        dialogTitle: mode === 'combined' ? combinedName(documents) : exportAll ? 'All documents' : `${n} documents`,
        onFinish: () => {
          void deleteQuietly(shareDir);
          if (sessionRef.current === session) onClose();
        },
      });
      exportDir = null; // from here the share sheet owns it (onFinish deletes it)
      if (outcome === 'skipped') void deleteQuietly(shareDir);
    } catch (err) {
      void deleteQuietly(exportDir);
      if (
        err instanceof CancelledError ||
        err instanceof PdfCancelledError ||
        err instanceof ZipCancelledError ||
        signal.aborted
      ) {
        return;
      }
      if (sessionRef.current !== session) return;
      console.error('Share documents failed', err);
      const body =
        err instanceof ShareError
          ? err.message
          : err instanceof ExportSpaceError
            ? 'There isn’t enough free space on this iPhone to create the file. Free up some space and try again.'
            : err instanceof ZipLimitError
              ? 'These documents are too large for one ZIP file. Select fewer in Files and share them in groups.'
              : err instanceof PdfError && err.kind === 'timeout'
                ? 'This took too long. Try sharing fewer documents at a time.'
                : 'Something went wrong while preparing the files. Try again.';
      Alert.alert(exportAll ? 'Couldn’t export your documents' : 'Couldn’t share the documents', body);
    } finally {
      runningRef.current = false;
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(null);
      }
    }
  }

  const subtitle = `${n} ${n === 1 ? 'document' : 'documents'}${size ? `, ${formatBytes(size)}` : ''}`;

  return (
    <BottomSheet visible={visible} onClose={() => { cancel(); onClose(); }} variant="grouped">
      <SheetHeader title={exportAll ? 'Export all documents' : 'Share'} subtitle={subtitle} />
      {busy ? (
        <SheetGroup style={styles.lastGroup}>
          <View style={styles.busy} accessibilityLiveRegion="polite">
            <Text style={[Type.headline, { color: colors.text }]}>{busy.title}</Text>
            <View style={[styles.track, { backgroundColor: colors.secondary }]}>
              <View
                style={[
                  styles.fill,
                  { backgroundColor: colors.accentFill, width: `${Math.round(Math.max(0.04, Math.min(1, busy.progress)) * 100)}%` },
                ]}
              />
            </View>
            <Text style={[Type.footnote, { color: colors.muted }]} numberOfLines={1}>{busy.label}</Text>
            <PrimaryButton title="Cancel" variant="secondary" onPress={cancel} style={styles.cancelBtn} />
          </View>
        </SheetGroup>
      ) : exportAll ? (
        <SheetGroup style={styles.lastGroup}>
          <SheetRow
            icon="file-tray-full-outline"
            label="PDFs in a ZIP file"
            detail={searchable ? 'One searchable PDF per document' : 'One PDF per document'}
            disabled={n === 0}
            onPress={() => run('separate')}
            last
          />
        </SheetGroup>
      ) : (
        <SheetGroup style={styles.lastGroup}>
          <SheetRow
            icon="document-text-outline"
            label="One PDF"
            detail={
              canCombine
                ? `All ${totalPages} pages in a single file`
                : 'Not available when an imported PDF is selected'
            }
            disabled={!canCombine}
            onPress={() => run('combined')}
          />
          <SheetRow
            icon="documents-outline"
            label="Separate PDFs"
            detail={`${n} PDF files in a ZIP file`}
            onPress={() => run('separate')}
            last
          />
        </SheetGroup>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  lastGroup: { marginBottom: 0 },
  busy: { padding: Spacing.lg, gap: Spacing.md },
  track: { height: 6, borderRadius: Radius.pill, overflow: 'hidden' },
  fill: { height: 6, borderRadius: Radius.pill },
  cancelBtn: { marginTop: Spacing.xs },
});

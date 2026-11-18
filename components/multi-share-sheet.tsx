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
import { File } from 'expo-file-system';
import JSZip from 'jszip';
import { generatePdf, PdfCancelledError, PdfError } from '@/lib/pdf';
import { ocrAvailable } from '@/lib/ocr';
import {
  cleanFileUri,
  clearExportCache,
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

/** Unique file names inside a ZIP: a second "Scan.pdf" becomes "Scan 2.pdf". */
export function uniqueNames(names: string[]): string[] {
  const used = new Map<string, number>();
  return names.map(n => {
    const key = n.toLowerCase();
    const count = (used.get(key) ?? 0) + 1;
    used.set(key, count);
    if (count === 1) return n;
    const dot = n.lastIndexOf('.');
    return dot > 0 ? `${n.slice(0, dot)} ${count}${n.slice(dot)}` : `${n} ${count}`;
  });
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

    try {
      await clearExportCache();
      const settings = await getDocSettings().catch(() => null);
      const pageSize = settings?.pdfPageSize ?? 'A4';
      // Standard always: the old "PDF image quality" setting was removed.
      const quality = 'standard' as const;
      const dir = await makeExportDir();
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
        const zip = new JSZip();
        const names = uniqueNames(documents.map(d => exportFileName(d.name, 'pdf')));
        for (let i = 0; i < n; i++) {
          check();
          const doc = documents[i];
          const label = `“${doc.name}” (${i + 1} of ${n})`;
          setBusy({ title, label, progress: (i / n) * 0.85 });
          let pdf: string;
          if (doc.pdfUri) {
            pdf = doc.pdfUri;
          } else {
            pdf = await generatePdf(doc.pages, {
              pageSize,
              quality,
              searchable,
              signal,
              // Progress moves within each document too, not only between them.
              onProgress: (done, total) => {
                if (signal.aborted) return;
                setBusy({ title, label, progress: ((i + Math.min(1, done / Math.max(1, total))) / n) * 0.85 });
              },
            });
            if (signal.aborted) { try { new File(cleanFileUri(pdf)).delete(); } catch {} }
          }
          check();
          const bytes = await new File(cleanFileUri(pdf)).bytes();
          zip.file(names[i], bytes, { binary: true });
          if (!doc.pdfUri) new File(cleanFileUri(pdf)).delete();
        }
        check();
        setBusy({ title, label: 'Creating ZIP file', progress: 0.9 });
        // PDFs are already compressed; STORE keeps it fast.
        const data = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
        check();
        const zipName = exportAll ? exportAllName() : `${n} documents`;
        uri = `${dir}${encodeURIComponent(exportFileName(zipName, 'zip'))}`;
        const out = new File(uri);
        out.create({ overwrite: true });
        out.write(data);
        mime = { mimeType: 'application/zip', UTI: 'public.zip-archive' };
      }
      check();
      setBusy(null);
      // Waits while App Lock is on; presents nothing if this sheet was closed meanwhile.
      await shareFile(uri, {
        ...mime,
        signal,
        dialogTitle: mode === 'combined' ? combinedName(documents) : exportAll ? 'All documents' : `${n} documents`,
        onFinish: () => { if (sessionRef.current === session) onClose(); },
      });
    } catch (err) {
      if (err instanceof CancelledError || err instanceof PdfCancelledError || signal.aborted) return;
      if (sessionRef.current !== session) return;
      console.error('Share documents failed', err);
      const body =
        err instanceof ShareError
          ? err.message
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

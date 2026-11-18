// components/export-sheet.tsx
// Export / share / print a document.
//
// The native share sheet and print dialog are presented ON TOP of this sheet
// (presenting over an open RN Modal works; presenting while it is dismissing
// does not), so there is no close-then-share timing race. Nothing here ever
// waits on the share sheet: `shareFile` returns as soon as the sheet is up, so
// the UI can't get stuck if expo-sharing never settles. Work in progress shows a
// progress state with Cancel, and closing the sheet cancels it too.
import { Alert, Image, Linking, StyleSheet, Text, TextInput, View } from 'react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { File } from 'expo-file-system';
import JSZip from 'jszip';
import {
  canProtectPdf,
  estimatePdfBytes,
  generatePdf,
  MIN_PDF_PASSWORD,
  PageSize,
  PageStat,
  paperLabel as paperName,
  PdfCancelledError,
  PdfError,
  PdfQuality,
  PdfProgressPhase,
  PdfProtectError,
  protectPdf,
  roundUpEstimate,
} from '@/lib/pdf';
import {
  cleanFileUri,
  clearExportCache,
  deleteQuietly,
  exportFileName,
  makeExportDir,
  placeExportFile,
  printFile,
  shareFile,
  shareText,
  ShareError,
} from '@/lib/share';
import { ocrAvailable } from '@/lib/ocr';
import { savePagesToPhotos } from '@/lib/photos';
import { pendingBakeCount, waitForPendingBakes } from '@/lib/bake';
import { BottomSheet, SheetGroup, SheetHeader, SheetRow } from '@/components/bottom-sheet';
import { SectionLabel } from '@/components/section-label';
import { PrimaryButton } from '@/components/primary-button';
import { useToast } from '@/components/toast';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { getDocSettings } from '@/lib/storage';
import { documentBytes } from '@/lib/doc-size';
import { formatBytes } from '@/components/tool-ui';
import { notifySuccess } from '@/lib/haptics';
import { Radius, Spacing, Type } from '@/lib/theme';

type Props = {
  visible: boolean;
  document: Document;
  onClose: () => void;
};

type Action = 'pdf' | 'small' | 'protected' | 'images' | 'photos' | 'print';

type Busy = { title: string; label: string; progress: number };

type BuiltFile = { uri: string; mimeType: string; UTI: string };

class CancelledError extends Error {}

function imageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise(resolve => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), () => resolve({ width: 0, height: 0 }));
  });
}

/** Stored bytes and pixel size of every page, for the export size estimates. */
async function pageStats(pages: string[]): Promise<PageStat[]> {
  return Promise.all(
    pages.map(async p => {
      const uri = cleanFileUri(p);
      let bytes = 0;
      try {
        const f = new File(uri);
        bytes = f.exists ? f.size ?? 0 : 0;
      } catch {}
      return { bytes, ...(await imageSize(uri)) };
    }),
  );
}

const PDF_FILE = { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' };

/**
 * The Text row's detail, "Recognized text · about 240 words": word count is
 * what people judge plain text by. Counts under 20 are exact; above that they
 * are rounded like the size estimates.
 */
export function textDetail(text: string): string {
  const words = text.split(/\s+/).filter(Boolean).length;
  let count: string;
  if (words === 1) count = '1 word';
  else if (words < 20) count = `${words} words`;
  else if (words < 1000) count = `about ${Math.round(words / 10) * 10} words`;
  else count = `about ${(Math.round(words / 100) * 100).toLocaleString('en-US')} words`;
  return `Recognized text · ${count}`;
}

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
  if (err instanceof PdfProtectError) {
    return { title: 'Couldn’t add the password', body: 'The PDF couldn’t be protected. Try again.' };
  }
  if (err instanceof PdfError) {
    if (err.kind === 'read') return { title, body: `${err.message} Try again, or remove that page from the document.` };
    if (err.kind === 'timeout') {
      return { title, body: 'This document took too long to process. Try “Smaller PDF”, or split it into fewer pages.' };
    }
    if (err.kind === 'empty') return { title, body: 'This document has no pages to export.' };
    return { title, body: 'Something went wrong while creating the PDF. Try again.' };
  }
  if (action === 'images') return { title, body: 'Couldn’t prepare the images. Check that your device has free space and try again.' };
  if (action === 'photos') return { title: 'Couldn’t save to Photos', body: 'Check that your device has free space and try again.' };
  return { title, body: 'Something went wrong. Try again.' };
}

export function ExportSheet({ visible, document, onClose }: Props) {
  const { colors, isDark } = useTheme();
  const toast = useToast();
  const [busy, setBusy] = useState<Busy | null>(null);
  const [pageSize, setPageSize] = useState<PageSize>('A4');
  // Always standard: the old "PDF image quality" setting is gone (a stored
  // 'high' would otherwise stick with no way to change it). "Smaller PDF"
  // covers size.
  const quality: PdfQuality = 'standard';
  const [bytes, setBytes] = useState<number | null>(null);
  const [stats, setStats] = useState<PageStat[] | null>(null);
  // "Password-protected PDF" asks for the password inside the sheet (an Alert
  // can't be presented over it). The password lives only in this state and is
  // cleared as soon as the PDF is protected or the sheet closes.
  const [pwMode, setPwMode] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const confirmRef = useRef<TextInput>(null);
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
      setPwMode(false);
      setPw('');
      setPw2('');
      return;
    }
    let cancelled = false;
    setBytes(null);
    setStats(null);
    // File stats are synchronous; let the sheet start sliding in first.
    const sizeTimer = setTimeout(() => {
      if (cancelled) return;
      setBytes(documentBytes(document));
      if (!document.pdfUri && document.pages.length > 0) {
        pageStats(document.pages).then(s => { if (!cancelled) setStats(s); }).catch(() => {});
      }
    }, 0);
    getDocSettings()
      .then(s => {
        if (cancelled) return;
        setPageSize(s.pdfPageSize);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      clearTimeout(sizeTimer);
    };
    // Re-measure when the document's pages change (edits bump updatedAt).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, document.updatedAt]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const isPdfDoc = !!document.pdfUri;
  const pageCount = document.pages.length;
  // The recognized text (search index): shared as plain text, ready to paste.
  // Hidden when the document has none yet.
  const docText = document.ocrText?.trim() ?? '';
  const canSearchable = !isPdfDoc && pageCount > 0 && ocrAvailable();
  const canProtect = canProtectPdf() && (isPdfDoc || pageCount > 0);

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

  /** Shares the recognized text over this sheet; closes it once the share sheet is done. */
  async function runShareText() {
    if (busy || runningRef.current || !docText) return;
    runningRef.current = true;
    const session = sessionRef.current;
    try {
      // Waits while App Lock is on; dismissing the share sheet isn't an error.
      await shareText(docText);
      if (sessionRef.current === session) onClose();
    } finally {
      runningRef.current = false;
    }
  }

  /** Waits for this document's queued or running filter bakes, with progress. */
  async function finishEnhancements(signal: AbortSignal): Promise<void> {
    const total = pendingBakeCount(document.id);
    if (total === 0) return;
    const show = (remaining: number) => {
      if (signal.aborted) return;
      setBusy({
        title: 'Finishing enhancements…',
        label: remaining === 1 ? '1 page left' : `${remaining} pages left`,
        progress: (total - remaining) / total,
      });
    };
    show(total);
    // A timeout exports what is there: raw pixels are still a valid page.
    await waitForPendingBakes(document.id, { signal, onProgress: show });
  }

  /** Saves every page to the photo library (add-only permission; waits while App Lock is on). */
  async function saveToPhotos(signal: AbortSignal): Promise<boolean> {
    const outcome = await savePagesToPhotos(document.pages, {
      signal,
      onProgress: i => setBusy({
        title: 'Saving to Photos',
        label: pageCount === 1 ? 'Saving the page' : `Saving page ${i + 1} of ${pageCount}`,
        progress: i / pageCount,
      }),
    });
    if (outcome === 'cancelled') throw new CancelledError();
    if (outcome === 'denied') {
      Alert.alert(
        'Allow access to Photos',
        'To save pages, let Scan Kit add photos in Settings.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => { Linking.openSettings().catch(() => {}); } },
        ],
      );
      return false;
    }
    return true;
  }

  async function run(action: Action, password?: string) {
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
      // A scan shared straight away may still be getting its default filter
      // (lib/bake.ts): export the enhanced pages, never the raw ones.
      if (!isPdfDoc) await finishEnhancements(signal);
      check();

      if (action === 'print') {
        let uri: string;
        if (isPdfDoc) {
          uri = document.pdfUri!;
        } else {
          const raw = await buildPdf('high', false, signal, 'Preparing to print');
          if (signal.aborted) await deleteQuietly(raw);
          check();
          // Named after the document so the print job isn't called "<uuid>.pdf".
          uri = await placeExportFile(raw, await makeExportDir(), exportFileName(document.name, 'pdf'), 'move');
        }
        check();
        setBusy(null);
        // Waits while App Lock is on; skipped if this sheet is closed meanwhile.
        const outcome = await printFile(uri, { signal });
        if (outcome === 'printed' && sessionRef.current === session) {
          toast.show('Sent to printer');
          onClose();
        }
        return;
      }

      if (action === 'photos') {
        const saved = await saveToPhotos(signal);
        if (saved && sessionRef.current === session) {
          notifySuccess();
          toast.show(pageCount === 1 ? 'Saved the page to Photos' : `Saved ${pageCount} pages to Photos`);
          onClose();
        }
        return;
      }

      const dir = await makeExportDir();
      let file: BuiltFile;
      if (action === 'protected') {
        // The normal PDF first (the imported file itself for a PDF document),
        // then a protected copy under the document's name. The unprotected
        // temp file is deleted straight away; only the protected one is shared.
        const title = 'Creating protected PDF';
        let raw: string | null = null;
        try {
          if (!isPdfDoc) {
            raw = await buildPdf(quality, canSearchable, signal, title);
            check();
          }
          setBusy({ title, label: 'Adding the password', progress: 0.95 });
          const out = `${dir}${encodeURIComponent(exportFileName(document.name, 'pdf'))}`;
          const uri = await protectPdf(raw ?? document.pdfUri!, out, password ?? '');
          file = { uri, ...PDF_FILE };
        } finally {
          await deleteQuietly(raw);
        }
        setPw('');
        setPw2('');
        setPwMode(false);
      } else if (isPdfDoc) {
        setBusy({ title: 'Preparing PDF', label: 'Preparing PDF', progress: 0.5 });
        const uri = await placeExportFile(document.pdfUri!, dir, exportFileName(document.name, 'pdf'), 'copy');
        file = { uri, ...PDF_FILE };
      } else if (action === 'images') {
        file = await buildImages(signal, dir);
      } else {
        // Every PDF is searchable when text recognition is available: that is
        // what people expect from a scanner app's PDF.
        const q: PdfQuality = action === 'small' ? 'small' : quality;
        const title = action === 'small' ? 'Creating smaller PDF' : 'Creating PDF';
        const raw = await buildPdf(q, canSearchable, signal, title);
        if (signal.aborted) await deleteQuietly(raw);
        check();
        const uri = await placeExportFile(raw, dir, exportFileName(document.name, 'pdf'), 'move');
        file = { uri, ...PDF_FILE };
      }
      check();
      setBusy(null);

      // Waits while App Lock is on (an export that finishes behind the lock
      // screen must not present over it), and presents nothing if this sheet
      // was closed meanwhile (closing aborts `signal`).
      await shareFile(file.uri, {
        mimeType: file.mimeType,
        UTI: file.UTI,
        dialogTitle: document.name,
        signal,
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

  const pagesLabel = `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`;
  const sizeLabel = bytes ? formatBytes(bytes) : null;
  const subtitle = [isPdfDoc ? 'PDF' : pagesLabel, sizeLabel].filter(Boolean).join(' · ');
  // Leans high and rounds up (lib/pdf): the file should never be bigger than promised.
  const estimate = (q: PdfQuality) =>
    stats ? `about ${formatBytes(roundUpEstimate(estimatePdfBytes(stats, q, canSearchable)))}` : null;
  // Short enough that the size, the number people check, always fits on the
  // row: "Searchable · about 240 KB".
  const detailLine = (parts: (string | null)[]) => parts.filter(Boolean).join(' · ');
  const pdfDetail = detailLine([canSearchable ? 'Searchable' : pagesLabel, estimate(quality)]);
  const smallDetail = detailLine(['For email', estimate('small')]);
  const protectedDetail = detailLine([
    'Needs a password',
    isPdfDoc ? (sizeLabel ? `about ${sizeLabel}` : null) : estimate(quality),
  ]);
  const pwTooShort = pw.length > 0 && pw.length < MIN_PDF_PASSWORD;
  const pwMismatch = pw2.length > 0 && pw2 !== pw;
  const pwReady = pw.length >= MIN_PDF_PASSWORD && pw2 === pw;
  const pwHint = pwTooShort
    ? `Use at least ${MIN_PDF_PASSWORD} characters.`
    : pwMismatch
      ? 'The passwords don’t match.'
      : 'Anyone opening the PDF will need this password. Scan Kit doesn’t keep it, so it can’t be recovered.';
  const submitPassword = () => {
    if (pwReady) run('protected', pw);
  };
  const printDetail = detailLine(['Any AirPrint printer', pageSize === 'Auto' || isPdfDoc ? null : paperName(pageSize)]);

  return (
    <BottomSheet visible={visible} onClose={handleClose} variant="grouped">
      <SheetHeader title={document.name} subtitle={subtitle} />

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
      ) : pwMode ? (
        <>
          <SectionLabel style={styles.label}>Password-protected PDF</SectionLabel>
          <SheetGroup style={styles.pwGroup}>
            <TextInput
              style={[Type.body, styles.pwInput, styles.pwDivider, { color: colors.text, borderBottomColor: colors.border }]}
              value={pw}
              onChangeText={setPw}
              placeholder="Password"
              placeholderTextColor={colors.muted}
              secureTextEntry
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              keyboardAppearance={isDark ? 'dark' : 'light'}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => confirmRef.current?.focus()}
              accessibilityLabel="Password"
            />
            <TextInput
              ref={confirmRef}
              style={[Type.body, styles.pwInput, { color: colors.text }]}
              value={pw2}
              onChangeText={setPw2}
              placeholder="Confirm password"
              placeholderTextColor={colors.muted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              keyboardAppearance={isDark ? 'dark' : 'light'}
              returnKeyType="go"
              onSubmitEditing={submitPassword}
              accessibilityLabel="Confirm password"
            />
          </SheetGroup>
          <Text
            style={[Type.footnote, styles.pwHint, { color: pwTooShort || pwMismatch ? colors.danger : colors.muted }]}
            accessibilityLiveRegion="polite"
          >
            {pwHint}
          </Text>
          <View style={styles.pwActions}>
            <PrimaryButton title="Share protected PDF" icon="lock-closed-outline" onPress={submitPassword} disabled={!pwReady} />
            <PrimaryButton
              title="Back"
              variant="secondary"
              onPress={() => {
                setPwMode(false);
                setPw('');
                setPw2('');
              }}
            />
          </View>
        </>
      ) : (
        <>
          <SectionLabel style={styles.label}>Share as</SectionLabel>
          <SheetGroup>
            {isPdfDoc ? (
              <>
                <SheetRow
                  icon="document-text-outline"
                  label="PDF"
                  detail={detailLine(['Original file', sizeLabel])}
                  onPress={() => run('pdf')}
                  last={!canProtect && !docText}
                />
                {canProtect ? (
                  <SheetRow
                    icon="lock-closed-outline"
                    label="Password-protected PDF"
                    detail={protectedDetail}
                    onPress={() => setPwMode(true)}
                    last={!docText}
                  />
                ) : null}
                {docText ? (
                  <SheetRow icon="reader-outline" label="Text" detail={textDetail(docText)} onPress={runShareText} last />
                ) : null}
              </>
            ) : (
              <>
                <SheetRow
                  icon="document-text-outline"
                  label="PDF"
                  detail={pdfDetail}
                  onPress={() => run('pdf')}
                />
                <SheetRow
                  icon="contract-outline"
                  label="Smaller PDF"
                  detail={smallDetail}
                  onPress={() => run('small')}
                />
                {canProtect ? (
                  <SheetRow
                    icon="lock-closed-outline"
                    label="Password-protected PDF"
                    detail={protectedDetail}
                    onPress={() => setPwMode(true)}
                  />
                ) : null}
                <SheetRow
                  icon="image-outline"
                  label={pageCount === 1 ? 'JPEG image' : 'JPEG images'}
                  detail={detailLine([pageCount === 1 ? 'One image' : `${pageCount} images in a ZIP`, sizeLabel])}
                  onPress={() => run('images')}
                  last={!docText}
                />
                {docText ? (
                  <SheetRow icon="reader-outline" label="Text" detail={textDetail(docText)} onPress={runShareText} last />
                ) : null}
              </>
            )}
          </SheetGroup>
          <SectionLabel style={styles.label}>Save</SectionLabel>
          <SheetGroup style={styles.lastGroup}>
            {!isPdfDoc && pageCount > 0 && (
              <SheetRow
                icon="download-outline"
                label="Save to Photos"
                detail={pageCount === 1 ? 'Adds the page to your library' : `Adds all ${pageCount} pages to your library`}
                onPress={() => run('photos')}
              />
            )}
            <SheetRow
              icon="print-outline"
              label="Print"
              detail={printDetail}
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
  lastGroup: { marginBottom: 0 },
  busy: { padding: Spacing.lg, gap: Spacing.md },
  track: { height: 6, borderRadius: Radius.pill, overflow: 'hidden' },
  fill: { height: 6, borderRadius: Radius.pill },
  cancelBtn: { marginTop: Spacing.xs },
  pwGroup: { marginBottom: Spacing.sm },
  pwInput: { minHeight: 50, paddingHorizontal: Spacing.lg },
  pwDivider: { borderBottomWidth: StyleSheet.hairlineWidth },
  pwHint: { marginHorizontal: Spacing.xs, lineHeight: 18, minHeight: 36 },
  pwActions: { gap: Spacing.sm, marginTop: Spacing.lg },
});

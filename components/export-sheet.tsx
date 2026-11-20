// components/export-sheet.tsx
// Export / share / print a document.
//
// The native share sheet and print dialog are presented ON TOP of this sheet
// (presenting over an open RN Modal works; presenting while it is dismissing
// does not), so there is no close-then-share timing race. Nothing here ever
// waits on the share sheet: `shareFile` returns as soon as the sheet is up, so
// the UI can't get stuck if expo-sharing never settles. Work in progress shows a
// progress state with Cancel, and closing the sheet cancels it too.
import { Alert, Linking, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  canProtectPdf,
  estimatePdfBytes,
  MIN_PDF_PASSWORD,
  PageSize,
  PageStat,
  paperLabel as paperName,
  PdfCancelledError,
  PdfError,
  PdfQuality,
  PdfProgressPhase,
  PdfProtectError,
  roundUpEstimate,
  type PageNumberPosition,
  type PageNumberStyle,
  type PdfMargin,
  type PdfOrientation,
} from '@/lib/pdf';
import {
  DEFAULT_EXPORT_LAYOUT,
  getExportPageNumbers,
  isDefaultLayout,
  layoutSummary,
  loadExportLayout,
  MARGIN_LABELS,
  paperOverride,
  setExportLayout,
  setExportPageNumbers,
  type ExportLayout,
} from '@/lib/export-prefs';
import { smallerPdfChoice, smallerPdfIsSmaller } from '@/lib/compress-pdf';
import { useRememberedPrefs } from '@/components/use-remembered-prefs';
import { AppSwitch } from '@/components/app-switch';
import { buildScanPdf, protectDocumentPdf } from '@/lib/pdf-protect';
import { SegmentedControl } from '@/components/segmented-control';
import {
  cleanFileUri,
  clearExportCache,
  deleteQuietly,
  exportFileName,
  makeExportDir,
  placeExportFile,
  printFile,
  canShareFiles,
  shareFile,
  shareFiles,
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
import { pageStats } from '@/lib/page-stats';
import { formatBytes } from '@/components/tool-ui';
import { zipFiles } from '@/lib/zip-stream';
import { notifySuccess } from '@/lib/haptics';
import { canFlattenPdf, flattenPdfCopy, pdfShareInfo, shouldOfferFlatten } from '@/lib/pdf-fill';
import { PdfEditError } from '@/lib/pdf-edit';
import { PdfSessionError, readablePdfUri } from '@/lib/pdf-session';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

type Props = {
  visible: boolean;
  document: Document;
  onClose: () => void;
};

type Action = 'pdf' | 'small' | 'protected' | 'flat' | 'images' | 'zip' | 'photos' | 'print';

type Busy = { title: string; label: string; progress: number };

type BuiltFile = { uri: string; mimeType: string; UTI: string };
/** The pages as separate JPEG files, shared together (Messages, Mail, Photos-friendly apps). */
type BuiltImages = { uris: string[] };

class CancelledError extends Error {}

/** The PDF options, with a stored paper equal to Document settings' read as "Same as Document settings". */
const loadLayout = () => loadExportLayout(() => getDocSettings().then(s => s.pdfPageSize));
const NUMBERS_OFF: { style: PageNumberStyle } = { style: 'off' };
const loadPageNumbers = () => getExportPageNumbers().then(style => ({ style }));
const savePageNumbers = (v: { style: PageNumberStyle }) => setExportPageNumbers(v.style);

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
  if (action === 'flat') {
    if (err instanceof PdfEditError && err.kind === 'restricted') {
      return { title, body: 'Its author doesn’t allow changing this PDF, so it can’t be flattened. You can still share it as it is.' };
    }
    return { title, body: 'Couldn’t flatten this PDF. You can still share it as it is.' };
  }
  if (action === 'images' || action === 'zip') return { title, body: 'Couldn’t prepare the images. Check that your device has free space and try again.' };
  if (action === 'photos') return { title: 'Couldn’t save to Photos', body: 'Check that your device has free space and try again.' };
  return { title, body: 'Something went wrong. Try again.' };
}

export function ExportSheet({ visible, document, onClose }: Props) {
  const { colors, isDark } = useTheme();
  const toast = useToast();
  const [busy, setBusy] = useState<Busy | null>(null);
  // Document settings' paper: what the PDF uses unless PDF options choose one.
  const [pageSize, setPageSize] = useState<PageSize>('A4');
  // PDF options (round 16): paper, orientation, margins, image quality, page
  // number position and the text layer, remembered between exports
  // (lib/export-prefs.ts). The defaults make exactly the PDF this sheet made
  // before the options existed: Document settings' paper, standard quality.
  // The old Document settings "PDF image quality" stays unused here: a stored
  // 'high' would stick with no way to change it from this sheet.
  // Re-read each time the sheet is shown (Create PDF shares them); a choice
  // made before they arrive wins (components/use-remembered-prefs.ts).
  const [layout, updateLayout] = useRememberedPrefs<ExportLayout>(DEFAULT_EXPORT_LAYOUT, loadLayout, setExportLayout, {
    active: visible,
  });
  const quality: PdfQuality = layout.quality;
  const paper: PageSize = layout.paper ?? pageSize;
  const [optionsMode, setOptionsMode] = useState(false);
  // The shared file's name for this export only ('' = the document's name).
  const [fileName, setFileName] = useState('');
  // Page numbers on exported PDFs (and print): remembered between exports.
  const [{ style: pageNumbers }, updatePageNumbers] = useRememberedPrefs<{ style: PageNumberStyle }>(
    NUMBERS_OFF,
    loadPageNumbers,
    savePageNumbers,
    { active: visible },
  );
  const [bytes, setBytes] = useState<number | null>(null);
  const [stats, setStats] = useState<PageStat[] | null>(null);
  // An imported PDF with form fields or additions can also go out flattened.
  // An imported PDF that needs a password to open (it is shared as it is).
  const [needsPassword, setNeedsPassword] = useState(false);
  const [canFlatten, setCanFlatten] = useState(false);
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
      setOptionsMode(false);
      setPw('');
      setPw2('');
      return;
    }
    setFileName('');
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
    setCanFlatten(false);
    setNeedsPassword(false);
    if (document.pdfUri) {
      // The original is shared as stored: a protected PDF stays protected
      // (lib/pdf-session.ts never decrypts the stored file), so the row says so.
      pdfShareInfo(document.pdfUri).then(i => { if (!cancelled) setNeedsPassword(!!i?.locked); });
      if (canFlattenPdf()) {
        // Unlocked this session: offered from its decrypted copy (a new file, no password).
        readablePdfUri(document)
          .catch(() => document.pdfUri as string)
          .then(pdfShareInfo)
          .then(i => { if (!cancelled) setCanFlatten(shouldOfferFlatten(i)); });
      }
    }
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
  // Every shared file (and the print job) is named after this.
  const outName = fileName.trim() || document.name;
  // The recognized text (search index): shared as plain text, ready to paste.
  // Hidden when the document has none yet.
  const docText = document.ocrText?.trim() ?? '';
  const ocrCan = !isPdfDoc && pageCount > 0 && ocrAvailable();
  // PDF options can turn the text layer off (faster, a little smaller).
  const canSearchable = ocrCan && layout.searchable;
  const canProtect = canProtectPdf() && (isPdfDoc || pageCount > 0);
  // Several pages go out as separate images (what Messages, Mail and photo
  // apps want) when this build can share several files at once; the ZIP stays
  // as its own option for many pages or for saving to Files.
  const shareImagesApart = !isPdfDoc && pageCount > 1 && canShareFiles();

  const cancelWork = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(null);
  }, []);

  const handleClose = useCallback(() => {
    cancelWork();
    onClose();
  }, [cancelWork, onClose]);

  async function buildPdf(q: PdfQuality, searchable: boolean, signal: AbortSignal, title: string, maxEdge?: number): Promise<string> {
    setBusy({ title, label: 'Preparing', progress: 0 });
    // The same build as Tools › Protect PDF (lib/pdf-protect.ts): Document
    // settings' paper size read fresh.
    return buildScanPdf(document.pages, {
      fallbackPageSize: pageSize,
      quality: q,
      maxEdge,
      searchable,
      pageNumbers,
      layout,
      signal,
      onProgress: (done, total, phase) => {
        if (signal.aborted) return;
        // Reserve the last 15% of the bar for the native render step.
        const progress = phase === 'rendering' ? 0.9 : (done / total) * 0.85 + (phase === 'reading-text' ? 0.4 / total : 0);
        setBusy({ title, label: pdfPhaseLabel(phase, done, total), progress });
      },
    });
  }

  async function buildImages(signal: AbortSignal, dir: string, asZip: boolean): Promise<BuiltFile | BuiltImages> {
    const title = pageCount === 1 ? 'Preparing image' : 'Preparing images';
    if (pageCount === 1) {
      setBusy({ title, label: 'Preparing image', progress: 0.5 });
      const uri = await placeExportFile(document.pages[0], dir, exportFileName(outName, 'jpg'), 'copy');
      return { uri, mimeType: 'image/jpeg', UTI: 'public.jpeg' };
    }
    if (!asZip) {
      // Each page under the document's name, numbered so they sort in order.
      const digits = String(pageCount).length;
      const uris: string[] = [];
      for (let i = 0; i < pageCount; i++) {
        if (signal.aborted) throw new CancelledError();
        setBusy({ title, label: `Adding page ${i + 1} of ${pageCount}`, progress: (i / pageCount) * 0.95 });
        const name = exportFileName(`${outName} - page ${String(i + 1).padStart(digits, '0')}`, 'jpg');
        uris.push(await placeExportFile(document.pages[i], dir, name, 'copy'));
      }
      return { uris };
    }
    // Streamed straight to the file (lib/zip-stream.ts, as Share documents
    // does): each page is copied in 1 MB chunks, STORED (JPEGs don't compress
    // further), so memory stays flat however many pages there are — never the
    // whole archive in memory twice (r12 device review B2).
    const uri = `${dir}${encodeURIComponent(exportFileName(outName, 'zip'))}`;
    const pages = [...document.pages];
    const date = new Date(document.updatedAt || document.createdAt || Date.now());
    await zipFiles(
      uri,
      pages.map((page, i) => ({
        name: `Page ${String(i + 1).padStart(2, '0')}.jpg`,
        date,
        produce: async () => ({ uri: cleanFileUri(page), temporary: false }),
      })),
      {
        signal,
        onItem: i => {
          if (!signal.aborted) setBusy({ title, label: `Adding page ${i + 1} of ${pageCount}`, progress: (i / pageCount) * 0.95 });
        },
      },
    );
    if (signal.aborted) throw new CancelledError();
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
          // A protected PDF prints from its session copy when it is unlocked,
          // if its author allows printing (lib/pdf-session.ts).
          try {
            uri = await readablePdfUri(document, { needs: ['printLow'] });
          } catch (err) {
            if (err instanceof PdfSessionError && err.kind === 'restricted') {
              setBusy(null);
              Alert.alert('This PDF can’t be printed', 'Its author doesn’t allow printing it.');
              return;
            }
            throw err;
          }
        } else {
          const raw = await buildPdf('high', false, signal, 'Preparing to print');
          if (signal.aborted) await deleteQuietly(raw);
          check();
          // Named after the document so the print job isn't called "<uuid>.pdf".
          uri = await placeExportFile(raw, await makeExportDir(), exportFileName(outName, 'pdf'), 'move');
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
      let file: BuiltFile | BuiltImages;
      if (action === 'protected') {
        // The normal PDF first (the imported file itself for a PDF document),
        // then a protected copy under the document's name. The unprotected
        // temp file is deleted straight away; only the protected one is shared.
        const title = 'Creating protected PDF';
        const out = `${dir}${encodeURIComponent(exportFileName(outName, 'pdf'))}`;
        // A protected PDF unlocked this session: from its decrypted copy, with the new password.
        const source = isPdfDoc ? { pdfUri: await readablePdfUri(document) } : document;
        const uri = await protectDocumentPdf(source, out, password ?? '', {
          signal,
          build: () => buildPdf(quality, canSearchable, signal, title),
          beforeProtect: () => setBusy({ title, label: 'Adding the password', progress: 0.95 }),
        });
        file = { uri, ...PDF_FILE };
        setPw('');
        setPw2('');
        setPwMode(false);
      } else if (action === 'flat' && isPdfDoc) {
        // A copy with the form values and signatures drawn into the pages; the stored PDF is untouched.
        setBusy({ title: 'Flattening PDF', label: 'Flattening PDF', progress: 0.5 });
        const out = `${dir}${encodeURIComponent(exportFileName(outName, 'pdf'))}`;
        const uri = await flattenPdfCopy(await readablePdfUri(document), out);
        file = { uri, ...PDF_FILE };
      } else if (isPdfDoc) {
        setBusy({ title: 'Preparing PDF', label: 'Preparing PDF', progress: 0.5 });
        const uri = await placeExportFile(document.pdfUri!, dir, exportFileName(outName, 'pdf'), 'copy');
        file = { uri, ...PDF_FILE };
      } else if (action === 'images' || action === 'zip') {
        file = await buildImages(signal, dir, action === 'zip' || !shareImagesApart);
      } else {
        // Every PDF is searchable when text recognition is available: that is
        // what people expect from a scanner app's PDF.
        // Smaller PDF: a step below the PDF row's quality, never the same file.
        const choice = action === 'small' ? smallerPdfChoice(quality) : { quality, maxEdge: undefined };
        const title = action === 'small' ? 'Creating smaller PDF' : 'Creating PDF';
        const raw = await buildPdf(choice.quality, canSearchable, signal, title, choice.maxEdge);
        if (signal.aborted) await deleteQuietly(raw);
        check();
        const uri = await placeExportFile(raw, dir, exportFileName(outName, 'pdf'), 'move');
        file = { uri, ...PDF_FILE };
      }
      check();
      setBusy(null);

      // Waits while App Lock is on (an export that finishes behind the lock
      // screen must not present over it), and presents nothing if this sheet
      // was closed meanwhile (closing aborts `signal`).
      // Close once the share sheet is done, unless the user has moved on.
      const onFinish = () => {
        if (sessionRef.current === session) onClose();
      };
      if ('uris' in file) {
        await shareFiles(file.uris, { dialogTitle: outName, signal, onFinish });
      } else {
        await shareFile(file.uri, {
          mimeType: file.mimeType,
          UTI: file.UTI,
          dialogTitle: outName,
          signal,
          onFinish,
        });
      }
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
  const estimate = (q: PdfQuality, maxEdge?: number) =>
    stats ? `about ${formatBytes(roundUpEstimate(estimatePdfBytes(stats, q, canSearchable, maxEdge)))}` : null;
  // Short enough that the size, the number people check, always fits on the
  // row: "Searchable · about 240 KB".
  const detailLine = (parts: (string | null)[]) => parts.filter(Boolean).join(' · ');
  const pdfDetail = detailLine([canSearchable ? 'Searchable' : pagesLabel, estimate(quality)]);
  const smaller = smallerPdfChoice(quality);
  const smallDetail = detailLine(['For email', estimate(smaller.quality, smaller.maxEdge)]);
  // Offered only while it makes a smaller file than "PDF" (estimates; shown until they're in).
  const offerSmaller = smallerPdfIsSmaller(stats, quality, canSearchable);
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
  const printDetail = detailLine([Platform.OS === 'android' ? 'Print or save as PDF' : 'Any AirPrint printer', paper === 'Auto' || isPdfDoc ? null : paperName(paper)]);
  const optionsSummary = layoutSummary(layout, paper, ocrCan);
  const choosePageNumbers = (p: PageNumberStyle) => updatePageNumbers({ style: p });
  // Only a paper other than Document settings' is pinned; "Same as Document
  // settings" (null) follows it when it changes.
  const choosePaper = (v: PageSize | null) => updateLayout({ paper: paperOverride(v, pageSize) });
  const paperRows = PAPER_OPTIONS.filter(o => o.value !== pageSize);
  // Each choice reads as what lands on the page: nothing, "1, 2, 3", "1 of 3".
  const pageTotal = Math.max(1, pageCount);
  const pageNumberOptions: { value: PageNumberStyle; label: string }[] = [
    { value: 'off', label: 'Off' },
    { value: 'number', label: pageTotal > 2 ? '1, 2, 3' : pageTotal === 2 ? '1, 2' : '1' },
    { value: 'of-total', label: `1 of ${pageTotal}` },
  ];
  const numbersLabel = pageNumberOptions[1].label;
  // Where PDF options put them (bottom centre unless chosen otherwise).
  const where =
    layout.numberPosition === 'top-right' ? 'At the top right' : layout.numberPosition === 'bottom-right' ? 'At the bottom right' : 'At the bottom';
  const pageNumberNote =
    pageNumbers === 'number'
      ? `${where} of each page: ${numbersLabel}${pageTotal > 3 ? '…' : ''}`
      : pageNumbers === 'of-total'
        ? `${where} of each page: 1 of ${pageTotal}${pageTotal > 1 ? `, 2 of ${pageTotal}${pageTotal > 2 ? '…' : ''}` : ''}`
        : 'Added at the bottom of each page of a PDF or print.';

  return (
    <BottomSheet visible={visible} onClose={handleClose} variant="grouped">
      {optionsMode && !busy ? (
        <SheetHeader title={isPdfDoc ? 'File name' : 'PDF options'} subtitle={document.name} />
      ) : (
        <SheetHeader title={document.name} subtitle={subtitle} />
      )}

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
      ) : optionsMode ? (
        // PDF options: everything past the common choices, in one scrolling
        // panel of the sheet (an Alert or a second Modal can't open over it).
        <>
          <ScrollView style={styles.optionsScroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            {!isPdfDoc ? (
              <>
                <SectionLabel style={styles.label}>Paper</SectionLabel>
                <SheetGroup>
                  <SheetRow
                    label="Same as Document settings"
                    detail={pageSize === 'Auto' ? 'Auto: each page’s paper is shaped like its scan' : PAPER_NOTES[pageSize]}
                    selected={layout.paper === null}
                    onPress={() => choosePaper(null)}
                  />
                  {paperRows.map((o, i) => (
                    <SheetRow
                      key={o.value}
                      label={paperName(o.value)}
                      detail={PAPER_SIZES[o.value]}
                      selected={layout.paper === o.value}
                      onPress={() => choosePaper(o.value)}
                      last={i === paperRows.length - 1}
                    />
                  ))}
                </SheetGroup>
                {paper !== 'Auto' ? (
                  <>
                    <SectionLabel style={styles.label}>Orientation</SectionLabel>
                    <SheetGroup>
                      <View style={styles.numbersBody}>
                        <SegmentedControl
                          options={ORIENTATION_OPTIONS}
                          value={layout.orientation}
                          onChange={v => updateLayout({ orientation: v })}
                        />
                        <Text style={[Type.footnote, styles.numbersNote, { color: colors.muted }]} numberOfLines={2}>
                          {ORIENTATION_NOTES[layout.orientation]}
                        </Text>
                      </View>
                    </SheetGroup>
                  </>
                ) : null}
                <SectionLabel style={styles.label}>Margins</SectionLabel>
                <SheetGroup>
                  <View style={styles.numbersBody}>
                    <SegmentedControl options={MARGIN_OPTIONS} value={layout.margin} onChange={v => updateLayout({ margin: v })} />
                    <Text style={[Type.footnote, styles.numbersNote, { color: colors.muted }]} numberOfLines={2}>
                      {MARGIN_LABELS[layout.margin].detail}
                    </Text>
                  </View>
                </SheetGroup>
                <SectionLabel style={styles.label}>Image quality</SectionLabel>
                <SheetGroup>
                  {QUALITY_OPTIONS.map((q, i) => (
                    <SheetRow
                      key={q.value}
                      label={q.label}
                      detail={detailLine([q.detail, estimate(q.value)])}
                      selected={layout.quality === q.value}
                      onPress={() => updateLayout({ quality: q.value })}
                      last={i === QUALITY_OPTIONS.length - 1}
                    />
                  ))}
                </SheetGroup>
                {pageNumbers !== 'off' ? (
                  <>
                    <SectionLabel style={styles.label}>Page number position</SectionLabel>
                    <SheetGroup>
                      <View style={styles.numbersBody}>
                        <SegmentedControl
                          options={POSITION_OPTIONS}
                          value={layout.numberPosition}
                          onChange={v => updateLayout({ numberPosition: v })}
                        />
                      </View>
                    </SheetGroup>
                  </>
                ) : null}
                {ocrCan ? (
                  <SheetGroup style={styles.switchGroup}>
                    <View style={styles.switchRow}>
                      <View style={styles.switchText}>
                        <Text style={[Type.body, { color: colors.text }]}>Searchable text</Text>
                        <Text style={[Type.footnote, styles.switchDetail, { color: colors.muted }]}>
                          {layout.searchable
                            ? 'Text in the PDF can be searched, selected and copied.'
                            : 'Off: the PDF is only pictures of the pages. Faster to make.'}
                        </Text>
                      </View>
                      <AppSwitch
                        value={layout.searchable}
                        onValueChange={v => updateLayout({ searchable: v })}
                        accessibilityLabel="Searchable text"
                      />
                    </View>
                  </SheetGroup>
                ) : null}
              </>
            ) : null}
            <SectionLabel style={styles.label}>File name</SectionLabel>
            <SheetGroup style={styles.pwGroup}>
              <TextInput
                style={[Type.body, styles.pwInput, { color: colors.text }]}
                value={fileName}
                onChangeText={setFileName}
                placeholder={document.name}
                placeholderTextColor={colors.muted}
                autoCorrect={false}
                keyboardAppearance={isDark ? 'dark' : 'light'}
                returnKeyType="done"
                maxLength={80}
                accessibilityLabel="File name"
              />
            </SheetGroup>
            <Text style={[Type.footnote, styles.pwHint, { color: colors.muted }]}>
              For this export only. The document keeps its name.
            </Text>
          </ScrollView>
          <View style={styles.optionsActions}>
            <PrimaryButton title="Done" onPress={() => setOptionsMode(false)} />
            {!isPdfDoc && !isDefaultLayout(layout) ? (
              <PrimaryButton
                title="Restore defaults"
                variant="secondary"
                onPress={() => updateLayout(DEFAULT_EXPORT_LAYOUT)}
              />
            ) : null}
          </View>
        </>
      ) : (
        // Scrolls when it is taller than the sheet may be (large text, small phones).
        <ScrollView style={styles.optionsScroll}>
          {/* PDF and print only (JPEG images stay as stored). Imported PDFs
              are shared as the file itself, so they get no numbers. */}
          {!isPdfDoc && pageCount > 0 ? (
            <>
              <SectionLabel style={styles.label}>Page numbers</SectionLabel>
              <SheetGroup>
                <View style={styles.numbersBody} accessibilityLabel="Page numbers">
                  <SegmentedControl options={pageNumberOptions} value={pageNumbers} onChange={choosePageNumbers} />
                  <Text style={[Type.footnote, styles.numbersNote, { color: colors.muted }]} numberOfLines={1}>
                    {pageNumberNote}
                  </Text>
                </View>
              </SheetGroup>
            </>
          ) : null}
          <SheetGroup>
            <SheetRow
              icon={isPdfDoc ? 'text-outline' : 'options-outline'}
              label={isPdfDoc ? 'File name' : 'PDF options'}
              detail={isPdfDoc ? outName : optionsSummary}
              onPress={() => setOptionsMode(true)}
              chevron
              last
            />
          </SheetGroup>
          <SectionLabel style={styles.label}>Share as</SectionLabel>
          <SheetGroup>
            {isPdfDoc ? (
              <>
                <SheetRow
                  icon="document-text-outline"
                  label="PDF"
                  detail={detailLine([needsPassword ? 'Needs its password' : 'Original file', sizeLabel])}
                  onPress={() => run('pdf')}
                  last={!canFlatten && !canProtect && !docText}
                />
                {canFlatten ? (
                  <SheetRow
                    icon="layers-outline"
                    label="Flattened PDF"
                    detail="Form and signatures can’t be changed"
                    onPress={() => run('flat')}
                    last={!canProtect && !docText}
                  />
                ) : null}
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
                {offerSmaller ? (
                  <SheetRow
                    icon="contract-outline"
                    label="Smaller PDF"
                    detail={smallDetail}
                    onPress={() => run('small')}
                  />
                ) : null}
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
                  detail={detailLine([
                    pageCount === 1 ? 'One image' : shareImagesApart ? `${pageCount} images` : `${pageCount} images in a ZIP`,
                    sizeLabel,
                  ])}
                  onPress={() => run('images')}
                  last={!docText && !shareImagesApart}
                />
                {shareImagesApart ? (
                  <SheetRow
                    icon="archive-outline"
                    label="JPEG images in a ZIP"
                    detail={detailLine(['One file', sizeLabel])}
                    onPress={() => run('zip')}
                    last={!docText}
                  />
                ) : null}
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
          {isPdfDoc ? (
            <Text style={[Type.footnote, styles.pdfNote, { color: colors.muted }]}>
              An imported PDF is shared as it is. Page numbers can be added to scanned documents.
            </Text>
          ) : null}
        </ScrollView>
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
  numbersBody: { padding: Spacing.sm, gap: Spacing.sm },
  numbersNote: { paddingHorizontal: Spacing.sm },
  pdfNote: { marginTop: Spacing.sm, marginHorizontal: Spacing.xs, lineHeight: 18 },
  // The options panel scrolls inside the sheet (whose height is capped).
  optionsScroll: { flexGrow: 0, flexShrink: 1 },
  optionsActions: { gap: Spacing.sm, marginTop: Spacing.md },
  switchGroup: { marginTop: Spacing.lg },
  // Same metrics as SheetRow (components/bottom-sheet.tsx).
  switchRow: { flexDirection: 'row', alignItems: 'center', minHeight: HIT + 6, paddingLeft: Spacing.lg, paddingRight: Spacing.lg, gap: Spacing.md },
  switchText: { flex: 1, paddingVertical: Spacing.md },
  switchDetail: { marginTop: 1, lineHeight: 18 },
});

// ── PDF options ──────────────────────────────────────────────────────────────

const PAPER_OPTIONS: { value: PageSize; label: string }[] = [
  { value: 'Auto', label: 'Auto' },
  { value: 'A4', label: 'A4' },
  { value: 'Letter', label: 'Letter' },
  { value: 'Legal', label: 'Legal' },
];
const PAPER_NOTES: Record<PageSize, string> = {
  Auto: 'Each page’s paper is shaped like its scan',
  A4: 'A4, 210 × 297 mm',
  Letter: 'US Letter, 8.5 × 11 in',
  Legal: 'US Legal, 8.5 × 14 in',
};
/** A paper row's detail (its name is the row's label). */
const PAPER_SIZES: Record<PageSize, string> = {
  Auto: 'Each page’s paper is shaped like its scan',
  A4: '210 × 297 mm',
  Letter: '8.5 × 11 in',
  Legal: '8.5 × 14 in',
};
const ORIENTATION_OPTIONS: { value: PdfOrientation; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
];
const ORIENTATION_NOTES: Record<PdfOrientation, string> = {
  auto: 'Each page turns to match its scan',
  portrait: 'Every page upright; wide scans are scaled to fit',
  landscape: 'Every page sideways; tall scans are scaled to fit',
};
const MARGIN_OPTIONS: { value: PdfMargin; label: string }[] = (['none', 'small', 'normal', 'wide'] as const).map(m => ({
  value: m,
  label: MARGIN_LABELS[m].label,
}));
const QUALITY_OPTIONS: { value: PdfQuality; label: string; detail: string }[] = [
  { value: 'high', label: 'High', detail: 'Sharpest, for printing' },
  { value: 'standard', label: 'Standard', detail: 'Clear text' },
  { value: 'small', label: 'Small', detail: 'For email' },
];
const POSITION_OPTIONS: { value: PageNumberPosition; label: string }[] = [
  { value: 'bottom-center', label: 'Bottom' },
  { value: 'bottom-right', label: 'Bottom right' },
  { value: 'top-right', label: 'Top right' },
];

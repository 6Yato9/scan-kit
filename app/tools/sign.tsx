// app/tools/sign.tsx
// Draw (or pick a saved) signature, then place it on the page by hand right
// under it — drag it to move it, drag a corner or pinch to resize it
// (components/placement-frame.tsx) — choose its ink and the page (or every
// page), and sign the
// document itself: the signature is drawn into the page (and its unfiltered
// shadow), so the pages stay searchable and re-filterable, and the viewer
// offers Undo (lib/page-stamp.ts). "Save as a copy" signs a duplicate.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  type LayoutChangeEvent,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { AppSwitch } from '@/components/app-switch';
import {
  ColorSwatches,
  FooterActions,
  NoDocumentsScreen,
  PagePreview,
  SectionRow,
  ToolNote,
  ToolProgress,
  ToolScreen,
  useImageAspect,
  useToolDocuments,
} from '@/components/tool-ui';
import { ToolDocPicker, useConvertiblePdfs, useToolDoc, type PickerConvert } from '@/components/tool-doc';
import { FilterBaker } from '@/components/filter-baker';
import { PageThumb } from '@/components/page-thumb';
import { reportStampFailure, usePageStamper, useStampFinish } from '@/components/page-stamper';
import { SignaturePlacer } from '@/components/placement-frame';
import { signaturePadHtml } from '@/components/signature-pad';
import { useRouter } from 'expo-router';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { canFillPdf, pdfFillHref } from '@/lib/pdf-fill';
import { signBlockedReason, useFillAccessMap } from '@/lib/fill-access';
import { emptySpotPlacement, lineToPageRect, type PageRect } from '@/lib/placement';
import { recognizeLines } from '@/lib/ocr';
import { getImageSize } from '@/lib/image-size';
import { copyName, stampCopy, stampPages, targetPages } from '@/lib/page-stamp';
import { notifySuccess, tapLight } from '@/lib/haptics';
import {
  SIGNATURE_INK,
  clampPlacement,
  type Placement,
  type Signature,
  type SignatureInk,
} from '@/lib/stamp';
import { HIT, Ink, Radius, Spacing, Type } from '@/lib/theme';
import type { Document } from '@/types/document';
import {
  forgetSignature,
  listSavedSignatures,
  loadSavedSignature,
  rememberSignature,
  type SavedSignature,
} from '@/lib/saved-signatures';

const PAD_HEIGHT = 180;
/**
 * A new signature's width on the page, as a fraction of the page width: big
 * enough that its corner handles sit around it, not on it.
 */
const START_WIDTH = 0.38;
/** After the last stroke, how long before the screen scrolls the page into view. */
const REVEAL_AFTER_DRAW_MS = 1200;
const INKS: { value: SignatureInk; label: string; color: string }[] = [
  { value: 'black', label: 'Black', color: SIGNATURE_INK.black },
  { value: 'blue', label: 'Blue', color: SIGNATURE_INK.blue },
];

export default function SignScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebView>(null);
  const { docs, loaded, reload } = useToolDocuments();
  // Imported PDFs: listed in the picker with Convert, never a dead end.
  const { pdfs, loaded: pdfsLoaded, reload: reloadPdfs } = useConvertiblePdfs();
  const pdfAccess = useFillAccessMap(canFillPdf() ? pdfs : []);
  const [sig, setSig] = useState<Signature | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [everyPage, setEveryPage] = useState(false);
  const [ink, setInk] = useState<SignatureInk>('black');
  const [placement, setPlacement] = useState<Placement | null>(null);
  // A finger is moving or resizing the signature: the screen doesn't scroll.
  const [placing, setPlacing] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  const { doc, docId, setDocId, fixed, fromViewer, routePage } = useToolDoc(docs);
  const stamper = usePageStamper();
  const finish = useStampFinish(fromViewer);
  // Signatures used before (newest first) and the one picked, if any.
  const [saved, setSaved] = useState<SavedSignature[]>([]);
  const [savedPick, setSavedPick] = useState<string | null>(null);
  useEffect(() => {
    listSavedSignatures().then(setSaved).catch(() => {});
  }, []);
  // From the Tools tab with a single document: there is nothing to choose.
  useEffect(() => {
    if (loaded && !fixed && !docId && docs.length === 1) {
      setDocId(docs[0].id);
      setPageIndex(docs[0].pages.length - 1);
    }
  }, [loaded, fixed, docId, docs, setDocId]);
  // Opened on a document: start on the page the viewer was showing (its Tools
  // sheet passes it), else on the last page, like picking it would.
  const startedOn = useRef<string | null>(null);
  useEffect(() => {
    if (fixed && doc && startedOn.current !== doc.id) {
      startedOn.current = doc.id;
      setPageIndex(routePage ?? doc.pages.length - 1);
    }
  }, [fixed, doc, routePage]);
  const pageUri = doc ? doc.pages[Math.min(pageIndex, doc.pages.length - 1)] : null;
  const aspect = useImageAspect(pageUri);
  const pageText = usePageText(pageUri);
  // Kept whole on this page whatever page or signature it was made for. Until
  // the user moves it, it starts in an empty spot near the bottom right (clear
  // of the page's text when it has been read).
  const place = sig
    ? clampPlacement(sig, placement ?? emptySpotPlacement(sig.height / sig.width, aspect, pageText, START_WIDTH), aspect)
    : null;

  // Once there is a signature, the page it goes on scrolls into view: at once
  // for a saved one, a moment after the last stroke for a drawn one (so a
  // second stroke, a dot on an i, isn't cut off by the scroll).
  const scrollRef = useRef<ScrollView>(null);
  const placerY = useRef<number | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealed = useRef(false);
  const cancelReveal = () => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = null;
  };
  useEffect(() => () => cancelReveal(), []);
  const revealPlacer = (delay: number) => {
    cancelReveal();
    if (revealed.current) return;
    revealTimer.current = setTimeout(() => {
      revealTimer.current = null;
      if (placerY.current == null) return;
      revealed.current = true;
      scrollRef.current?.scrollTo({ y: Math.max(0, placerY.current - Spacing.xl), animated: true });
    }, delay);
  };
  const onPlacementLayout = (e: LayoutChangeEvent) => {
    placerY.current = e.nativeEvent.layout.y;
  };

  // The pad draws in the theme's text colour; a theme change reloads it empty.
  const html = useMemo(() => signaturePadHtml(colors.text, Ink.signature, PAD_HEIGHT), [colors.text]);
  useEffect(() => {
    // A saved signature survives a theme change; a drawn one is gone with the pad.
    if (!savedPick) setSig(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  const onPadMessage = (e: { nativeEvent: { data: string } }) => {
    const data = e.nativeEvent.data;
    if (data === 'EMPTY') {
      if (!savedPick) setSig(null);
      return;
    }
    try {
      const parsed = JSON.parse(data) as Signature;
      if (!parsed.dataUri?.startsWith('data:image/png') || !(parsed.width > 0)) throw new Error('bad');
      // Keep any placement the user already chose; clampPlacement fits the new shape.
      setSig(parsed);
      setSavedPick(null);
      revealPlacer(REVEAL_AFTER_DRAW_MS);
    } catch {
      Alert.alert('Couldn’t capture the signature', 'Clear the box and try again.');
    }
  };

  const clearSignature = () => {
    webRef.current?.injectJavaScript('clearPad(); true;');
    setSig(null);
    setSavedPick(null);
    setPlacement(null);
    cancelReveal();
    revealed.current = false;
    tapLight();
  };

  const pickSaved = async (s: SavedSignature) => {
    if (progress) return;
    try {
      const loaded = await loadSavedSignature(s);
      webRef.current?.injectJavaScript('clearPad(); true;');
      setSig(loaded);
      setSavedPick(s.id);
      tapLight();
      revealPlacer(150);
    } catch {
      Alert.alert('Couldn’t load the signature', 'Draw it in the box instead.');
    }
  };

  const removeSaved = (s: SavedSignature) => {
    Alert.alert('Remove this saved signature?', 'You can save it again by signing with it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await forgetSignature(s.id).catch(() => {});
          if (savedPick === s.id) {
            setSig(null);
            setSavedPick(null);
          }
          setSaved(await listSavedSignatures().catch(() => []));
        },
      },
    ]);
  };

  const pickDoc = (d: Document) => {
    if (progress) return;
    setDocId(d.id);
    // Contracts are usually signed on the last page.
    setPageIndex(d.pages.length - 1);
    setPlacement(null);
  };


  const pages = doc ? targetPages(doc.pages.length, pageIndex, everyPage) : [];
  const pagesLabel = !doc ? '' : pages.length > 1 ? `all ${pages.length} pages` : doc.pages.length > 1 ? `page ${pages[0] + 1}` : 'the page';

  /** Signs the document itself (Undo in the viewer), or a copy of it. */
  const apply = async (mode: 'in-place' | 'copy') => {
    if (!doc || !sig || !place || progress) return;
    const spec = { kind: 'signature' as const, signature: sig, placement: place, ink };
    const render = (pageUri: string, origUri: string | null) => stamper.stamp(pageUri, origUri, spec);
    const onProgress = (done: number, total: number) => setProgress({ current: done, total });
    setProgress({ current: 0, total: pages.length });
    try {
      if (mode === 'copy') {
        const copy = await stampCopy(doc, copyName(doc.name, 'signed'), pages, render, onProgress, stamper.signal);
        await rememberSignature(sig);
        notifySuccess();
        finish({ docId: copy.id, message: 'Signed copy saved. The original is unchanged.', page: pages[0], openCopy: true });
      } else {
        const { undo } = await stampPages(doc.id, pages, render, { onProgress, signal: stamper.signal });
        // Remembered for next time (moves up if it was a saved one already).
        await rememberSignature(sig);
        notifySuccess();
        finish({
          docId: doc.id,
          message: pages.length > 1 ? `Signed ${pages.length} pages` : doc.pages.length > 1 ? `Signed page ${pages[0] + 1}` : 'Signed',
          page: pages[0],
          undo,
          undoneMessage: 'Signature removed',
        });
      }
    } catch (err) {
      // Says only what is true: cancelled (closed), partly done, or unchanged.
      reportStampFailure(err, 'Couldn’t sign the document', 'Signature removed');
    } finally {
      setProgress(null);
    }
  };

  // Picking an imported PDF opens it in Fill & sign, which signs it as it is
  // (text stays text). Builds without it convert it to pages (with Undo).
  const convert: PickerConvert = {
    pdfs,
    verb: 'sign',
    open: canFillPdf()
      ? {
          label: 'Fill & sign',
          hint: 'Opens it in Fill & sign',
          note: 'PDFs open in Fill & sign, where you can fill in their forms and sign them as they are.',
          onOpen: pdf => { navigateWhenUnlocked(() => router.replace(pdfFillHref(pdf.id, 'last'))); },
          // Its author forbids signing: say so here, not on a dead-end screen.
          blocked: pdf => signBlockedReason(pdfAccess[pdf.id]),
        }
      : undefined,
    onConverted: d => {
      reload();
      reloadPdfs();
      pickDoc(d);
    },
    onUndone: id => {
      reload();
      reloadPdfs();
      if (docId === id) setDocId(null);
    },
  };

  if (loaded && pdfsLoaded && docs.length === 0 && pdfs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Sign"
        icon="signature"
        subtitle="Sign adds your signature to a scanned document. Scan or import a document first."
      />
    );
  }

  // The page as large as the screen allows: placing by hand needs room for a
  // finger. Full width, but never taller than about half the screen, so a
  // tall page still leaves the controls around it in view.
  const maxPreviewW = screenW - Spacing.gutter * 2 - Spacing.sm * 2;
  const maxPreviewH = Math.max(240, (screenH - insets.top - insets.bottom) * 0.5);
  const previewW = Math.floor(Math.min(maxPreviewW, maxPreviewH / aspect));
  const previewH = previewW * aspect;
  // Always names the outcome ("Sign page 3"); it stays dimmed until there is
  // a signature, and the pad's "Sign here" says what to do. An instruction on a
  // disabled button ("Choose or draw a signature") read as a broken control.
  const buttonTitle = doc ? `Sign ${pagesLabel}` : 'Sign';
  const multiPage = !!doc && doc.pages.length > 1;

  return (
    <ToolScreen
      title="Sign"
      busy={!!progress}
      scrollEnabled={!drawing && !placing}
      scrollRef={scrollRef}
      footer={
        <>
          {progress ? (
            <ToolProgress
              label={progress.total > 1 ? `Signing page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…` : 'Signing…'}
              current={progress.current}
              total={progress.total}
            />
          ) : null}
          <FooterActions
            secondary={
              <PrimaryButton title="Save as a copy" variant="secondary" onPress={() => apply('copy')} disabled={!sig || !doc || !!progress} />
            }
            primary={<PrimaryButton title={buttonTitle} onPress={() => apply('in-place')} disabled={!sig || !doc} loading={!!progress} />}
          />
        </>
      }
    >
      {/* Presented over the viewer: a baker underneath would never run (see FilterBaker). */}
      {fromViewer ? <FilterBaker /> : null}
      {stamper.host}
      {/* 1. Document (fixed when opened on one from the viewer) */}
      <ToolDocPicker
        docs={docs}
        doc={doc}
        fixed={fixed}
        disabled={!!progress}
        onPick={pickDoc}
        autoOpen={loaded && !fromViewer}
        convert={convert}
      />

      {/* 2. Signature — captured as you draw; no separate confirm step. */}
      <SectionRow label="Signature" action={sig ? 'Clear' : undefined} onAction={clearSignature} />
      {saved.length > 0 ? (
        <>
          <View style={styles.savedRow}>
            {saved.map((s, i) => {
              const on = savedPick === s.id;
              return (
                <Pressable
                  key={s.id}
                  onPress={() => pickSaved(s)}
                  onLongPress={() => removeSaved(s)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, checked: on }}
                  accessibilityLabel={i === 0 ? 'Last used signature' : 'Earlier signature'}
                  accessibilityHint="Touch and hold to remove it"
                  style={({ pressed }) => [
                    styles.savedTile,
                    { backgroundColor: colors.card, borderColor: on ? colors.accent : colors.thumbBorder },
                    on && styles.savedTileOn,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  {/* Drawn like the pad: the theme's text colour on the card (a
                      white slab in dark mode otherwise). The ink shows on the page. */}
                  <Image
                    key={colors.text}
                    source={{ uri: s.uri }}
                    style={[styles.savedImg, { tintColor: colors.text }]}
                    resizeMode="contain"
                  />
                  {on ? (
                    <View style={[styles.savedCheck, { backgroundColor: colors.accentFill }]}>
                      <Ionicons name="checkmark" size={13} color={colors.onAccent} />
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
          <Text style={[Type.footnote, styles.orDraw, { color: colors.muted }]}>
            {savedPick ? 'Or draw a new one below.' : 'Tap a saved signature, or draw a new one below.'}
          </Text>
        </>
      ) : null}
      <View
        style={[styles.pad, { borderColor: colors.border, backgroundColor: colors.card }]}
        onTouchStart={() => {
          setDrawing(true);
          cancelReveal();
        }}
        onTouchEnd={() => setDrawing(false)}
        onTouchCancel={() => setDrawing(false)}
      >
        {!sig || savedPick ? (
          <Text style={[Type.callout, styles.padHint, { color: colors.faint }]} pointerEvents="none">
            Sign here
          </Text>
        ) : null}
        <View style={[styles.baseline, { backgroundColor: colors.ring }]} pointerEvents="none" />
        <WebView
          key={html}
          ref={webRef}
          source={{ html }}
          style={styles.padWeb}
          containerStyle={styles.padWeb}
          scrollEnabled={false}
          bounces={false}
          onMessage={onPadMessage}
          originWhitelist={['*']}
          accessibilityLabel="Signature pad"
        />
      </View>

      {/* 3. Page, and where on it — right under the signature, so the page
          is in view as soon as there is something to place: the signature
          is placed by hand on the page itself, exactly where it will be
          drawn into it. */}
      <View onLayout={onPlacementLayout} collapsable={false}>
      {multiPage ? (
        <>
          <SectionLabel>{everyPage ? 'Every page' : `Page ${pageIndex + 1} of ${doc.pages.length}`}</SectionLabel>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pages}>
            {doc.pages.map((p, i) => {
              const on = i === pageIndex;
              return (
                <Pressable
                  key={`${p}-${i}`}
                  onPress={() => setPageIndex(i)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`Page ${i + 1}`}
                  style={[styles.pageThumb, { borderColor: on ? colors.accent : colors.bg }]}
                >
                  {/* Fits a landscape page whole instead of cropping it to its middle. */}
                  <PageThumb
                    uri={`${p}?v=${doc.updatedAt}`}
                    style={[styles.pageImg, { backgroundColor: colors.placeholder, borderColor: colors.thumbBorder }]}
                  />
                  <Text style={[Type.caption, styles.pageNum, { color: on ? colors.accent : colors.muted }]}>
                    {i + 1}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </>
      ) : (
        <SectionLabel>Placement</SectionLabel>
      )}

      {doc && pageUri && sig && place ? (
        <SignaturePlacer
          // A new page starts from the placement as fractions, not from an
          // in-flight gesture on the old one.
          key={`${pageIndex}`}
          uri={`${pageUri}?v=${doc.updatedAt}`}
          width={previewW}
          height={previewH}
          signature={sig}
          tint={ink === 'black' ? null : SIGNATURE_INK[ink]}
          placement={place}
          onChange={p => setPlacement(clampPlacement(sig, p, aspect))}
          onInteracting={setPlacing}
        />
      ) : (
        <PagePreview uri={doc && pageUri ? `${pageUri}?v=${doc.updatedAt}` : null} aspect={aspect} width={previewW} />
      )}
      <ToolNote>
        {!doc
          ? 'Choose a document to place the signature on.'
          : sig
            ? 'Drag the signature to move it. Drag a corner or pinch to resize it.'
            : 'Draw or choose a signature, then place it on the page.'}
      </ToolNote>
      </View>

      {/* 4. Ink */}
      <SectionLabel>Ink</SectionLabel>
      <ColorSwatches options={INKS} value={ink} onChange={setInk} />

      {multiPage ? (
        <View style={[styles.switchRow, { backgroundColor: colors.card }]}>
          <Text style={[Type.body, styles.flex, { color: colors.text }]}>Sign every page</Text>
          <AppSwitch value={everyPage} onValueChange={setEveryPage} accessibilityLabel="Sign every page" />
        </View>
      ) : null}
      <ToolNote>The signature becomes part of the page, and you can undo it right after. To keep this document as it is, save a signed copy instead.</ToolNote>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: {
    height: PAD_HEIGHT,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  padWeb: { flex: 1, backgroundColor: 'transparent' },
  baseline: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 44,
    height: StyleSheet.hairlineWidth,
  },
  padHint: { position: 'absolute', left: 24, bottom: 52 },
  pages: { gap: Spacing.sm, paddingBottom: Spacing.md },
  pageThumb: { borderWidth: 2, borderRadius: Radius.sm, padding: 2, alignItems: 'center' },
  pageImg: { width: 48, height: 64, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth },
  pageNum: { marginTop: 2, fontWeight: '600' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.lg,
    minHeight: HIT + 8,
    marginBottom: Spacing.lg,
  },
  savedRow: { flexDirection: 'row', gap: Spacing.sm },
  savedTile: {
    flex: 1,
    maxWidth: '50%',
    height: 72,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.sm,
    justifyContent: 'center',
  },
  savedTileOn: { borderWidth: 2, padding: Spacing.sm - 1.5 },
  savedImg: { width: '100%', height: '100%' },
  savedCheck: {
    position: 'absolute',
    top: Spacing.xs + 2,
    right: Spacing.xs + 2,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orDraw: { marginTop: Spacing.sm, marginBottom: Spacing.sm, paddingHorizontal: Spacing.xs },
});

/**
 * The text lines on a page, as page fractions, so a new signature can start
 * clear of them. Read on device (lib/ocr, usually from the OCR cache: the text
 * index has already read every page). Empty until known, and when OCR is
 * unavailable or fails.
 */
function usePageText(pageUri: string | null): PageRect[] {
  const [rects, setRects] = useState<PageRect[]>([]);
  useEffect(() => {
    setRects([]);
    if (!pageUri) return;
    let live = true;
    Promise.all([recognizeLines(pageUri), getImageSize(pageUri)])
      .then(([ocr, size]) => {
        if (!live || !size) return;
        const out: PageRect[] = [];
        for (const line of ocr.lines) {
          const r = lineToPageRect(line, size.width, size.height);
          if (r) out.push(r);
        }
        setRects(out);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pageUri]);
  return rects;
}

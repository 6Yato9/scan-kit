// app/tools/sign.tsx
// Draw a signature, choose the page (or every page) and where it goes, then
// sign the document itself: the signature is drawn into the page (and its
// unfiltered shadow), so the pages stay searchable and re-filterable, and the
// viewer offers Undo (lib/page-stamp.ts). "Save as a copy" signs a duplicate.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { AppSwitch } from '@/components/app-switch';
import {
  FooterActions,
  NoDocumentsScreen,
  PagePreview,
  Segmented,
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
import { copyName, stampCopy, stampPages, targetPages } from '@/lib/page-stamp';
import { notifySuccess, tapLight } from '@/lib/haptics';
import {
  clampPlacement,
  defaultPlacement,
  signatureHeightFraction,
  type Placement,
  type Signature,
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
const SIZES = [
  { value: 's', label: 'Small', w: 0.22 },
  { value: 'm', label: 'Medium', w: 0.32 },
  { value: 'l', label: 'Large', w: 0.44 },
] as const;
type SizeKey = (typeof SIZES)[number]['value'];

// Ink is drawn at device resolution in the theme's text colour on a
// transparent canvas, so the pad matches light and dark mode. Capture is
// implicit: a moment after each stroke the canvas is trimmed to the strokes
// (plus a small margin), recoloured to the document ink and posted back as a
// PNG, so there is no "Use signature" step.
function padHtml(ink: string, docInk: string): string {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{background:transparent;overflow:hidden;height:100%}
canvas{display:block;touch-action:none}</style></head><body><canvas id="c"></canvas>
<script>
var canvas = document.getElementById('c');
var ctx = canvas.getContext('2d');
var dpr = window.devicePixelRatio || 1;
var W = window.innerWidth, H = ${PAD_HEIGHT};
canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
ctx.scale(dpr, dpr);
ctx.strokeStyle = '${ink}'; ctx.fillStyle = '${ink}'; ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
var drawing = false, drawn = false, last = null, timer = null;
function pt(e){ var t = e.touches[0], r = canvas.getBoundingClientRect(); return { x: t.clientX - r.left, y: t.clientY - r.top }; }
canvas.addEventListener('touchstart', function(e){ e.preventDefault(); clearTimeout(timer); drawing = true; last = pt(e);
  ctx.beginPath(); ctx.arc(last.x, last.y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); drawn = true; }, { passive: false });
canvas.addEventListener('touchmove', function(e){ e.preventDefault(); if (!drawing) return; var p = pt(e);
  ctx.beginPath(); ctx.moveTo(last.x, last.y); var mx = (last.x + p.x) / 2, my = (last.y + p.y) / 2;
  ctx.quadraticCurveTo(last.x, last.y, mx, my); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; }, { passive: false });
canvas.addEventListener('touchend', function(){ drawing = false; clearTimeout(timer); timer = setTimeout(exportSignature, 250); });
function post(m){ window.ReactNativeWebView.postMessage(m); }
function exportSignature(){
  if (!drawn) { post('EMPTY'); return; }
  var w = canvas.width, h = canvas.height, d = ctx.getImageData(0, 0, w, h).data;
  var minX = w, minY = h, maxX = -1, maxY = -1;
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (maxX < 0) { post('EMPTY'); return; }
  var m = Math.round(4 * dpr);
  minX = Math.max(0, minX - m); minY = Math.max(0, minY - m); maxX = Math.min(w - 1, maxX + m); maxY = Math.min(h - 1, maxY + m);
  var out = document.createElement('canvas'); out.width = maxX - minX + 1; out.height = maxY - minY + 1;
  var o = out.getContext('2d');
  o.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  // Whatever colour the pad shows, the page gets dark ink.
  o.globalCompositeOperation = 'source-in'; o.fillStyle = '${docInk}'; o.fillRect(0, 0, out.width, out.height);
  post(JSON.stringify({ dataUri: out.toDataURL('image/png'), width: out.width, height: out.height }));
}
function clearPad(){ clearTimeout(timer); ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,canvas.width,canvas.height); ctx.restore(); drawn = false; }
</script></body></html>`;
}

export default function SignScreen() {
  const { colors } = useTheme();
  const { width: screenW } = useWindowDimensions();
  const webRef = useRef<WebView>(null);
  const { docs, loaded, reload } = useToolDocuments();
  // Imported PDFs: listed in the picker with Convert, never a dead end.
  const { pdfs, loaded: pdfsLoaded, reload: reloadPdfs } = useConvertiblePdfs();
  const [sig, setSig] = useState<Signature | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [everyPage, setEveryPage] = useState(false);
  const [size, setSize] = useState<SizeKey>('m');
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  const { doc, docId, setDocId, fixed, fromViewer } = useToolDoc(docs);
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
  // Opened on a document: start on its last page, like picking it would.
  const startedOn = useRef<string | null>(null);
  useEffect(() => {
    if (fixed && doc && startedOn.current !== doc.id) {
      startedOn.current = doc.id;
      setPageIndex(doc.pages.length - 1);
    }
  }, [fixed, doc]);
  const pageUri = doc ? doc.pages[Math.min(pageIndex, doc.pages.length - 1)] : null;
  const aspect = useImageAspect(pageUri);
  const sizeW = SIZES.find(s => s.value === size)!.w;
  const place = sig ? clampPlacement(sig, placement ?? defaultPlacement(sig, aspect, sizeW), aspect) : null;

  // The pad draws in the theme's text colour; a theme change reloads it empty.
  const html = useMemo(() => padHtml(colors.text, Ink.signature), [colors.text]);
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
    } catch {
      Alert.alert('Couldn’t capture the signature', 'Clear the box and try again.');
    }
  };

  const clearSignature = () => {
    webRef.current?.injectJavaScript('clearPad(); true;');
    setSig(null);
    setSavedPick(null);
    setPlacement(null);
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

  const changeSize = (s: SizeKey) => {
    setSize(s);
    const w = SIZES.find(x => x.value === s)!.w;
    if (sig && place) {
      // Grow/shrink around the current centre.
      const cx = place.x + place.w / 2;
      const cy = place.y + signatureHeightFraction(sig, place, aspect) / 2;
      const next = { w, x: cx - w / 2, y: cy - signatureHeightFraction(sig, { x: 0, y: 0, w }, aspect) / 2 };
      setPlacement(clampPlacement(sig, next, aspect));
    }
  };

  const moveTo = ({ x, y }: { x: number; y: number }) => {
    if (!sig || !place) return;
    const h = signatureHeightFraction(sig, place, aspect);
    setPlacement(clampPlacement(sig, { w: place.w, x: x - place.w / 2, y: y - h / 2 }, aspect));
    tapLight();
  };

  const pages = doc ? targetPages(doc.pages.length, pageIndex, everyPage) : [];
  const pagesLabel = !doc ? '' : pages.length > 1 ? `all ${pages.length} pages` : doc.pages.length > 1 ? `page ${pages[0] + 1}` : 'the page';

  /** Signs the document itself (Undo in the viewer), or a copy of it. */
  const apply = async (mode: 'in-place' | 'copy') => {
    if (!doc || !sig || !place || progress) return;
    const spec = { kind: 'signature' as const, signature: sig, placement: place };
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

  // Picking an imported PDF converts it to pages (with Undo), then chooses it.
  const convert: PickerConvert = {
    pdfs,
    verb: 'sign',
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

  // Same preview size and place as Watermark and Timestamp.
  const previewW = Math.min(screenW * 0.5, 220);
  // Always names the outcome ("Sign page 3"); it stays dimmed until there is
  // a signature, and the pad's "Sign here" says what to do. An instruction on a
  // disabled button ("Choose or draw a signature") read as a broken control.
  const buttonTitle = doc ? `Sign ${pagesLabel}` : 'Sign';

  return (
    <ToolScreen
      title="Sign"
      busy={!!progress}
      scrollEnabled={!drawing}
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

      {/* 2. Live preview, always shown like Watermark's and Timestamp's: the
          chosen page (a sample page until a document is chosen) with the
          signature where the PDF will get it. Tap it to place the signature. */}
      {doc && doc.pages.length > 1 ? (
        <>
          <SectionLabel>{everyPage ? 'Pages, every page' : `Page ${pageIndex + 1}`}</SectionLabel>
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
          <View style={[styles.switchRow, { backgroundColor: colors.card }]}>
            <Text style={[Type.body, styles.flex, { color: colors.text }]}>Sign every page</Text>
            <AppSwitch value={everyPage} onValueChange={setEveryPage} accessibilityLabel="Sign every page" />
          </View>
        </>
      ) : null}

      <View style={[styles.previewWrap, !(doc && doc.pages.length > 1) && styles.previewGap]}>
        <PagePreview
          uri={doc && pageUri ? `${pageUri}?v=${doc.updatedAt}` : null}
          aspect={aspect}
          width={previewW}
          onPress={sig ? moveTo : undefined}
        >
          {({ width, height }) =>
            sig && place ? (
              <Image
                source={{ uri: sig.dataUri }}
                style={{
                  position: 'absolute',
                  left: place.x * width,
                  top: place.y * height,
                  width: place.w * width,
                  height: place.w * width * (sig.height / sig.width),
                }}
              />
            ) : null
          }
        </PagePreview>
      </View>
      {sig ? <ToolNote>Tap the page where the signature should go.</ToolNote> : null}

      {/* 3. Signature — captured as you draw; no separate confirm step. */}
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
                    { backgroundColor: colors.paper, borderColor: on ? colors.accent : colors.thumbBorder },
                    on && styles.savedTileOn,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Image source={{ uri: s.uri }} style={styles.savedImg} resizeMode="contain" />
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
        onTouchStart={() => setDrawing(true)}
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

      {sig ? (
        <>
          <SectionLabel>Size</SectionLabel>
          <Segmented options={SIZES.map(s => ({ value: s.value, label: s.label }))} value={size} onChange={changeSize} />
        </>
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
  previewWrap: { alignItems: 'center' },
  previewGap: { marginTop: Spacing.lg },
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

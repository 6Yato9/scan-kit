// app/tools/sign.tsx
// Draw a signature, choose the page (or every page) and where it goes, then
// save a signed copy as a new PDF.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { useToast } from '@/components/toast';
import {
  DocGroup,
  DocRow,
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
import { generatePdf } from '@/lib/pdf';
import { copyPdfToStorage, deleteDocumentFiles } from '@/lib/files';
import { deleteQuietly } from '@/lib/share';
import { getDocSettings, saveDocument } from '@/lib/storage';
import { notifyError, notifySuccess, tapLight } from '@/lib/haptics';
import {
  clampPlacement,
  defaultPlacement,
  signatureHeightFraction,
  signatureOverlay,
  type Placement,
  type Signature,
} from '@/lib/stamp';
import { HIT, Ink, Radius, Spacing, Type } from '@/lib/theme';
import type { Document } from '@/types/document';

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
  const router = useRouter();
  const { colors } = useTheme();
  const { show } = useToast();
  const { width: screenW } = useWindowDimensions();
  const webRef = useRef<WebView>(null);
  const { docs, loaded } = useToolDocuments();
  const [sig, setSig] = useState<Signature | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [docId, setDocId] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [everyPage, setEveryPage] = useState(false);
  const [size, setSize] = useState<SizeKey>('m');
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  const doc = docs.find(d => d.id === docId) ?? null;
  const pageUri = doc ? doc.pages[Math.min(pageIndex, doc.pages.length - 1)] : null;
  const aspect = useImageAspect(pageUri);
  const sizeW = SIZES.find(s => s.value === size)!.w;
  const place = sig ? clampPlacement(sig, placement ?? defaultPlacement(sig, aspect, sizeW), aspect) : null;

  // The pad draws in the theme's text colour; a theme change reloads it empty.
  const html = useMemo(() => padHtml(colors.text, Ink.signature), [colors.text]);
  useEffect(() => {
    setSig(null);
  }, [html]);

  const onPadMessage = (e: { nativeEvent: { data: string } }) => {
    const data = e.nativeEvent.data;
    if (data === 'EMPTY') {
      setSig(null);
      return;
    }
    try {
      const parsed = JSON.parse(data) as Signature;
      if (!parsed.dataUri?.startsWith('data:image/png') || !(parsed.width > 0)) throw new Error('bad');
      // Keep any placement the user already chose; clampPlacement fits the new shape.
      setSig(parsed);
    } catch {
      Alert.alert('Couldn’t capture the signature', 'Clear the box and try again.');
    }
  };

  const clearSignature = () => {
    webRef.current?.injectJavaScript('clearPad(); true;');
    setSig(null);
    setPlacement(null);
    tapLight();
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

  const apply = async () => {
    if (!doc || !sig || !place || progress) return;
    const id = Crypto.randomUUID();
    let temp: string | null = null;
    const target = Math.min(pageIndex, doc.pages.length - 1);
    const overlay = signatureOverlay(sig, place);
    setProgress({ current: 0, total: doc.pages.length });
    try {
      const { pdfPageSize } = await getDocSettings();
      temp = await generatePdf(doc.pages, {
        pageSize: pdfPageSize,
        overlayHtml: i => (everyPage || i === target ? overlay : ''),
        onProgress: done => setProgress({ current: done, total: doc.pages.length }),
      });
      const stored = copyPdfToStorage(temp, id);
      const now = Date.now();
      await saveDocument({
        id,
        name: `${doc.name} (signed)`,
        pages: [],
        pdfUri: stored,
        folder: doc.folder,
        createdAt: now,
        updatedAt: now,
      });
      notifySuccess();
      show('Signed PDF saved');
      router.replace({ pathname: '/viewer', params: { id } });
    } catch {
      try { deleteDocumentFiles(id); } catch {}
      notifyError();
      Alert.alert('Couldn’t sign the document', 'The PDF couldn’t be created. Try again, or try with fewer pages.');
    } finally {
      deleteQuietly(temp);
      setProgress(null);
    }
  };

  if (loaded && docs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Sign"
        subtitle="Sign adds your signature to a scanned document. Scan or import a document first."
      />
    );
  }

  const previewW = Math.min(screenW - Spacing.gutter * 2 - Spacing.sm * 2, 300);
  const buttonTitle = !sig ? 'Sign in the box above' : !doc ? 'Choose a document' : 'Save signed PDF';

  return (
    <ToolScreen
      title="Sign"
      scrollEnabled={!drawing}
      footer={
        <>
          {progress ? (
            <ToolProgress
              label={`Preparing page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…`}
              current={progress.current}
              total={progress.total}
            />
          ) : null}
          <PrimaryButton title={buttonTitle} onPress={apply} disabled={!sig || !doc} loading={!!progress} />
        </>
      }
    >
      {/* 1. Signature — captured as you draw; no separate confirm step. */}
      <SectionRow label="Signature" action={sig ? 'Clear' : undefined} onAction={clearSignature} />
      <View
        style={[styles.pad, { borderColor: colors.border, backgroundColor: colors.card }]}
        onTouchStart={() => setDrawing(true)}
        onTouchEnd={() => setDrawing(false)}
        onTouchCancel={() => setDrawing(false)}
      >
        {!sig ? (
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

      {/* 2. Document */}
      <SectionLabel>Document</SectionLabel>
      <DocGroup>
        {docs.map(d => (
          <DocRow key={d.id} doc={d} selected={d.id === docId} onPress={() => pickDoc(d)} />
        ))}
      </DocGroup>

      {/* 3. Placement */}
      {doc && sig && place && pageUri ? (
        <>
          <SectionLabel>{everyPage ? 'Placement, every page' : `Placement, page ${pageIndex + 1}`}</SectionLabel>
          {doc.pages.length > 1 ? (
            <>
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
                      <Image
                        source={{ uri: `${p}?v=${doc.updatedAt}` }}
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
                <Switch
                  value={everyPage}
                  onValueChange={setEveryPage}
                  trackColor={{ true: colors.accentFill, false: colors.border }}
                  accessibilityLabel="Sign every page"
                />
              </View>
            </>
          ) : null}

          <View style={styles.previewWrap}>
            <PagePreview uri={`${pageUri}?v=${doc.updatedAt}`} aspect={aspect} width={previewW} onPress={moveTo}>
              {({ width, height }) => (
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
              )}
            </PagePreview>
          </View>
          <ToolNote>Tap the page where the signature should go.</ToolNote>

          <SectionLabel>Size</SectionLabel>
          <Segmented options={SIZES.map(s => ({ value: s.value, label: s.label }))} value={size} onChange={changeSize} />
          <ToolNote>A signed copy is saved as a new PDF. The original document is kept.</ToolNote>
        </>
      ) : null}
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
});

// app/annotate.tsx
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { getDocuments, patchDocument } from '@/lib/storage';
import { originalUri } from '@/lib/files';
import { pageFileUri } from '@/lib/image';
import { bakePage, runPageEdit } from '@/lib/bake';
import { HIT, Spacing } from '@/lib/theme';
import { useTheme } from '@/contexts/theme-context';
import { HeaderTextButton, ScreenHeader } from '@/components/screen-header';
import { FilterBaker } from '@/components/filter-baker';
import type { Document, PageAdjustment, PageFilter } from '@/types/document';

// This screen's chrome is always dark (like the viewer): it uses the theme's
// `chrome*` colours, never the light/dark foregrounds. Ink colours are content,
// not UI, so they are fixed.
const PEN_COLORS = [
  { id: 'black', hex: '#000000', label: 'Black' },
  { id: 'red',   hex: '#e53935', label: 'Red' },
  { id: 'blue',  hex: '#1565c0', label: 'Blue' },
  { id: 'green', hex: '#2e7d32', label: 'Green' },
];

const PEN_SIZES = [
  { size: 2, label: 'Fine' },
  { size: 4, label: 'Medium' },
  { size: 8, label: 'Bold' },
];

function buildHtml(imageSrc: string, origSrc: string | null): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#111; overflow:hidden; width:100vw; height:100vh; }
#wrap { position:relative; width:100vw; height:100vh; display:flex; align-items:center; justify-content:center; }
#bg { max-width:100%; max-height:100%; display:block; object-fit:contain; pointer-events:none; user-select:none; }
#c { position:absolute; top:0; left:0; width:100%; height:100%; touch-action:none; cursor:crosshair; }
</style>
</head>
<body>
<div id="wrap">
  <img id="bg" src="${imageSrc}" crossorigin="anonymous" />
  <canvas id="c"></canvas>
</div>
${origSrc ? `<img id="orig" src="${origSrc}" crossorigin="anonymous" style="display:none" />` : ''}
<script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('wrap');
const img = document.getElementById('bg');

function resize() {
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  applyTool();
}

let currentColor = '#000000';
let currentWidth = 4;
let isEraser = false;
let drawing = false;
let history = [];
let dirty = false;
function post(msg) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg); }

function applyTool() {
  if (isEraser) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.lineWidth = 24;
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = currentWidth;
  }
}

function saveHistory() {
  history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  if (history.length > 20) history.shift();
}

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  drawing = true;
  saveHistory();
  if (!dirty) { dirty = true; post('DIRTY'); }
  applyTool();
  const t = e.touches[0];
  const r = canvas.getBoundingClientRect();
  ctx.beginPath();
  ctx.moveTo(t.clientX - r.left, t.clientY - r.top);
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  if (!drawing) return;
  const t = e.touches[0];
  const r = canvas.getBoundingClientRect();
  ctx.lineTo(t.clientX - r.left, t.clientY - r.top);
  ctx.stroke();
}, { passive: false });

canvas.addEventListener('touchend', () => { drawing = false; });

function setColor(hex) {
  currentColor = hex;
  isEraser = false;
  applyTool();
}

function setWidth(w) {
  currentWidth = w;
  if (!isEraser) applyTool();
}

function setEraser() {
  isEraser = true;
  applyTool();
}

function undo() {
  if (history.length === 0) return;
  ctx.putImageData(history.pop(), 0, 0);
}

function clearAll() {
  saveHistory();
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  applyTool();
}

function getResult() {
  try {
    const bg = document.getElementById('bg');
    const natW = bg.naturalWidth || canvas.width;
    const natH = bg.naturalHeight || canvas.height;

    // How the image was displayed (object-fit contain inside wrap).
    const wrapW = wrap.clientWidth;
    const wrapH = wrap.clientHeight;
    const scale = Math.min(wrapW / natW, wrapH / natH);
    const dispW = natW * scale;
    const dispH = natH * scale;
    const offX = (wrapW - dispW) / 2;
    const offY = (wrapH - dispH) / 2;

    // The ink alone, mapped to the page's natural pixels.
    const ink = document.createElement('canvas');
    ink.width = natW;
    ink.height = natH;
    const ictx = ink.getContext('2d');
    ictx.translate(-offX / scale, -offY / scale);
    ictx.scale(1 / scale, 1 / scale);
    ictx.drawImage(canvas, 0, 0);

    function compose(base, w, h) {
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const octx = out.getContext('2d');
      octx.drawImage(base, 0, 0, w, h);
      octx.drawImage(ink, 0, 0, w, h);
      return out.toDataURL('image/jpeg', 0.92);
    }

    // The same ink goes onto the unfiltered .orig shadow, which every later
    // filter change re-derives from — otherwise the next filter erases it.
    const orig = document.getElementById('orig');
    const result = { page: compose(bg, natW, natH), orig: null };
    if (orig && orig.naturalWidth) result.orig = compose(orig, orig.naturalWidth, orig.naturalHeight);
    post('RESULT:' + JSON.stringify(result));
  } catch (e) {
    post('ERROR:' + (e && e.message ? e.message : 'unknown'));
  }
}

window.addEventListener('resize', resize);
img.onload = resize;
if (img.complete) resize();
</script>
</body>
</html>`;
}

type Tool = 'pen' | 'eraser';

export default function AnnotateScreen() {
  const { docId, pageIndex: pageIndexStr } = useLocalSearchParams<{ docId: string; pageIndex: string }>();
  const pageIndex = parseInt(pageIndexStr ?? '0', 10);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const webRef = useRef<WebView>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [penColor, setPenColor] = useState(PEN_COLORS[0].hex);
  const [penSize, setPenSize] = useState(4);
  const [tool, setTool] = useState<Tool>('pen');
  // The page's filter/adjustment when the screen opened. If a bake changes them
  // while the user draws, the page pixels we composite onto are stale and the
  // page is re-baked from the (now inked) .orig after saving.
  const loadedLook = useRef<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const docs = await getDocuments();
      const found = docs.find(d => d.id === docId);
      if (cancelled) return;
      // Defend against bad routing: doc deleted, PDF-only doc, or pageIndex
      // out of range. Bail back rather than crashing on `pages[NaN]`.
      if (!found || found.pdfUri || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= found.pages.length) {
        router.back();
        return;
      }
      loadedLook.current = lookOf(found, pageIndex);
      const uri = pageFileUri(found.id, pageIndex);
      const orig = new File(originalUri(found.id, pageIndex));
      // Load the page directly via file:// rather than a base64 data URL — saves
      // megabytes of JS string + WebView heap on large scans. The query defeats
      // WebKit's image cache after an in-place edit such as a rotate.
      const bust = `?t=${found.updatedAt}`;
      setHtml(buildHtml(uri + bust, orig.exists ? orig.uri + bust : null));
    })();
    return () => { cancelled = true; };
  }, [docId, pageIndex, router]);

  const save = async (payload: { page: string; orig: string | null }) => {
    const strip = (d: string) => d.replace(/^data:image\/jpeg;base64,/, '');
    let rebake: { filter: PageFilter; adjustment: PageAdjustment | undefined } | null = null;
    await runPageEdit(docId, { pages: [pageIndex] }, async () => {
      const docs = await getDocuments();
      const current = docs.find(d => d.id === docId);
      if (!current || pageIndex >= current.pages.length) throw new Error('page missing');
      await FileSystem.writeAsStringAsync(pageFileUri(docId, pageIndex), strip(payload.page), { encoding: 'base64' });
      const orig = new File(originalUri(docId, pageIndex));
      if (payload.orig && orig.exists) {
        await FileSystem.writeAsStringAsync(orig.uri, strip(payload.orig), { encoding: 'base64' });
      }
      // Touch updatedAt so the viewer's images reload. patchDocument merges onto
      // the stored record, so a filter recorded meanwhile isn't overwritten.
      await patchDocument(docId, { updatedAt: Date.now() });
      if (payload.orig && lookOf(current, pageIndex) !== loadedLook.current) {
        rebake = {
          filter: current.filters?.[pageIndex] ?? 'original',
          adjustment: current.adjustments?.[pageIndex],
        };
      }
    });
    if (rebake) {
      const { filter, adjustment } = rebake;
      bakePage(docId, pageIndex, filter, adjustment).catch(err => console.error('Re-bake after annotate failed', err));
    }
  };

  const handleMessage = async (event: { nativeEvent: { data: string } }) => {
    const data = event.nativeEvent.data;
    if (data === 'DIRTY') {
      setDirty(true);
      return;
    }
    if (data.startsWith('ERROR:')) {
      setSaving(false);
      Alert.alert("Couldn't save your markup", 'Try again.');
      return;
    }
    if (!data.startsWith('RESULT:')) return;
    try {
      const payload = JSON.parse(data.slice('RESULT:'.length)) as { page: string; orig: string | null };
      await save(payload);
      router.back();
    } catch (err) {
      console.error('Annotate save failed', err);
      Alert.alert("Couldn't save your markup", 'There may not be enough free space. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const inject = (js: string) => {
    if (!webRef.current || !html) return;
    webRef.current.injectJavaScript(`${js}; true;`);
  };

  const ready = html !== null;


  const handleDone = () => {
    if (!ready || saving) return;
    if (!dirty) {
      router.back();
      return;
    }
    setSaving(true);
    inject('getResult()');
  };

  const handleCancel = () => {
    if (!dirty) {
      router.back();
      return;
    }
    Alert.alert('Discard your markup?', 'The changes you drew on this page will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => router.back() },
    ]);
  };

  const selectColor = (hex: string) => {
    if (!ready) return;
    setPenColor(hex);
    setTool('pen');
    inject(`setColor('${hex}')`);
  };

  const selectSize = (size: number) => {
    if (!ready) return;
    setPenSize(size);
    if (tool === 'eraser') {
      setTool('pen');
      inject(`setColor('${penColor}')`);
    }
    inject(`setWidth(${size})`);
  };

  const selectTool = (next: Tool) => {
    if (!ready) return;
    setTool(next);
    inject(next === 'eraser' ? 'setEraser()' : `setColor('${penColor}')`);
  };

  const toolButton = (
    icon: React.ComponentProps<typeof Ionicons>['name'],
    label: string,
    onPress: () => void,
    active = false,
  ) => (
    <Pressable
      key={label}
      onPress={onPress}
      disabled={!ready}
      style={({ pressed }) => [styles.toolBtn, pressed && { opacity: 0.6 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled: !ready }}
    >
      <View style={[styles.toolIcon, { backgroundColor: active ? colors.chromeBorder : 'transparent' }]}>
        <Ionicons name={icon} size={22} color={active ? colors.chromeAccent : colors.chromeText} />
      </View>
      <Text allowFontScaling={false} style={[styles.toolLabel, { color: active ? colors.chromeAccent : colors.chromeMuted }]}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.chrome }]}>
      <StatusBar style="light" />
      {/* This screen covers the viewer, whose baker can't run while buried. */}
      <FilterBaker />
      <ScreenHeader
        dark
        title="Annotate"
        left={<HeaderTextButton title="Cancel" color={colors.chromeText} onPress={handleCancel} />}
        right={
          saving ? (
            <ActivityIndicator color={colors.chromeAccent} style={styles.busy} />
          ) : (
            <HeaderTextButton
              title="Done"
              emphasis
              color={colors.chromeAccent}
              disabled={!ready}
              onPress={handleDone}
            />
          )
        }
      />

      {/* Canvas */}
      <View style={styles.canvasArea}>
        {html ? (
          <WebView
            ref={webRef}
            source={{ html, baseUrl: 'file:///' }}
            style={[styles.webview, { backgroundColor: colors.chrome }]}
            scrollEnabled={false}
            onMessage={handleMessage}
            originWhitelist={['*']}
            allowFileAccess
            allowFileAccessFromFileURLs
            allowUniversalAccessFromFileURLs
          />
        ) : (
          <ActivityIndicator color={colors.chromeText} style={{ flex: 1 }} />
        )}
      </View>

      {/* Toolbar */}
      <View style={[styles.toolbar, { paddingBottom: insets.bottom + Spacing.sm, backgroundColor: colors.chromeRaised, borderTopColor: colors.chromeBorder }]}>
        <View style={styles.optionsRow}>
          <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel="Pen color">
            {PEN_COLORS.map(c => {
              const active = tool === 'pen' && penColor === c.hex;
              return (
                <Pressable
                  key={c.id}
                  onPress={() => selectColor(c.hex)}
                  style={styles.swatchHit}
                  accessibilityRole="radio"
                  accessibilityLabel={c.label}
                  accessibilityState={{ selected: active }}
                >
                  <View style={[styles.swatchRing, { borderColor: active ? colors.chromeText : 'transparent' }]}>
                    <View style={[styles.swatch, { backgroundColor: c.hex, borderColor: colors.chromeMuted }]} />
                  </View>
                </Pressable>
              );
            })}
          </View>
          <View style={[styles.divider, { backgroundColor: colors.chromeBorder }]} />
          <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel="Pen size">
            {PEN_SIZES.map(({ size, label }) => {
              const active = penSize === size;
              return (
                <Pressable
                  key={size}
                  onPress={() => selectSize(size)}
                  style={[styles.sizeHit, active && { backgroundColor: colors.chromeBorder }]}
                  accessibilityRole="radio"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: active }}
                >
                  <View
                    style={{
                      width: size * 2 + 2,
                      height: size * 2 + 2,
                      borderRadius: size + 1,
                      backgroundColor: tool === 'eraser' ? colors.chromeMuted : penColor,
                      borderWidth: 1,
                      borderColor: colors.chromeMuted,
                    }}
                  />
                </Pressable>
              );
            })}
          </View>
        </View>
        <View style={styles.toolsRow}>
          {toolButton('pencil-outline', 'Pen', () => selectTool('pen'), tool === 'pen')}
          {toolButton('backspace-outline', 'Eraser', () => selectTool('eraser'), tool === 'eraser')}
          {toolButton('arrow-undo-outline', 'Undo', () => inject('undo()'))}
          {toolButton('trash-outline', 'Clear', () => inject('clearAll()'))}
        </View>
      </View>
    </View>
  );
}

/** A comparable snapshot of a page's recorded filter + adjustment. */
function lookOf(doc: Document, pageIndex: number): string {
  return JSON.stringify([doc.filters?.[pageIndex] ?? 'original', doc.adjustments?.[pageIndex] ?? null]);
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  busy: { minWidth: 60 },
  canvasArea: { flex: 1 },
  webview: { flex: 1 },
  toolbar: {
    paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  optionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.sm,
  },
  group: { flexDirection: 'row', alignItems: 'center' },
  divider: { width: StyleSheet.hairlineWidth, height: 28, marginHorizontal: Spacing.sm },
  swatchHit: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  swatchRing: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 1 },
  sizeHit: { width: HIT, height: HIT, borderRadius: HIT / 2, alignItems: 'center', justifyContent: 'center' },
  toolsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xs,
  },
  toolBtn: { minWidth: 64, minHeight: HIT, alignItems: 'center', justifyContent: 'center', gap: 2 },
  toolIcon: { width: 40, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  toolLabel: { fontSize: 11, fontWeight: '500' },
});

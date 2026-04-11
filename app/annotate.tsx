// app/annotate.tsx
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as FileSystem from 'expo-file-system';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { getDocuments, updateDocument } from '@/lib/storage';
import type { Document } from '@/types/document';

const COLORS = [
  { id: 'black', hex: '#000000', label: 'Black' },
  { id: 'red',   hex: '#e53935', label: 'Red' },
  { id: 'blue',  hex: '#1565c0', label: 'Blue' },
  { id: 'green', hex: '#2e7d32', label: 'Green' },
];

function buildHtml(b64: string): string {
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
  <img id="bg" src="data:image/jpeg;base64,${b64}" />
  <canvas id="c"></canvas>
</div>
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
let currentWidth = 3;
let isEraser = false;
let drawing = false;
let history = [];

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

function getResult() {
  const bg = document.getElementById('bg');
  const natW = bg.naturalWidth || canvas.width;
  const natH = bg.naturalHeight || canvas.height;

  // Calculate how the image was displayed (object-fit contain inside wrap)
  const wrapW = wrap.clientWidth;
  const wrapH = wrap.clientHeight;
  const scale = Math.min(wrapW / natW, wrapH / natH);
  const dispW = natW * scale;
  const dispH = natH * scale;
  const offX = (wrapW - dispW) / 2;
  const offY = (wrapH - dispH) / 2;

  const out = document.createElement('canvas');
  out.width = natW;
  out.height = natH;
  const octx = out.getContext('2d');

  // Draw original image
  octx.drawImage(bg, 0, 0, natW, natH);

  // Draw annotation canvas mapped to natural image coordinates
  octx.save();
  octx.translate(-offX / scale, -offY / scale);
  octx.scale(1 / scale, 1 / scale);
  octx.drawImage(canvas, 0, 0);
  octx.restore();

  window.ReactNativeWebView.postMessage(out.toDataURL('image/jpeg', 0.92));
}

window.addEventListener('resize', resize);
img.onload = resize;
if (img.complete) resize();
</script>
</body>
</html>`;
}

export default function AnnotateScreen() {
  const { docId, pageIndex: pageIndexStr } = useLocalSearchParams<{ docId: string; pageIndex: string }>();
  const pageIndex = parseInt(pageIndexStr ?? '0', 10);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const webRef = useRef<WebView>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [saving, setSaving] = useState(false);
  const [penColor, setPenColor] = useState('#000000');
  const [penSize, setPenSize] = useState(3);
  const [eraser, setEraser] = useState(false);

  useEffect(() => {
    (async () => {
      const docs = await getDocuments();
      const found = docs.find(d => d.id === docId);
      if (!found) return;
      setDoc(found);
      const uri = found.pages[pageIndex];
      const b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
      setHtml(buildHtml(b64));
    })();
  }, [docId, pageIndex]);

  const handleMessage = async (event: { nativeEvent: { data: string } }) => {
    const dataUrl = event.nativeEvent.data;
    if (!doc || !dataUrl.startsWith('data:image')) return;
    setSaving(true);
    try {
      const b64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
      const pageUri = doc.pages[pageIndex];
      await FileSystem.writeAsStringAsync(pageUri, b64, { encoding: 'base64' });
      // Touch updatedAt so viewer reloads
      await updateDocument({ ...doc, updatedAt: Date.now() });
      router.back();
    } catch {
      Alert.alert('Error', 'Could not save annotation.');
    } finally {
      setSaving(false);
    }
  };

  const inject = (js: string) => webRef.current?.injectJavaScript(`${js}; true;`);

  const selectColor = (hex: string) => {
    setPenColor(hex);
    setEraser(false);
    inject(`setColor('${hex}')`);
  };

  const selectSize = (size: number) => {
    setPenSize(size);
    inject(`setWidth(${size})`);
  };

  const toggleEraser = () => {
    const next = !eraser;
    setEraser(next);
    if (next) {
      inject('setEraser()');
    } else {
      inject(`setColor('${penColor}')`);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: '#111' }]}>
      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.topBtn}>Cancel</Text>
        </Pressable>
        <Text style={styles.topTitle}>Annotate</Text>
        <Pressable
          onPress={() => inject('getResult()')}
          disabled={saving}
          hitSlop={12}
        >
          {saving
            ? <ActivityIndicator color="#fff" />
            : <Text style={[styles.topBtn, { color: colors.accent }]}>Done</Text>
          }
        </Pressable>
      </View>

      {/* Canvas */}
      <View style={styles.canvasArea}>
        {html ? (
          <WebView
            ref={webRef}
            source={{ html }}
            style={styles.webview}
            scrollEnabled={false}
            onMessage={handleMessage}
            originWhitelist={['*']}
          />
        ) : (
          <ActivityIndicator color="#fff" style={{ flex: 1 }} />
        )}
      </View>

      {/* Bottom toolbar */}
      <View style={[styles.toolbar, { paddingBottom: insets.bottom + 8 }]}>
        {/* Color swatches */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.toolRow}>
          {COLORS.map(c => (
            <Pressable
              key={c.id}
              style={[
                styles.swatch,
                { backgroundColor: c.hex },
                !eraser && penColor === c.hex && styles.swatchActive,
              ]}
              onPress={() => selectColor(c.hex)}
            />
          ))}

          {/* Eraser */}
          <Pressable
            style={[styles.eraserBtn, eraser && { borderColor: colors.accent }]}
            onPress={toggleEraser}
          >
            <Text style={styles.eraserText}>⌫</Text>
          </Pressable>

          {/* Undo */}
          <Pressable
            style={styles.eraserBtn}
            onPress={() => inject('undo()')}
          >
            <Text style={styles.eraserText}>↩</Text>
          </Pressable>

          {/* Pen sizes */}
          {[2, 4, 8].map(size => (
            <Pressable
              key={size}
              style={[styles.sizeBtn, penSize === size && { borderColor: colors.accent }]}
              onPress={() => selectSize(size)}
            >
              <View style={[styles.sizeDot, { width: size * 2, height: size * 2, borderRadius: size, backgroundColor: eraser ? '#aaa' : penColor }]} />
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  topBtn: { fontSize: 15, color: '#ccc', fontWeight: '500' },
  topTitle: { fontSize: 16, fontWeight: '700', color: '#fff' },
  canvasArea: { flex: 1 },
  webview: { flex: 1, backgroundColor: '#111' },
  toolbar: {
    backgroundColor: '#1a1a1a',
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#333',
  },
  toolRow: {
    paddingHorizontal: 12,
    gap: 10,
    alignItems: 'center',
  },
  swatch: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  swatchActive: {
    borderColor: '#fff',
    transform: [{ scale: 1.15 }],
  },
  eraserBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  eraserText: { fontSize: 16, color: '#ccc' },
  sizeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  sizeDot: {},
});

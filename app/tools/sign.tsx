// app/tools/sign.tsx
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
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import * as Print from 'expo-print';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { getDocuments, saveDocument } from '@/lib/storage';
import { copyPdfToStorage } from '@/lib/files';
import { filterCss } from '@/lib/filters';
import type { Document, PageFilter } from '@/types/document';

const SIGNATURE_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #fff; overflow: hidden; }
  canvas { display: block; touch-action: none; cursor: crosshair; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
canvas.width = window.innerWidth;
canvas.height = 180;
ctx.strokeStyle = '#000';
ctx.lineWidth = 2.5;
ctx.lineCap = 'round';
ctx.lineJoin = 'round';
let drawing = false, hasDrawn = false;
canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  drawing = true;
  hasDrawn = true;
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
function getDataUrl() {
  if (!hasDrawn) { window.ReactNativeWebView.postMessage('empty'); return; }
  window.ReactNativeWebView.postMessage(canvas.toDataURL('image/png'));
}
function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  hasDrawn = false;
}
</script>
</body>
</html>
`;

export default function SignScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const webRef = useRef<WebView>(null);
  const [docs, setDocs] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [signatureData, setSignatureData] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    getDocuments().then(all => setDocs(all.filter(d => d.pages.length > 0))).catch(console.error);
  }, []);

  const handleWebMessage = (event: { nativeEvent: { data: string } }) => {
    const data = event.nativeEvent.data;
    if (data === 'empty') {
      Alert.alert('Empty signature', 'Please draw your signature first.');
      return;
    }
    setSignatureData(data);
  };

  const captureSignature = () => {
    webRef.current?.injectJavaScript('getDataUrl(); true;');
  };

  const clearSignature = () => {
    webRef.current?.injectJavaScript('clearCanvas(); true;');
    setSignatureData(null);
  };

  const handleApply = async () => {
    if (!selectedDoc || !signatureData) return;
    setApplying(true);
    try {
      const imgTags = await Promise.all(
        selectedDoc.pages.map(async (uri, i) => {
          const css = filterCss(selectedDoc.filters?.[i] as PageFilter | undefined);
          const filterAttr = css !== 'none' ? `filter:${css};` : '';
          const b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
          const overlay = `<div style="position:absolute;bottom:20px;right:20px;"><img src="${signatureData}" style="height:60px;opacity:0.85;" /></div>`;
          return `<div style="position:relative;page-break-after:always;margin:0;padding:0;"><img src="data:image/jpeg;base64,${b64}" style="width:100%;display:block;${filterAttr}" />${overlay}</div>`;
        })
      );

      const html = `<html><body style="margin:0;padding:0;">${imgTags.join('')}</body></html>`;
      const { uri: pdfUri } = await Print.printToFileAsync({ html });

      const id = Crypto.randomUUID();
      const now = Date.now();
      const stored = copyPdfToStorage(pdfUri, id);
      await saveDocument({
        id,
        name: `${selectedDoc.name} (Signed)`,
        pages: [],
        pdfUri: stored,
        createdAt: now,
        updatedAt: now,
      });

      Alert.alert('Done', 'Signed PDF saved to your documents.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch {
      Alert.alert('Error', 'Could not apply signature.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Sign</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {/* Signature pad */}
        <Text style={[styles.sectionLabel, { color: colors.muted }]}>DRAW SIGNATURE</Text>
        <View style={[styles.padWrapper, { borderColor: colors.border, backgroundColor: '#fff' }]}>
          {!signatureData ? (
            <WebView
              ref={webRef}
              source={{ html: SIGNATURE_HTML }}
              style={styles.webview}
              scrollEnabled={false}
              onMessage={handleWebMessage}
              originWhitelist={['*']}
            />
          ) : (
            <View style={[styles.signaturePreview, { backgroundColor: '#fff' }]}>
              <Text style={[styles.signatureDone, { color: colors.accent }]}>✓ Signature captured</Text>
            </View>
          )}
        </View>

        <View style={styles.padActions}>
          {!signatureData ? (
            <Pressable style={[styles.padBtn, { backgroundColor: colors.accent }]} onPress={captureSignature}>
              <Text style={styles.padBtnText}>Use This Signature</Text>
            </Pressable>
          ) : (
            <Pressable style={[styles.padBtn, { backgroundColor: colors.secondary }]} onPress={clearSignature}>
              <Text style={[styles.padBtnText, { color: colors.text }]}>Draw Again</Text>
            </Pressable>
          )}
        </View>

        {/* Document list */}
        {signatureData && (
          <>
            <Text style={[styles.sectionLabel, { color: colors.muted, marginTop: 24 }]}>SELECT DOCUMENT TO SIGN</Text>
            {docs.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.muted }]}>No documents found. Scan a document first.</Text>
            ) : (
              docs.map(doc => (
                <Pressable
                  key={doc.id}
                  style={[styles.docRow, { backgroundColor: colors.card, borderColor: selectedDoc?.id === doc.id ? colors.accent : 'transparent' }]}
                  onPress={() => setSelectedDoc(doc)}
                >
                  <Ionicons name="document-text-outline" size={22} color={colors.muted} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.docName, { color: colors.text }]} numberOfLines={1}>{doc.name}</Text>
                    <Text style={[styles.docMeta, { color: colors.muted }]}>{doc.pages.length} page{doc.pages.length !== 1 ? 's' : ''}</Text>
                  </View>
                  {selectedDoc?.id === doc.id && <Ionicons name="checkmark-circle" size={22} color={colors.accent} />}
                </Pressable>
              ))
            )}

            {selectedDoc && (
              <Pressable
                style={[styles.applyBtn, { backgroundColor: colors.accent, opacity: applying ? 0.6 : 1, marginTop: 24 }]}
                onPress={handleApply}
                disabled={applying}
              >
                {applying
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.applyBtnText}>Apply Signature</Text>
                }
              </Pressable>
            )}

            <Text style={[styles.footnote, { color: colors.muted }]}>
              The signature will be placed on the bottom-right of each page. A new signed PDF will be saved. Your original is unchanged.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12 },
  title: { fontSize: 17, fontWeight: '700' },
  content: { paddingHorizontal: 16 },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 },
  padWrapper: { borderRadius: 12, borderWidth: 1, overflow: 'hidden', height: 180 },
  webview: { flex: 1, backgroundColor: 'transparent' },
  signaturePreview: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  signatureDone: { fontSize: 16, fontWeight: '700' },
  padActions: { flexDirection: 'row', marginTop: 10, gap: 10 },
  padBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  padBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  emptyText: { fontSize: 14, fontStyle: 'italic' },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 12, marginBottom: 8, borderWidth: 1.5 },
  docName: { fontSize: 15, fontWeight: '600' },
  docMeta: { fontSize: 12, marginTop: 2 },
  applyBtn: { borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  applyBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  footnote: { fontSize: 12, marginTop: 12, textAlign: 'center', fontStyle: 'italic' },
});

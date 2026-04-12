// app/tools/long-image.tsx
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { getDocuments } from '@/lib/storage';
import type { Document } from '@/types/document';

export default function LongImageScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [docs, setDocs] = useState<Document[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [webviewHtml, setWebviewHtml] = useState<string | null>(null);
  const selectedDocRef = useRef<Document | null>(null);

  useEffect(() => {
    getDocuments()
      .then(all => setDocs(all.filter(d => d.pages.length > 0)))
      .catch(console.error);
  }, []);

  const selectedDoc = docs.find(d => d.id === selected) ?? null;

  const handleGenerate = async () => {
    if (!selectedDoc) return;
    selectedDocRef.current = selectedDoc;
    setProcessing(true);

    try {
      const pagesB64 = await Promise.all(
        selectedDoc.pages.map(uri =>
          FileSystem.readAsStringAsync(uri, { encoding: 'base64' as const }),
        ),
      );

      const html = `<!DOCTYPE html><html><body style="margin:0">
<script>
(async function() {
  const pages = ${JSON.stringify(pagesB64)};
  const imgs = await Promise.all(pages.map(b64 => new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = 'data:image/jpeg;base64,' + b64;
  })));
  const valid = imgs.filter(Boolean);
  if (!valid.length) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ error: 'No images' }));
    return;
  }
  const width = Math.max(...valid.map(i => i.naturalWidth));
  const totalHeight = valid.reduce((sum, i) => sum + Math.round(i.naturalHeight * width / i.naturalWidth), 0);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = totalHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, totalHeight);
  let y = 0;
  for (const img of valid) {
    const h = Math.round(img.naturalHeight * width / img.naturalWidth);
    ctx.drawImage(img, 0, y, width, h);
    y += h;
  }
  const b64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'done', data: b64 }));
})();
</script>
</body></html>`;

      setWebviewHtml(html);
    } catch {
      setProcessing(false);
      Alert.alert('Error', 'Could not read document pages.');
    }
  };

  const handleWebViewMessage = async (event: { nativeEvent: { data: string } }) => {
    setWebviewHtml(null);
    const doc = selectedDocRef.current;

    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.error) {
        Alert.alert('Error', msg.error);
        return;
      }
      if (msg.type === 'done' && msg.data) {
        const safeName = (doc?.name ?? 'document').replace(/[^a-z0-9]/gi, '_');
        const uri = `${FileSystem.cacheDirectory}${safeName}_long.jpg`;
        await FileSystem.writeAsStringAsync(uri, msg.data, { encoding: 'base64' as const });
        await Sharing.shareAsync(uri, {
          mimeType: 'image/jpeg',
          dialogTitle: doc?.name,
          UTI: 'public.jpeg',
        });
      }
    } catch {
      Alert.alert('Error', 'Could not generate long image.');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Header */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>PDF to Long Image</Text>
        <View style={{ width: 32 }} />
      </View>

      {/* Hidden WebView for canvas stitching */}
      {webviewHtml && (
        <WebView
          style={styles.hiddenWebview}
          source={{ html: webviewHtml }}
          onMessage={handleWebViewMessage}
          javaScriptEnabled
          originWhitelist={['*']}
        />
      )}

      {processing ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={[styles.loadingText, { color: colors.muted }]}>Stitching pages…</Text>
        </View>
      ) : (
        <>
          <Text style={[styles.sectionLabel, { color: colors.muted }]}>SELECT DOCUMENT</Text>
          <FlatList
            data={docs}
            keyExtractor={d => d.id}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <Text style={[styles.emptyText, { color: colors.muted }]}>
                No documents found. Scan some documents first.
              </Text>
            }
            renderItem={({ item }) => {
              const isSelected = selected === item.id;
              return (
                <Pressable
                  style={[
                    styles.docRow,
                    {
                      backgroundColor: colors.card,
                      borderColor: isSelected ? colors.accent : 'transparent',
                    },
                  ]}
                  onPress={() => setSelected(isSelected ? null : item.id)}
                >
                  <Image source={{ uri: item.pages[0] }} style={styles.thumb} resizeMode="cover" />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.docName, { color: colors.text }]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={[styles.docMeta, { color: colors.muted }]}>
                      {item.pages.length} page{item.pages.length !== 1 ? 's' : ''}
                    </Text>
                  </View>
                  {isSelected && (
                    <Ionicons name="checkmark-circle" size={22} color={colors.accent} />
                  )}
                </Pressable>
              );
            }}
          />

          {selectedDoc && (
            <View
              style={[
                styles.footer,
                { paddingBottom: insets.bottom + 16, borderTopColor: colors.border },
              ]}
            >
              <Pressable
                style={[styles.generateBtn, { backgroundColor: colors.accent }]}
                onPress={handleGenerate}
              >
                <Text style={styles.generateBtnText}>
                  Generate Long Image · {selectedDoc.pages.length} pages
                </Text>
              </Pressable>
            </View>
          )}
        </>
      )}
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
    paddingBottom: 12,
  },
  title: { fontSize: 17, fontWeight: '700' },
  hiddenWebview: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  loadingText: { fontSize: 16 },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  listContent: { paddingHorizontal: 16, paddingBottom: 16 },
  emptyText: { fontSize: 14, fontStyle: 'italic' },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: 1.5,
  },
  thumb: { width: 44, height: 58, borderRadius: 6, backgroundColor: '#333' },
  docName: { fontSize: 15, fontWeight: '600' },
  docMeta: { fontSize: 12, marginTop: 2 },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  generateBtn: { borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  generateBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});

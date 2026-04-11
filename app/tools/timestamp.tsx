// app/tools/timestamp.tsx
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
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

const FORMATS = [
  { id: 'date', label: 'Date only', example: () => new Date().toLocaleDateString() },
  { id: 'datetime', label: 'Date & time', example: () => `${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}` },
  { id: 'iso', label: 'ISO format', example: () => new Date().toISOString().replace('T', ' ').slice(0, 19) },
];

const POSITIONS = [
  { id: 'bottom-right', label: 'Bottom right', css: 'position:absolute;bottom:16px;right:16px;text-align:right;' },
  { id: 'bottom-left', label: 'Bottom left', css: 'position:absolute;bottom:16px;left:16px;' },
  { id: 'top-right', label: 'Top right', css: 'position:absolute;top:16px;right:16px;text-align:right;' },
];

export default function TimestampScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [docs, setDocs] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [format, setFormat] = useState('datetime');
  const [positionId, setPositionId] = useState('bottom-right');
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    getDocuments().then(all => setDocs(all.filter(d => d.pages.length > 0))).catch(console.error);
  }, []);

  const getTimestamp = () => FORMATS.find(f => f.id === format)!.example();

  const handleApply = async () => {
    if (!selectedDoc) return;
    setApplying(true);
    const ts = getTimestamp();
    try {
      const pos = POSITIONS.find(p => p.id === positionId)!;
      const imgTags = await Promise.all(
        selectedDoc.pages.map(async (uri, i) => {
          const css = filterCss(selectedDoc.filters?.[i] as PageFilter | undefined);
          const filterAttr = css !== 'none' ? `filter:${css};` : '';
          const b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
          const overlay = `<div style="${pos.css}font-size:12px;color:rgba(0,0,0,0.6);background:rgba(255,255,255,0.75);padding:3px 8px;border-radius:4px;font-family:monospace;white-space:nowrap;">${ts}</div>`;
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
        name: `${selectedDoc.name} (Timestamped)`,
        pages: [],
        pdfUri: stored,
        createdAt: now,
        updatedAt: now,
      });

      Alert.alert('Done', 'Timestamped PDF saved to your documents.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch {
      Alert.alert('Error', 'Could not apply timestamp.');
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
        <Text style={[styles.title, { color: colors.text }]}>Timestamp</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {/* Preview */}
        <View style={[styles.previewBox, { backgroundColor: colors.card }]}>
          <Text style={[styles.previewLabel, { color: colors.muted }]}>Preview</Text>
          <Text style={[styles.previewValue, { color: colors.text }]}>{getTimestamp()}</Text>
        </View>

        {/* Format */}
        <Text style={[styles.sectionLabel, { color: colors.muted, marginTop: 20 }]}>FORMAT</Text>
        <View style={[styles.optionCard, { backgroundColor: colors.card }]}>
          {FORMATS.map((f, i) => (
            <Pressable
              key={f.id}
              style={[styles.optionRow, i < FORMATS.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}
              onPress={() => setFormat(f.id)}
            >
              <Text style={[styles.optionLabel, { color: colors.text }]}>{f.label}</Text>
              {format === f.id && <Ionicons name="checkmark" size={20} color={colors.accent} />}
            </Pressable>
          ))}
        </View>

        {/* Position */}
        <Text style={[styles.sectionLabel, { color: colors.muted, marginTop: 20 }]}>POSITION</Text>
        <View style={[styles.optionCard, { backgroundColor: colors.card }]}>
          {POSITIONS.map((p, i) => (
            <Pressable
              key={p.id}
              style={[styles.optionRow, i < POSITIONS.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}
              onPress={() => setPositionId(p.id)}
            >
              <Text style={[styles.optionLabel, { color: colors.text }]}>{p.label}</Text>
              {positionId === p.id && <Ionicons name="checkmark" size={20} color={colors.accent} />}
            </Pressable>
          ))}
        </View>

        {/* Document list */}
        <Text style={[styles.sectionLabel, { color: colors.muted, marginTop: 20 }]}>SELECT DOCUMENT</Text>
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
              : <Text style={styles.applyBtnText}>Apply Timestamp</Text>
            }
          </Pressable>
        )}

        <Text style={[styles.footnote, { color: colors.muted }]}>
          A new PDF with the timestamp visible on each page will be saved. Your original is unchanged.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12 },
  title: { fontSize: 17, fontWeight: '700' },
  content: { paddingHorizontal: 16 },
  previewBox: { borderRadius: 12, padding: 16, alignItems: 'center', gap: 4 },
  previewLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  previewValue: { fontSize: 16, fontFamily: 'monospace' },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 },
  optionCard: { borderRadius: 12, overflow: 'hidden' },
  optionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14 },
  optionLabel: { fontSize: 15 },
  emptyText: { fontSize: 14, fontStyle: 'italic' },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 12, marginBottom: 8, borderWidth: 1.5 },
  docName: { fontSize: 15, fontWeight: '600' },
  docMeta: { fontSize: 12, marginTop: 2 },
  applyBtn: { borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  applyBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  footnote: { fontSize: 12, marginTop: 12, textAlign: 'center', fontStyle: 'italic' },
});

// app/tools/watermark.tsx
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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

const POSITIONS = [
  { id: 'diagonal', label: 'Diagonal', css: 'transform:rotate(-30deg);font-size:42px;opacity:0.15;' },
  { id: 'center', label: 'Centre', css: 'font-size:32px;opacity:0.18;' },
  { id: 'bottom', label: 'Bottom', css: 'position:absolute;bottom:24px;right:24px;font-size:16px;opacity:0.5;' },
];

export default function WatermarkScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [docs, setDocs] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [text, setText] = useState('CONFIDENTIAL');
  const [position, setPosition] = useState('diagonal');
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    getDocuments().then(all => setDocs(all.filter(d => d.pages.length > 0))).catch(console.error);
  }, []);

  const handleApply = async () => {
    if (!selectedDoc || !text.trim()) return;
    setApplying(true);
    try {
      const pos = POSITIONS.find(p => p.id === position)!;
      const isAbsolute = pos.css.includes('position:absolute');

      const imgTags = await Promise.all(
        selectedDoc.pages.map(async (uri, i) => {
          const css = filterCss(selectedDoc.filters?.[i] as PageFilter | undefined);
          const filterAttr = css !== 'none' ? `filter:${css};` : '';
          const b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
          const overlay = isAbsolute
            ? `<div style="${pos.css}color:rgba(0,0,0,0.5);font-weight:bold;white-space:nowrap;">${text}</div>`
            : `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;overflow:hidden;"><span style="${pos.css}color:rgba(0,0,0,0.5);font-weight:bold;white-space:nowrap;">${text}</span></div>`;
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
        name: `${selectedDoc.name} (Watermark)`,
        pages: [],
        pdfUri: stored,
        createdAt: now,
        updatedAt: now,
      });

      Alert.alert('Done', 'Watermarked PDF saved to your documents.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch {
      Alert.alert('Error', 'Could not apply watermark.');
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
        <Text style={[styles.title, { color: colors.text }]}>Watermark</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {/* Text input */}
        <Text style={[styles.sectionLabel, { color: colors.muted }]}>WATERMARK TEXT</Text>
        <TextInput
          style={[styles.textInput, { color: colors.text, backgroundColor: colors.card, borderColor: colors.border }]}
          value={text}
          onChangeText={setText}
          placeholder="e.g. CONFIDENTIAL"
          placeholderTextColor={colors.muted}
          returnKeyType="done"
          maxLength={40}
        />

        {/* Position */}
        <Text style={[styles.sectionLabel, { color: colors.muted, marginTop: 20 }]}>POSITION</Text>
        <View style={[styles.optionCard, { backgroundColor: colors.card }]}>
          {POSITIONS.map((pos, i) => (
            <Pressable
              key={pos.id}
              style={[
                styles.optionRow,
                i < POSITIONS.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
              ]}
              onPress={() => setPosition(pos.id)}
            >
              <Text style={[styles.optionLabel, { color: colors.text }]}>{pos.label}</Text>
              {position === pos.id && <Ionicons name="checkmark" size={20} color={colors.accent} />}
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

        {selectedDoc && text.trim() && (
          <Pressable
            style={[styles.applyBtn, { backgroundColor: colors.accent, opacity: applying ? 0.6 : 1, marginTop: 24 }]}
            onPress={handleApply}
            disabled={applying}
          >
            {applying
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.applyBtnText}>Apply Watermark</Text>
            }
          </Pressable>
        )}

        <Text style={[styles.footnote, { color: colors.muted }]}>
          A new PDF document with the watermark applied will be saved. Your original document is unchanged.
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
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 },
  textInput: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
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

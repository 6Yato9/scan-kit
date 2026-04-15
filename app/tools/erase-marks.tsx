import { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { getDocuments, updateDocument } from '@/lib/storage';
import type { Document, PageAdjustment, PageFilter } from '@/types/document';

const ERASE_FILTER: PageFilter = 'bw';
const ERASE_ADJUSTMENT: PageAdjustment = { brightness: 30, contrast: 30, saturation: 0 };

export default function EraseMarksScreen() {
  const { colors, isDark } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState(false);

  useFocusEffect(
    useCallback(() => {
      getDocuments().then(docs => setDocuments(docs.filter(d => d.pages.length > 0)));
    }, [])
  );

  const handleApply = useCallback(async () => {
    if (!selectedDoc) return;
    setApplying(true);
    setDone(false);
    try {
      const pageCount = selectedDoc.pages.length;
      await updateDocument({
        ...selectedDoc,
        filters: Array.from({ length: pageCount }, () => ERASE_FILTER),
        adjustments: Array.from({ length: pageCount }, () => ({ ...ERASE_ADJUSTMENT })),
        updatedAt: Date.now(),
      });
      setDone(true);
    } catch {
      Alert.alert('Error', 'Failed to apply. Please try again.');
    } finally {
      setApplying(false);
    }
  }, [selectedDoc]);

  const borderColor = isDark ? '#2a2a2a' : '#e0e0e0';
  const inputBg = isDark ? '#1a1a1a' : '#f5f5f5';

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Erase Marks</Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.body}>
        <View style={[styles.iconWrap, { backgroundColor: '#FF8A6528' }]}>
          <MaterialCommunityIcons name="eraser-variant" size={48} color="#FF8A65" />
        </View>
        <Text style={[styles.heading, { color: colors.text }]}>Remove Pencil & Light Marks</Text>
        <Text style={[styles.sub, { color: colors.faint }]}>
          Applies a high-contrast grayscale filter to make light pencil and pen marks disappear. Affects the document view and PDF exports.
        </Text>

        <Pressable
          style={[styles.picker, { borderColor, backgroundColor: inputBg }]}
          onPress={() => { setDone(false); setPickerVisible(true); }}
        >
          {selectedDoc ? (
            <View style={styles.pickerRow}>
              <Image source={{ uri: selectedDoc.pages[0] }} style={styles.thumb} />
              <Text style={[styles.docName, { color: colors.text }]} numberOfLines={1}>
                {selectedDoc.name}
              </Text>
              <MaterialCommunityIcons name="chevron-down" size={20} color={colors.faint} />
            </View>
          ) : (
            <View style={styles.pickerRow}>
              <MaterialCommunityIcons name="file-document-outline" size={24} color={colors.faint} />
              <Text style={[styles.placeholder, { color: colors.faint }]}>Select a document</Text>
              <MaterialCommunityIcons name="chevron-down" size={20} color={colors.faint} />
            </View>
          )}
        </Pressable>

        {done && (
          <View style={[styles.successRow, { backgroundColor: '#66BB6A20' }]}>
            <MaterialCommunityIcons name="check-circle" size={18} color="#66BB6A" />
            <Text style={{ color: '#66BB6A', fontWeight: '600' }}>Applied to all pages</Text>
          </View>
        )}

        <Pressable
          style={[styles.applyBtn, { opacity: !selectedDoc || applying ? 0.5 : 1 }]}
          onPress={handleApply}
          disabled={!selectedDoc || applying}
        >
          <MaterialCommunityIcons name="eraser-variant" size={20} color="#fff" />
          <Text style={styles.btnText}>{applying ? 'Applying…' : 'Apply to All Pages'}</Text>
        </Pressable>
      </View>

      <Modal visible={pickerVisible} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: colors.bg }]}>
          <View style={[styles.header, { paddingTop: 16 }]}>
            <Text style={[styles.title, { color: colors.text }]}>Select Document</Text>
            <Pressable onPress={() => setPickerVisible(false)} style={styles.backBtn}>
              <MaterialCommunityIcons name="close" size={24} color={colors.text} />
            </Pressable>
          </View>
          <FlatList
            data={documents}
            keyExtractor={d => d.id}
            contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
            renderItem={({ item }) => (
              <Pressable
                style={[styles.listItem, { borderBottomColor: borderColor }]}
                onPress={() => { setSelectedDoc(item); setPickerVisible(false); }}
              >
                <Image source={{ uri: item.pages[0] }} style={styles.listThumb} />
                <Text style={[styles.docName, { color: colors.text, flex: 1 }]} numberOfLines={2}>
                  {item.name}
                </Text>
                {selectedDoc?.id === item.id && (
                  <MaterialCommunityIcons name="check-circle" size={22} color="#FF8A65" />
                )}
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={[styles.sub, { color: colors.faint, textAlign: 'center', marginTop: 40 }]}>
                No scanned documents yet.
              </Text>
            }
          />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700' },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  heading: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  sub: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  picker: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  thumb: { width: 40, height: 40, borderRadius: 6 },
  docName: { flex: 1, fontSize: 15, fontWeight: '500' },
  placeholder: { flex: 1, fontSize: 15 },
  successRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 10,
    width: '100%',
    justifyContent: 'center',
  },
  applyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FF8A65',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 4,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  modal: { flex: 1 },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  listThumb: { width: 48, height: 48, borderRadius: 6 },
});

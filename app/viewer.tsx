import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Dimensions,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDocuments } from '@/lib/storage';
import { Document } from '@/types/document';
import { ExportSheet } from '@/components/export-sheet';

const SCREEN_WIDTH = Dimensions.get('window').width;

export default function ViewerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [document, setDocument] = useState<Document | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [exportVisible, setExportVisible] = useState(false);
  const insets = useSafeAreaInsets();
  const router = useRouter();

  useEffect(() => {
    getDocuments().then(docs => {
      setDocument(docs.find(d => d.id === id) ?? null);
    });
  }, [id]);

  if (!document) return null;

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.counter}>
          {currentPage + 1} / {document.pages.length}
        </Text>
        <Pressable onPress={() => setExportVisible(true)} hitSlop={12}>
          <Text style={styles.exportBtn}>Export</Text>
        </Pressable>
      </View>

      <FlatList
        data={document.pages}
        keyExtractor={(_, i) => String(i)}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={e => {
          setCurrentPage(
            Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH)
          );
        }}
        renderItem={({ item }) => (
          <View style={styles.page}>
            <Image
              source={{ uri: item }}
              style={styles.pageImage}
              resizeMode="contain"
            />
          </View>
        )}
      />

      <ExportSheet
        visible={exportVisible}
        document={document}
        onClose={() => setExportVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  back: { fontSize: 22, color: '#fff', fontWeight: '300' },
  counter: { fontSize: 15, color: '#ccc', fontWeight: '600' },
  exportBtn: { fontSize: 16, color: '#4ec6e0', fontWeight: '600' },
  page: {
    width: SCREEN_WIDTH,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  pageImage: { width: SCREEN_WIDTH - 32, flex: 1 },
});

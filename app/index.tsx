// app/index.tsx
import { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DocumentScanner from 'react-native-document-scanner-plugin';
import * as Crypto from 'expo-crypto';
import { Document } from '@/types/document';
import { getDocuments, saveDocument, updateDocument, deleteDocument } from '@/lib/storage';
import { copyPageToStorage, deleteDocumentFiles } from '@/lib/files';
import { DocumentCard } from '@/components/document-card';
import { EmptyState } from '@/components/empty-state';
import { ScanNameSheet } from '@/components/scan-name-sheet';
import { RenameSheet } from '@/components/rename-sheet';

export default function HomeScreen() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [pendingPages, setPendingPages] = useState<string[]>([]);
  const [nameSheetVisible, setNameSheetVisible] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Document | null>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();

  useEffect(() => {
    getDocuments().then(setDocuments);
  }, []);

  const handleScan = useCallback(async () => {
    try {
      const { scannedImages } = await DocumentScanner.scanDocument();
      if (!scannedImages?.length) return;
      setPendingPages(scannedImages);
      setNameSheetVisible(true);
    } catch (err) {
      console.error('Scan failed', err);
    }
  }, []);

  const handleSave = useCallback(
    async (name: string) => {
      try {
        const id = Crypto.randomUUID();
        const now = Date.now();
        const savedPages = await Promise.all(
          pendingPages.map((uri, i) => copyPageToStorage(uri, id, i))
        );
        const doc: Document = { id, name, pages: savedPages, createdAt: now, updatedAt: now };
        await saveDocument(doc);
        setDocuments(prev => [doc, ...prev]);
        setNameSheetVisible(false);
        setPendingPages([]);
      } catch (err) {
        console.error('Save failed', err);
      }
    },
    [pendingPages]
  );

  const handleRetake = useCallback(() => {
    setNameSheetVisible(false);
    setPendingPages([]);
    setTimeout(handleScan, 350);
  }, [handleScan]);

  const handleRename = useCallback(async (doc: Document, newName: string) => {
    const updated = { ...doc, name: newName, updatedAt: Date.now() };
    await updateDocument(updated);
    setDocuments(prev => prev.map(d => (d.id === doc.id ? updated : d)));
    setRenameTarget(null);
  }, []);

  const handleDelete = useCallback(async (doc: Document) => {
    await deleteDocument(doc.id);
    await deleteDocumentFiles(doc.id);
    setDocuments(prev => prev.filter(d => d.id !== doc.id));
    setRenameTarget(null);
  }, []);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Scan Kit</Text>
      </View>

      <FlatList
        data={documents}
        keyExtractor={d => d.id}
        numColumns={2}
        contentContainerStyle={
          documents.length === 0 ? styles.emptyContent : styles.gridContent
        }
        ListEmptyComponent={<EmptyState />}
        renderItem={({ item }) => (
          <DocumentCard
            document={item}
            onPress={() =>
              router.push({ pathname: '/viewer', params: { id: item.id } })
            }
            onLongPress={() => setRenameTarget(item)}
          />
        )}
      />

      <Pressable
        style={[styles.fab, { bottom: insets.bottom + 24 }]}
        onPress={handleScan}
      >
        <Text style={styles.fabIcon}>+</Text>
      </Pressable>

      <ScanNameSheet
        visible={nameSheetVisible}
        pageCount={pendingPages.length}
        onSave={handleSave}
        onRetake={handleRetake}
        onClose={() => {
          setNameSheetVisible(false);
          setPendingPages([]);
        }}
      />

      <RenameSheet
        visible={renameTarget !== null}
        document={renameTarget}
        onRename={handleRename}
        onDelete={handleDelete}
        onClose={() => setRenameTarget(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: { paddingHorizontal: 20, paddingVertical: 14 },
  title: { fontSize: 30, fontWeight: '800', color: '#1a1a1a', letterSpacing: -0.5 },
  gridContent: { padding: 10, paddingBottom: 100 },
  emptyContent: { flex: 1 },
  fab: {
    position: 'absolute',
    alignSelf: 'center',
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#0a7ea4',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0a7ea4',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  fabIcon: { fontSize: 34, color: '#fff', lineHeight: 40, marginTop: -2 },
});

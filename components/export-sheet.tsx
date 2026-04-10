import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { useState } from 'react';
import * as Sharing from 'expo-sharing';
import { generatePdf } from '@/lib/pdf';
import { BottomSheet } from '@/components/bottom-sheet';
import { Document } from '@/types/document';

type Props = {
  visible: boolean;
  document: Document;
  onClose: () => void;
};

export function ExportSheet({ visible, document, onClose }: Props) {
  const [loading, setLoading] = useState(false);

  async function handleExportPdf() {
    setLoading(true);
    try {
      const uri = await generatePdf(document.pages);
      onClose();
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        dialogTitle: document.name,
        UTI: 'com.adobe.pdf',
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleExportJpeg() {
    onClose();
    for (const pageUri of document.pages) {
      await Sharing.shareAsync(pageUri, {
        mimeType: 'image/jpeg',
        dialogTitle: document.name,
      });
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.heading}>Export</Text>
      {loading ? (
        <ActivityIndicator style={{ marginVertical: 24 }} />
      ) : (
        <>
          <Pressable style={styles.option} onPress={handleExportPdf}>
            <Text style={styles.optionTitle}>Export as PDF</Text>
            <Text style={styles.optionSub}>All {document.pages.length} pages in one file</Text>
          </Pressable>
          <Pressable style={styles.option} onPress={handleExportJpeg}>
            <Text style={styles.optionTitle}>Export as JPEG</Text>
            <Text style={styles.optionSub}>Share individual page images</Text>
          </Pressable>
        </>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 18, fontWeight: '700', marginBottom: 16, color: '#1a1a1a' },
  option: {
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
  },
  optionTitle: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  optionSub: { fontSize: 13, color: '#999', marginTop: 3 },
});

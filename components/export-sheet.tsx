// components/export-sheet.tsx
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { useState } from 'react';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import { generatePdf } from '@/lib/pdf';
import { filterCss } from '@/lib/filters';
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
      const uri = await generatePdf(document.pages, document.filters);
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        dialogTitle: document.name,
        UTI: 'com.adobe.pdf',
      });
    } finally {
      setLoading(false);
      onClose();
    }
  }

  async function handleExportJpeg() {
    setLoading(true);
    try {
      for (const pageUri of document.pages) {
        await Sharing.shareAsync(pageUri, {
          mimeType: 'image/jpeg',
          dialogTitle: document.name,
        });
      }
    } finally {
      setLoading(false);
      onClose();
    }
  }

  async function handlePrint() {
    setLoading(true);
    try {
      const imgTags = document.pages
        .map((uri, i) => {
          const css = filterCss(document.filters?.[i]);
          const filterAttr = css !== 'none' ? `filter:${css};` : '';
          return `<img src="${uri}" style="width:100%;display:block;page-break-after:always;${filterAttr}" />`;
        })
        .join('');
      const html = `<html><body style="margin:0;padding:0;">${imgTags}</body></html>`;
      await Print.printAsync({ html });
    } finally {
      setLoading(false);
      onClose();
    }
  }

  return (
    <BottomSheet visible={visible} onClose={loading ? undefined : onClose}>
      <Text style={styles.heading}>Export</Text>
      {loading ? (
        <ActivityIndicator size="large" style={{ marginVertical: 32 }} />
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
          <Pressable style={styles.option} onPress={handlePrint}>
            <Text style={styles.optionTitle}>Print</Text>
            <Text style={styles.optionSub}>Send to a printer</Text>
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

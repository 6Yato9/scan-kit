// components/export-sheet.tsx
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { useState } from 'react';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import { generatePdf } from '@/lib/pdf';
import { combinedFilterCss } from '@/lib/filters';
import { BottomSheet } from '@/components/bottom-sheet';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';

type Props = {
  visible: boolean;
  document: Document;
  onClose: () => void;
};

export function ExportSheet({ visible, document, onClose }: Props) {
  const { colors } = useTheme();
  const [loading, setLoading] = useState(false);

  async function handleExportPdf() {
    setLoading(true);
    try {
      const uri = await generatePdf(document.pages, document.filters, document.adjustments);
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
          const css = combinedFilterCss(document.filters?.[i], document.adjustments?.[i]);
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

  const hasFilters = document.pages.length > 0 && (document.filters?.some(f => f !== 'original') || document.adjustments?.length);

  return (
    <BottomSheet visible={visible} onClose={loading ? undefined : onClose}>
      <Text style={[styles.heading, { color: colors.text }]}>Export</Text>
      {loading ? (
        <ActivityIndicator size="large" style={{ marginVertical: 32 }} />
      ) : (
        <>
          <Pressable style={[styles.option, { borderBottomColor: colors.border }]} onPress={handleExportPdf}>
            <Text style={[styles.optionTitle, { color: colors.text }]}>Export as PDF</Text>
            <Text style={[styles.optionSub, { color: colors.faint }]}>All {document.pages.length} pages — filters applied</Text>
          </Pressable>
          <Pressable style={[styles.option, { borderBottomColor: colors.border }]} onPress={handleExportJpeg}>
            <Text style={[styles.optionTitle, { color: colors.text }]}>Export as JPEG</Text>
            <Text style={[styles.optionSub, { color: colors.faint }]}>
              {hasFilters ? 'Original images — use PDF to preserve filters' : 'Share individual page images'}
            </Text>
          </Pressable>
          <Pressable style={[styles.option, { borderBottomColor: colors.border }]} onPress={handlePrint}>
            <Text style={[styles.optionTitle, { color: colors.text }]}>Print</Text>
            <Text style={[styles.optionSub, { color: colors.faint }]}>Send to a printer — filters applied</Text>
          </Pressable>
        </>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 18, fontWeight: '700', marginBottom: 16 },
  option: {
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optionTitle: { fontSize: 16, fontWeight: '600' },
  optionSub: { fontSize: 13, marginTop: 3 },
});

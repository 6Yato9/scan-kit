// components/export-sheet.tsx
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system';
import { Paths } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { SaveFormat } from 'expo-image-manipulator';
import JSZip from 'jszip';
import { generatePdf } from '@/lib/pdf';
import { combinedFilterCss } from '@/lib/filters';
import { BottomSheet } from '@/components/bottom-sheet';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { getDocSettings } from '@/lib/storage';

type Props = {
  visible: boolean;
  document: Document;
  onClose: () => void;
};

export function ExportSheet({ visible, document, onClose }: Props) {
  const { colors } = useTheme();
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('');

  async function handleExportPdf(quality: 'medium' | 'high') {
    setLoadingLabel('Generating PDF…');
    setLoading(true);
    try {
      const settings = await getDocSettings();
      let pages = document.pages;

      // Honor the user's PDF quality preference: 'standard' is medium, 'high' keeps full res.
      // The explicit "Medium" button always recompresses regardless of the setting.
      const compressFactor = quality === 'medium'
        ? 0.55
        : settings.pdfQuality === 'standard' ? 0.75 : 1;

      if (compressFactor < 1) {
        setLoadingLabel('Optimising images…');
        const recompressed = await Promise.all(
          document.pages.map(uri =>
            ImageManipulator.manipulateAsync(uri, [], {
              compress: compressFactor,
              format: SaveFormat.JPEG,
            }).then(r => r.uri)
          )
        );
        pages = recompressed;
      }

      setLoadingLabel('Building PDF…');
      const uri = await generatePdf(pages, document.filters, document.adjustments, settings.pdfPageSize);
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        dialogTitle: document.name,
        UTI: 'com.adobe.pdf',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not generate PDF.';
      Alert.alert('Export failed', msg);
    } finally {
      setLoading(false);
      setLoadingLabel('');
      onClose();
    }
  }

  async function handleExportZip() {
    setLoading(true);
    setLoadingLabel('Building ZIP…');
    try {
      const zip = new JSZip();
      for (let i = 0; i < document.pages.length; i++) {
        const b64 = await FileSystem.readAsStringAsync(document.pages[i], {
          encoding: 'base64',
        });
        zip.file(`page_${String(i + 1).padStart(2, '0')}.jpg`, b64, { base64: true });
      }
      const zipB64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
      const safeName = document.name.replace(/[^a-z0-9]/gi, '_');
      const tempUri = `${Paths.cache.uri}${safeName}.zip`;
      await FileSystem.writeAsStringAsync(tempUri, zipB64, { encoding: 'base64' });
      await Sharing.shareAsync(tempUri, {
        mimeType: 'application/zip',
        dialogTitle: document.name,
        UTI: 'public.zip-archive',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not build ZIP.';
      Alert.alert('Export failed', msg);
    } finally {
      setLoading(false);
      setLoadingLabel('');
      onClose();
    }
  }

  async function handlePrint() {
    setLoading(true);
    setLoadingLabel('Sending to printer…');
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not print.';
      // User-cancelled iOS print dialogs throw — only alert if it looks like a real failure.
      if (!/cancel/i.test(msg)) Alert.alert('Print failed', msg);
    } finally {
      setLoading(false);
      setLoadingLabel('');
      onClose();
    }
  }

  const pageCount = document.pages.length;
  const hasFilters = document.filters?.some(f => f !== 'original') || !!document.adjustments?.length;

  return (
    <BottomSheet visible={visible} onClose={loading ? undefined : onClose}>
      <Text style={[styles.heading, { color: colors.text }]}>Export</Text>

      {loading ? (
        <View style={styles.loadingArea}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={[styles.loadingLabel, { color: colors.muted }]}>{loadingLabel}</Text>
        </View>
      ) : (
        <>
          {/* PDF section */}
          <Text style={[styles.groupLabel, { color: colors.muted }]}>PDF</Text>
          <View style={[styles.group, { backgroundColor: colors.card }]}>
            <Pressable
              style={[styles.option, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}
              onPress={() => handleExportPdf('high')}
            >
              <View style={styles.optionText}>
                <Text style={[styles.optionTitle, { color: colors.text }]}>High Quality</Text>
                <Text style={[styles.optionSub, { color: colors.faint }]}>
                  Full resolution{hasFilters ? ' · filters applied' : ''}
                </Text>
              </View>
              <Text style={[styles.badge, { backgroundColor: colors.accentLight, color: colors.accent }]}>HD</Text>
            </Pressable>
            <Pressable
              style={styles.option}
              onPress={() => handleExportPdf('medium')}
            >
              <View style={styles.optionText}>
                <Text style={[styles.optionTitle, { color: colors.text }]}>Medium Quality</Text>
                <Text style={[styles.optionSub, { color: colors.faint }]}>Smaller file size</Text>
              </View>
              <Text style={[styles.badge, { backgroundColor: colors.secondary, color: colors.muted }]}>SD</Text>
            </Pressable>
          </View>

          {/* ZIP section */}
          <Text style={[styles.groupLabel, { color: colors.muted }]}>IMAGES</Text>
          <View style={[styles.group, { backgroundColor: colors.card }]}>
            <Pressable
              style={[styles.option, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}
              onPress={handleExportZip}
            >
              <View style={styles.optionText}>
                <Text style={[styles.optionTitle, { color: colors.text }]}>Export as ZIP</Text>
                <Text style={[styles.optionSub, { color: colors.faint }]}>
                  {pageCount} JPEG{pageCount !== 1 ? 's' : ''} bundled in a zip file
                </Text>
              </View>
            </Pressable>
            <Pressable style={styles.option} onPress={handlePrint}>
              <View style={styles.optionText}>
                <Text style={[styles.optionTitle, { color: colors.text }]}>Print</Text>
                <Text style={[styles.optionSub, { color: colors.faint }]}>
                  Send to a printer{hasFilters ? ' · filters applied' : ''}
                </Text>
              </View>
            </Pressable>
          </View>
        </>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 18, fontWeight: '700', marginBottom: 16 },
  loadingArea: { alignItems: 'center', paddingVertical: 32, gap: 12 },
  loadingLabel: { fontSize: 14 },
  groupLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 8,
    marginTop: 4,
  },
  group: {
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 14,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  optionText: { flex: 1 },
  optionTitle: { fontSize: 16, fontWeight: '600' },
  optionSub: { fontSize: 13, marginTop: 2 },
  badge: {
    fontSize: 10,
    fontWeight: '800',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
  },
});

// app/settings/printer.tsx
// Printing preferences. Scan Kit prints through the system (AirPrint) dialog,
// where the printer itself is chosen, so this screen holds what the app
// controls: a link to the paper size (set in Document settings) and a test page.
import { useCallback, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { getDocSettings, DocSettings } from '@/lib/storage';
import { generateTestPagePdf } from '@/lib/pdf';
import { deleteQuietly, printFile, ShareError } from '@/lib/share';
import { SectionLabel } from '@/components/section-label';
import { PrimaryButton } from '@/components/primary-button';
import { SettingsGroup, SettingsRow } from '@/components/settings-list';
import { ToolScreen } from '@/components/tool-ui';
import { useToast } from '@/components/toast';
import { Radius, Spacing, Type } from '@/lib/theme';

type PageSize = DocSettings['pdfPageSize'];

const PAPER_LABEL: Record<PageSize, string> = { A4: 'A4', Letter: 'US Letter' };

export default function PrinterScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const toast = useToast();
  const [pageSize, setPageSize] = useState<PageSize | null>(null);
  const [printing, setPrinting] = useState(false);
  const busyRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      getDocSettings()
        .then(s => {
          if (!cancelled) setPageSize(s.pdfPageSize);
        })
        .catch(() => {
          if (!cancelled) setPageSize('A4');
        });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const printTestPage = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPrinting(true);
    let uri: string | null = null;
    try {
      uri = await generateTestPagePdf(pageSize ?? 'A4');
      setPrinting(false);
      const outcome = await printFile(uri);
      if (outcome === 'printed') toast.show('Test page sent to printer');
    } catch (err) {
      Alert.alert(
        'Couldn’t print test page',
        err instanceof ShareError ? err.message : 'Something went wrong while preparing the page. Try again.',
      );
    } finally {
      busyRef.current = false;
      setPrinting(false);
      deleteQuietly(uri);
    }
  }, [pageSize, toast]);

  return (
    <ToolScreen title="Printing">
      {/* Paper size has one home, Document settings, because it shapes every
          PDF as well as every print job. This row shows it and links there. */}
      <SettingsGroup
        title="Paper"
        footer="The same size is used for every PDF you export. Change it in Document settings."
      >
        <SettingsRow
          icon="document-outline"
          label="Paper size"
          accessory={{ type: 'value', text: pageSize ? PAPER_LABEL[pageSize] : null }}
          onPress={() => router.push('/settings/document-settings')}
          last
        />
      </SettingsGroup>

      <SectionLabel>Test your printer</SectionLabel>
      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <View style={styles.cardHead}>
          <View style={[styles.iconTile, { backgroundColor: colors.accentLight }]}>
            <Ionicons name="print-outline" size={22} color={colors.accent} />
          </View>
          <Text style={[Type.callout, styles.cardText, { color: colors.subtext }]}>
            Print a page with a frame and a grayscale strip to check alignment, margins and tone. You choose the printer in the
            print dialog.
          </Text>
        </View>
        <PrimaryButton
          title="Print a test page"
          icon="print-outline"
          onPress={printTestPage}
          loading={printing}
          disabled={pageSize === null}
        />
      </View>
      <Text style={[Type.footnote, styles.footer, { color: colors.muted }]}>
        Scan Kit prints with AirPrint. Make sure your printer is on the same Wi-Fi network as this device.
      </Text>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  footer: { marginTop: Spacing.sm, marginHorizontal: Spacing.xs, lineHeight: 18 },
  card: { borderRadius: Radius.md, padding: Spacing.lg, gap: Spacing.lg },
  cardHead: { flexDirection: 'row', gap: Spacing.md, alignItems: 'flex-start' },
  cardText: { flex: 1, lineHeight: 21 },
  iconTile: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

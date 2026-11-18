// app/settings/printer.tsx
// Printing preferences. Scan Kit prints through the system (AirPrint) dialog,
// where the printer itself is chosen, so this screen holds what the app
// controls: the paper size every PDF and print job uses, and a test page.
import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { getDocSettings, saveDocSettings, DocSettings } from '@/lib/storage';
import { generateTestPagePdf } from '@/lib/pdf';
import { deleteQuietly, printFile, ShareError } from '@/lib/share';
import { SectionLabel } from '@/components/section-label';
import { PrimaryButton } from '@/components/primary-button';
import { useToast } from '@/components/toast';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

type PageSize = DocSettings['pdfPageSize'];

const PAPER_OPTIONS: { value: PageSize; title: string; subtitle: string }[] = [
  { value: 'A4', title: 'A4', subtitle: '210 × 297 mm' },
  { value: 'Letter', title: 'US Letter', subtitle: '8.5 × 11 in' },
];

export default function PrinterScreen() {
  const insets = useSafeAreaInsets();
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

  const choose = useCallback(async (value: PageSize) => {
    setPageSize(value);
    try {
      const current = await getDocSettings();
      await saveDocSettings({ ...current, pdfPageSize: value });
    } catch {
      Alert.alert('Couldn’t save paper size', 'Try again in a moment.');
    }
  }, []);

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
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}
    >
      <SectionLabel>Paper size</SectionLabel>
      <View style={[styles.group, { backgroundColor: colors.card }]}>
        {PAPER_OPTIONS.map((opt, i) => {
          const selected = pageSize === opt.value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => choose(opt.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${opt.title}, ${opt.subtitle}`}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.secondary }]}
            >
              <View
                style={[
                  styles.rowInner,
                  i < PAPER_OPTIONS.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.border,
                  },
                ]}
              >
                <View style={styles.rowText}>
                  <Text style={[Type.body, { color: colors.text }]}>{opt.title}</Text>
                  <Text style={[Type.footnote, { color: colors.muted }]}>{opt.subtitle}</Text>
                </View>
                {selected && <Ionicons name="checkmark" size={22} color={colors.accent} />}
              </View>
            </Pressable>
          );
        })}
      </View>
      <Text style={[Type.footnote, styles.footer, { color: colors.muted }]}>
        Used for printing and for every PDF you export. Each scanned page fits on one sheet.
      </Text>

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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: Spacing.gutter },
  group: { borderRadius: Radius.md, overflow: 'hidden' },
  row: { paddingLeft: Spacing.lg },
  rowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: HIT + 12,
    paddingVertical: Spacing.sm,
    paddingRight: Spacing.lg,
  },
  rowText: { flex: 1, gap: Spacing.xxs },
  footer: { marginTop: Spacing.sm, marginHorizontal: Spacing.xs },
  card: { borderRadius: Radius.md, padding: Spacing.lg, gap: Spacing.lg },
  cardHead: { flexDirection: 'row', gap: Spacing.md, alignItems: 'flex-start' },
  cardText: { flex: 1 },
  iconTile: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

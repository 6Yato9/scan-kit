import { createContext, useCallback, useContext, useMemo, useRef, useState, ReactNode } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, View } from 'react-native';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { PageFilter } from '@/types/document';
import { notifySuccess, notifyError } from '@/lib/haptics';
import { getScanSettings, getDocSettings } from '@/lib/storage';
import { saveScan, indexDocText } from '@/lib/save-scan';
import { autoName } from '@/lib/auto-name';
import { bakePages } from '@/lib/bake';
import { withSystemUI } from '@/lib/system-ui';
import { useTheme } from '@/contexts/theme-context';
import { Radius, Spacing, Type } from '@/lib/theme';

type SaveInput = {
  pages?: string[];
  pdfUri?: string;
  defaultFilter?: PageFilter | 'original';
};

type ScanContextType = {
  lastSaved: number;
  scanning: boolean;
  /** True while a scan or import is being written to storage. */
  saving: boolean;
  /** Scans, saves, and returns the new document id — or null if cancelled or failed. */
  triggerScan: () => Promise<string | null>;
  /** Saves imported pages or a PDF, returning the new document id — or null on failure. */
  saveAndOpen: (input: SaveInput) => Promise<string | null>;
  bumpLastSaved: () => void;
};

/** Recompression quality applied when a page is stored (scan settings → 0–1). */
export const QUALITY_MAP = { low: 0.5, medium: 0.75, high: 0.9 } as const;
/** Quality the document camera itself encodes at (0–100). */
export const SCAN_QUALITY_MAP = { low: 50, medium: 75, high: 90 } as const;

const ScanContext = createContext<ScanContextType | null>(null);

export function ScanProvider({ children }: { children: ReactNode }) {
  const [lastSaved, setLastSaved] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState<number | null>(null); // page count being saved
  const scanningRef = useRef(false);
  const savingRef = useRef(false);

  const saveAndOpen = useCallback(async (input: SaveInput): Promise<string | null> => {
    // A second import started while the first is still writing would create a
    // duplicate document; ignore it.
    if (savingRef.current) return null;
    savingRef.current = true;
    const count = input.pages?.length ?? 0;
    setSaving(Math.max(1, count));
    try {
      const [scan, docSettings] = await Promise.all([getScanSettings(), getDocSettings()]);
      const filter = input.defaultFilter ?? scan.defaultFilter;
      // Saved as 'original'; the default filter is recorded only once a bake
      // has written it into the pixels (see lib/bake.ts), so a failed or
      // interrupted bake can't leave the picker claiming a look the page lacks.
      const { id, pages } = await saveScan({
        pages: input.pages,
        pdfUri: input.pdfUri,
        name: autoName(new Date(), docSettings.namePrefix),
        nameIsDefault: true,
        quality: QUALITY_MAP[scan.quality],
      });
      setLastSaved(Date.now());
      notifySuccess();
      // Bake the default filter into the pages' pixels without blocking the
      // caller (it opens the viewer, which shows progress). bakePages registers
      // every page synchronously, so the viewer already shows the chosen filter
      // as pending, and edits made meanwhile re-target the bakes. OCR runs
      // after so the index — and the title it names the document by — reflects
      // the final pixels.
      (async () => {
        if (pages.length && filter !== 'original') await bakePages(id, pages.map((_, i) => i), filter);
        if (pages.length) await indexDocText(id, pages);
      })().catch(err => console.error('post-save processing failed', err));
      return id;
    } catch (err) {
      console.error('Save failed', err);
      notifyError();
      Alert.alert("Couldn't save the scan", 'There may not be enough free space. Free up some storage and try again.');
      return null;
    } finally {
      savingRef.current = false;
      setSaving(null);
    }
  }, []);

  const triggerScan = useCallback(async (): Promise<string | null> => {
    if (scanningRef.current) return null;
    scanningRef.current = true;
    setScanning(true);
    try {
      const settings = await getScanSettings();
      // VisionKit always shows its own review/crop step; the plugin has no
      // option to turn that on or off.
      // Tracked so the app lock covers the camera instead of presenting over
      // it, which would close it and leave this promise (and scanningRef)
      // hanging; see lib/system-ui.
      const { scannedImages } = await withSystemUI(
        () => DocumentScanner.scanDocument({ croppedImageQuality: SCAN_QUALITY_MAP[settings.quality] }),
        () => ({ scannedImages: [] as string[] }),
      );
      if (!scannedImages?.length) return null;
      return await saveAndOpen({ pages: scannedImages });
    } catch (err) {
      console.error('Scan failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      // Only alert on real failures, not user-cancelled scans.
      if (/cancel|user.+(stop|dismiss)/i.test(msg)) {
        // user-cancelled, ignore
      } else if (/permission|denied|not.+granted/i.test(msg)) {
        notifyError();
        Alert.alert(
          'Camera access needed',
          'Scan Kit needs Camera permission to scan documents. Open Settings to enable it.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ],
        );
      } else {
        notifyError();
        Alert.alert("Couldn't start the scanner", 'Try again in a moment.');
      }
      return null;
    } finally {
      scanningRef.current = false;
      setScanning(false);
    }
  }, [saveAndOpen]);

  const bumpLastSaved = useCallback(() => setLastSaved(Date.now()), []);

  const value = useMemo(() => ({
    lastSaved,
    scanning,
    saving: saving !== null,
    triggerScan,
    saveAndOpen,
    bumpLastSaved,
  }), [lastSaved, scanning, saving, triggerScan, saveAndOpen, bumpLastSaved]);

  return (
    <ScanContext.Provider value={value}>
      {children}
      {saving !== null && <SavingOverlay pages={saving} />}
    </ScanContext.Provider>
  );
}

/** Blocks input and shows progress while a scan or import is written to disk. */
function SavingOverlay({ pages }: { pages: number }) {
  const { colors } = useTheme();
  return (
    <View style={styles.overlay} accessibilityViewIsModal accessibilityLiveRegion="polite">
      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <ActivityIndicator color={colors.accent} />
        <Text style={[Type.subhead, { color: colors.text }]}>
          {pages > 1 ? `Saving ${pages} pages…` : 'Saving…'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    borderRadius: Radius.lg,
  },
});

export function useScan() {
  const ctx = useContext(ScanContext);
  if (!ctx) throw new Error('useScan must be used within ScanProvider');
  return ctx;
}

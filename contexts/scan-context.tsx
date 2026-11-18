import { createContext, useCallback, useContext, useMemo, useRef, useState, ReactNode } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { PageFilter } from '@/types/document';
import { notifySuccess, notifyError } from '@/lib/haptics';
import { getScanSettings, getDocSettings } from '@/lib/storage';
import { saveScan, indexDocText, type ScanPageInput } from '@/lib/save-scan';
import { autoName } from '@/lib/auto-name';
import { bakePages } from '@/lib/bake';
import { alertScanError, scanPagesWithCamera, takeUncroppedPages, ToolScanError } from '@/lib/tool-scan';
import { noteNewDocument } from '@/lib/new-doc-note';
import { serialized } from '@/lib/serial';
import { useTheme } from '@/contexts/theme-context';
import { Radius, Spacing, Type } from '@/lib/theme';

type SaveInput = {
  /** Image URIs, or photos with their page outline (lib/save-scan.ts). */
  pages?: ScanPageInput[];
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
  /**
   * Saves imported pages or a PDF, returning the new document id — or null on
   * failure. Waits for a save already in progress first (never fails because
   * of it).
   */
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
  // Saves run one at a time, in the order they were asked for. A save asked
  // for while another is still writing (a file opened with "Open in Scan Kit"
  // while a scan is being saved) WAITS for it instead of failing: the incoming
  // file is the only copy the user handed over. Double taps can't queue a
  // duplicate: every caller ignores taps while its own call is running.
  // (saveNow never rejects: failures resolve null after telling the user.)

  const saveNow = useCallback(async (input: SaveInput): Promise<string | null> => {
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
      // The viewer greets the new document: "Saved as …" with Rename, or Crop
      // for a photo whose page edges weren't found (lib/new-doc-note).
      noteNewDocument(id, { uncropped: takeUncroppedPages(input.pages ?? []) });
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
      setSaving(null);
    }
  }, []);

  const saveAndOpen = useMemo(() => serialized(saveNow), [saveNow]);

  const triggerScan = useCallback(async (): Promise<string | null> => {
    if (scanningRef.current) return null;
    scanningRef.current = true;
    setScanning(true);
    try {
      // Scan Kit's camera (with its own review step) or Apple's document
      // scanner, as chosen in Settings › Scan (lib/tool-scan.ts). Either way
      // the app lock can't close the camera from under this promise.
      const pages = await scanPagesWithCamera();
      if (!pages?.length) return null;
      return await saveAndOpen({ pages });
    } catch (err) {
      if (err instanceof ToolScanError) {
        notifyError();
        alertScanError(err);
      } else {
        console.error('Scan failed', err);
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

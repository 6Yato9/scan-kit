import { createContext, useCallback, useContext, useMemo, useRef, useState, ReactNode } from 'react';
import { Alert, Linking } from 'react-native';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { PageFilter } from '@/types/document';
import { notifySuccess, notifyError } from '@/lib/haptics';
import { getScanSettings, getDocSettings } from '@/lib/storage';
import { saveScan, indexDocText } from '@/lib/save-scan';
import { autoName } from '@/lib/auto-name';
import { bakePage } from '@/lib/bake';

type SaveInput = {
  pages?: string[];
  pdfUri?: string;
  defaultFilter?: PageFilter | 'original';
};

type ScanContextType = {
  lastSaved: number;
  scanning: boolean;
  /** Scans, saves, and returns the new document id — or null if cancelled or failed. */
  triggerScan: () => Promise<string | null>;
  /** Saves imported pages or a PDF, returning the new document id — or null on failure. */
  saveAndOpen: (input: SaveInput) => Promise<string | null>;
  bumpLastSaved: () => void;
};

const QUALITY_MAP = { low: 0.5, medium: 0.75, high: 0.9 } as const;
const SCAN_QUALITY_MAP = { low: 50, medium: 75, high: 90 } as const;

const ScanContext = createContext<ScanContextType | null>(null);

export function ScanProvider({ children }: { children: ReactNode }) {
  const [lastSaved, setLastSaved] = useState(0);
  const [scanning, setScanning] = useState(false);
  const scanningRef = useRef(false);

  const saveAndOpen = useCallback(async (input: SaveInput): Promise<string | null> => {
    const [scan, docSettings] = await Promise.all([getScanSettings(), getDocSettings()]);
    const filter = input.defaultFilter ?? scan.defaultFilter;
    const count = input.pages?.length ?? 0;
    try {
      const { id, pages } = await saveScan({
        pages: input.pages,
        pdfUri: input.pdfUri,
        name: autoName(new Date(), docSettings.namePrefix),
        quality: QUALITY_MAP[scan.quality],
        filters: input.pages ? Array.from({ length: count }, () => filter) : undefined,
      });
      setLastSaved(Date.now());
      notifySuccess();
      if (pages.length) indexDocText(id, pages).catch(() => {});
      // Bake the default filter into each page's pixels, fire-and-forget so the
      // caller isn't blocked on it. Sequential — the baker (a single off-screen
      // WebView) handles one job at a time, and a large scan must not flood the
      // queue. A page that fails to bake just keeps its raw pixels and no
      // recorded filter, which is a consistent state, so per-page errors are
      // swallowed and the loop continues.
      (async () => {
        for (let i = 0; i < pages.length; i++) {
          if (filter === 'original') continue;
          try {
            await bakePage(id, i, filter, undefined);
          } catch (err) {
            console.error('Bake failed for new page', i, err);
          }
        }
      })().catch(() => {});
      return id;
    } catch (err) {
      console.error('Save failed', err);
      notifyError();
      const msg = err instanceof Error ? err.message : 'Could not save the scan.';
      Alert.alert('Save failed', msg);
      return null;
    }
  }, []);

  const triggerScan = useCallback(async (): Promise<string | null> => {
    if (scanningRef.current) return null;
    scanningRef.current = true;
    setScanning(true);
    try {
      const settings = await getScanSettings();
      const { scannedImages } = await DocumentScanner.scanDocument({
        croppedImageQuality: SCAN_QUALITY_MAP[settings.quality],
        letUserAdjustCrop: settings.autoCrop,
      } as any);
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
        Alert.alert('Scan failed', 'Could not start the scanner. Try again.');
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
    triggerScan,
    saveAndOpen,
    bumpLastSaved,
  }), [lastSaved, scanning, triggerScan, saveAndOpen, bumpLastSaved]);

  return (
    <ScanContext.Provider value={value}>
      {children}
    </ScanContext.Provider>
  );
}

export function useScan() {
  const ctx = useContext(ScanContext);
  if (!ctx) throw new Error('useScan must be used within ScanProvider');
  return ctx;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { Alert, AppState, AppStateStatus, Linking } from 'react-native';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { File } from 'expo-file-system';
import { PageFilter } from '@/types/document';
import {
  clearPendingState,
  getPendingState,
  getScanSettings,
  setPendingState,
  type PendingState,
} from '@/lib/storage';

type ScanContextType = {
  pendingPages: string[];
  pendingPdfUri: string | null;
  pendingQuality: number;
  pendingDefaultFilter: PageFilter | 'original';
  reviewVisible: boolean;
  lastSaved: number;
  triggerScan: () => Promise<void>;
  openImport: (pages: string[], defaultFilter?: PageFilter | 'original') => Promise<void>;
  openPdfImport: (uri: string) => Promise<void>;
  clearPending: () => void;
  bumpLastSaved: () => void;
};

const QUALITY_MAP = { low: 0.5, medium: 0.75, high: 0.9 } as const;
const SCAN_QUALITY_MAP = { low: 50, medium: 75, high: 90 } as const;

const ScanContext = createContext<ScanContextType | null>(null);

export function ScanProvider({ children }: { children: ReactNode }) {
  const [pendingPages, setPendingPages] = useState<string[]>([]);
  const [pendingPdfUri, setPendingPdfUri] = useState<string | null>(null);
  const [pendingQuality, setPendingQuality] = useState<number>(0.9);
  const [pendingDefaultFilter, setPendingDefaultFilter] = useState<PageFilter | 'original'>('original');
  const [reviewVisible, setReviewVisible] = useState(false);
  const [lastSaved, setLastSaved] = useState(0);
  const scanningRef = useRef(false);

  // Track latest state for the AppState listener so it never sees stale values.
  const latestRef = useRef<PendingState>({
    pages: [],
    pdfUri: null,
    quality: 0.9,
    defaultFilter: 'original',
    reviewVisible: false,
  });
  useEffect(() => {
    latestRef.current = {
      pages: pendingPages,
      pdfUri: pendingPdfUri,
      quality: pendingQuality,
      defaultFilter: pendingDefaultFilter,
      reviewVisible,
    };
  }, [pendingPages, pendingPdfUri, pendingQuality, pendingDefaultFilter, reviewVisible]);

  // Restore a pending review on mount if files are still present.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await getPendingState();
        if (cancelled || !saved || !saved.reviewVisible) return;
        const candidates = [...saved.pages, ...(saved.pdfUri ? [saved.pdfUri] : [])];
        const anyExists = candidates.some(uri => {
          try {
            return new File(uri).exists;
          } catch {
            return false;
          }
        });
        if (!anyExists) {
          try { await clearPendingState(); } catch (err) { console.warn('clearPendingState failed', err); }
          return;
        }
        setPendingPages(saved.pages);
        setPendingPdfUri(saved.pdfUri);
        setPendingQuality(saved.quality);
        setPendingDefaultFilter(saved.defaultFilter);
        setReviewVisible(true);
      } catch (err) {
        console.warn('Failed to restore pending review state', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist pending review state on background/inactive so iOS killing JS
  // doesn't silently drop in-progress scans.
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next !== 'background' && next !== 'inactive') return;
      const s = latestRef.current;
      (async () => {
        try {
          if (s.reviewVisible) {
            await setPendingState({
              pages: s.pages,
              pdfUri: s.pdfUri,
              quality: s.quality,
              defaultFilter: s.defaultFilter,
              reviewVisible: true,
            });
          } else {
            await clearPendingState();
          }
        } catch (err) {
          console.warn('Failed to persist pending review state', err);
        }
      })();
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, []);

  const triggerScan = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    try {
      const settings = await getScanSettings();
      const { scannedImages } = await DocumentScanner.scanDocument({
        croppedImageQuality: SCAN_QUALITY_MAP[settings.quality],
        letUserAdjustCrop: settings.autoCrop,
      } as any);
      if (!scannedImages?.length) return;
      setPendingPages(scannedImages);
      setPendingPdfUri(null);
      setPendingQuality(QUALITY_MAP[settings.quality]);
      setPendingDefaultFilter(settings.defaultFilter);
      setReviewVisible(true);
    } catch (err) {
      console.error('Scan failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      // Only alert on real failures, not user-cancelled scans.
      if (/cancel|user.+(stop|dismiss)/i.test(msg)) {
        // user-cancelled, ignore
      } else if (/permission|denied|not.+granted/i.test(msg)) {
        Alert.alert(
          'Camera access needed',
          'Scan Kit needs Camera permission to scan documents. Open Settings to enable it.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ],
        );
      } else {
        Alert.alert('Scan failed', 'Could not start the scanner. Try again.');
      }
    } finally {
      scanningRef.current = false;
    }
  }, []);

  const openImport = useCallback(async (pages: string[], defaultFilter?: PageFilter | 'original') => {
    try {
      const settings = await getScanSettings();
      setPendingPages(pages);
      setPendingPdfUri(null);
      setPendingQuality(QUALITY_MAP[settings.quality]);
      setPendingDefaultFilter(defaultFilter ?? 'original');
      setReviewVisible(true);
    } catch (err) {
      console.error('Import failed', err);
    }
  }, []);

  const openPdfImport = useCallback(async (uri: string) => {
    try {
      const settings = await getScanSettings();
      setPendingPages([]);
      setPendingPdfUri(uri);
      setPendingQuality(QUALITY_MAP[settings.quality]);
      setPendingDefaultFilter('original');
      setReviewVisible(true);
    } catch (err) {
      console.error('PDF import failed', err);
    }
  }, []);

  const clearPending = useCallback(() => {
    setPendingPages([]);
    setPendingPdfUri(null);
    setReviewVisible(false);
    clearPendingState().catch(err => console.warn('clearPendingState failed', err));
  }, []);

  const bumpLastSaved = useCallback(() => setLastSaved(Date.now()), []);

  const value = useMemo(() => ({
    pendingPages,
    pendingPdfUri,
    pendingQuality,
    pendingDefaultFilter,
    reviewVisible,
    lastSaved,
    triggerScan,
    openImport,
    openPdfImport,
    clearPending,
    bumpLastSaved,
  }), [pendingPages, pendingPdfUri, pendingQuality, pendingDefaultFilter, reviewVisible, lastSaved, triggerScan, openImport, openPdfImport, clearPending, bumpLastSaved]);

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

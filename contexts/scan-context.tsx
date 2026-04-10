import { createContext, useCallback, useContext, useState, ReactNode } from 'react';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { PageFilter } from '@/types/document';
import { getScanSettings } from '@/lib/storage';

type ScanContextType = {
  pendingPages: string[];
  pendingPdfUri: string | null;
  pendingQuality: number;
  pendingDefaultFilter: PageFilter | 'original';
  nameSheetVisible: boolean;
  lastSaved: number;
  triggerScan: () => Promise<void>;
  openImport: (pages: string[]) => Promise<void>;
  openPdfImport: (uri: string) => void;
  clearPending: () => void;
  bumpLastSaved: () => void;
};

const ScanContext = createContext<ScanContextType | null>(null);

export function ScanProvider({ children }: { children: ReactNode }) {
  const [pendingPages, setPendingPages] = useState<string[]>([]);
  const [pendingPdfUri, setPendingPdfUri] = useState<string | null>(null);
  const [pendingQuality, setPendingQuality] = useState<number>(0.9);
  const [pendingDefaultFilter, setPendingDefaultFilter] = useState<PageFilter | 'original'>('original');
  const [nameSheetVisible, setNameSheetVisible] = useState(false);
  const [lastSaved, setLastSaved] = useState(0);

  const qualityMap = { low: 0.5, medium: 0.75, high: 0.9 } as const;

  const triggerScan = useCallback(async () => {
    try {
      const settings = await getScanSettings();
      const { scannedImages } = await DocumentScanner.scanDocument({
        letUserAdjustCrop: settings.autoCrop,
      });
      if (!scannedImages?.length) return;
      setPendingPages(scannedImages);
      setPendingPdfUri(null);
      setPendingQuality(qualityMap[settings.quality]);
      setPendingDefaultFilter(settings.defaultFilter);
      setNameSheetVisible(true);
    } catch (err) {
      console.error('Scan failed', err);
    }
  }, []);

  const openImport = useCallback(async (pages: string[]) => {
    const settings = await getScanSettings();
    setPendingPages(pages);
    setPendingPdfUri(null);
    setPendingQuality(qualityMap[settings.quality]);
    setPendingDefaultFilter('original');
    setNameSheetVisible(true);
  }, []);

  const openPdfImport = useCallback((uri: string) => {
    setPendingPages([]);
    setPendingPdfUri(uri);
    setPendingQuality(0.9);
    setPendingDefaultFilter('original');
    setNameSheetVisible(true);
  }, []);

  const clearPending = useCallback(() => {
    setPendingPages([]);
    setPendingPdfUri(null);
    setNameSheetVisible(false);
  }, []);

  const bumpLastSaved = useCallback(() => setLastSaved(Date.now()), []);

  return (
    <ScanContext.Provider
      value={{
        pendingPages,
        pendingPdfUri,
        pendingQuality,
        pendingDefaultFilter,
        nameSheetVisible,
        lastSaved,
        triggerScan,
        openImport,
        openPdfImport,
        clearPending,
        bumpLastSaved,
      }}
    >
      {children}
    </ScanContext.Provider>
  );
}

export function useScan() {
  const ctx = useContext(ScanContext);
  if (!ctx) throw new Error('useScan must be used within ScanProvider');
  return ctx;
}

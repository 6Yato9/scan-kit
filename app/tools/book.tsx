// app/tools/book.tsx
// Photograph open book spreads; each spread is split down the middle into its
// left and right page and saved as one document (all captures, in order).
// With Scan Kit's camera each half keeps the photo, split down the page's
// true middle in perspective (lib/capture-session.ts splitSpread), so either
// page can be re-cropped later.
//
// Round 16: reading order (remembered in lib/tool-prefs.ts). Left to right
// (the default, as before) keeps each spread's left page first; right to left
// (Arabic, Hebrew, Persian and Urdu books, manga) puts its right page first.
import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useScan } from '@/contexts/scan-context';
import { PrimaryButton } from '@/components/primary-button';
import { Segmented, ToolIntro, ToolNote, ToolScreen } from '@/components/tool-ui';
import { MoreOptions } from '@/components/more-options';
import { SectionLabel } from '@/components/section-label';
import { orderSpread, parseBookPrefs, type ReadingOrder } from '@/lib/book-split';
import { readToolPrefs, TOOL_PREF_KEYS, writeToolPrefs } from '@/lib/tool-prefs';
import { splitSpreads } from '@/lib/book-split';
import { notifyError } from '@/lib/haptics';
import { alertScanError, deleteTempFiles, pickPhotos, scanPagesWithCamera } from '@/lib/tool-scan';
import { geometryOfInput, isSourceInput, type ScanPageInput } from '@/lib/page-source';
import { getImageSize } from '@/lib/image-size';
import { splitSpread, toSourceInput } from '@/lib/capture-session';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { noteNewDocument } from '@/lib/new-doc-note';

export default function BookScreen() {
  const { saveAndOpen } = useScan();
  const router = useRouter();
  const [busy, setBusy] = useState<'camera' | 'photos' | null>(null);
  const busyRef = useRef(false);
  const [order, setOrderState] = useState<ReadingOrder>('ltr');
  const orderRef = useRef(order);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    let live = true;
    readToolPrefs(TOOL_PREF_KEYS.book, parseBookPrefs).then(p => {
      if (!live) return;
      orderRef.current = p.order;
      setOrderState(p.order);
    });
    return () => { live = false; };
  }, []);
  const setOrder = (o: ReadingOrder) => {
    orderRef.current = o;
    setOrderState(o);
    writeToolPrefs(TOOL_PREF_KEYS.book, { order: o }).catch(() => {});
  };

  const run = async (source: 'camera' | 'photos') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(source);
    let temps: string[] = [];
    try {
      let shots: ScanPageInput[] | null;
      try {
        // No auto-crop: page detection would pick one page out of a two-page spread.
        shots = source === 'camera'
          ? await scanPagesWithCamera({ title: 'Book mode', guidance: 'Fit the open book in the frame' })
          : await pickPhotos(true, { autoCrop: false });
      } catch (err) {
        alertScanError(err);
        return;
      }
      if (!shots?.length) return;
      if (source === 'photos') temps.push(...(shots as string[]));

      let pages: ScanPageInput[];
      try {
        pages = [];
        for (const shot of shots) {
          if (isSourceInput(shot)) {
            // A photo and its reviewed crop: split the crop, keep the photo.
            const size = await getImageSize(shot.sourceUri);
            const halves = size ? splitSpread(geometryOfInput(shot), size.width, size.height) : [geometryOfInput(shot)];
            pages.push(...orderSpread(halves.map(g => toSourceInput(shot.sourceUri, g)), orderRef.current));
          } else {
            const split = await splitSpreads([shot]);
            pages.push(...orderSpread(split.pages, orderRef.current));
            temps = temps.concat(split.temps);
          }
        }
      } catch {
        notifyError();
        Alert.alert('Couldn’t split the pages', 'The photo couldn’t be processed. Try again with a clearer shot.');
        return;
      }
      // saveAndOpen copies the pages into storage before it resolves.
      const id = await saveAndOpen({ pages });
      if (id) noteNewDocument(id);
      if (id) navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id } }));
    } finally {
      deleteTempFiles(temps);
      busyRef.current = false;
      setBusy(null);
    }
  };

  return (
    <ToolScreen
      title="Book mode"
      footer={
        <>
          <PrimaryButton
            title="Scan spreads"
            icon="camera-outline"
            onPress={() => run('camera')}
            disabled={busy !== null}
            loading={busy === 'camera'}
          />
          <PrimaryButton
            title="Import photos"
            icon="images-outline"
            variant="secondary"
            onPress={() => run('photos')}
            disabled={busy !== null}
            loading={busy === 'photos'}
          />
        </>
      }
    >
      <ToolIntro
        icon="book-outline"
        title="Scan a book"
        text="Capture an open book one spread at a time. Each spread becomes two pages."
        points={[
          { icon: 'phone-portrait-outline', text: 'Hold the phone level above the open book, with both pages in view.' },
          { icon: 'cut-outline', text: 'Each spread is split down the middle into a left and a right page.' },
          { icon: 'documents-outline', text: 'All spreads are saved, in order, as one document.' },
        ]}
      />
      <View pointerEvents={busy ? 'none' : 'auto'}>
        <MoreOptions open={moreOpen} onToggle={setMoreOpen} changed={order === 'rtl' ? 1 : 0}>
          <SectionLabel>Reading order</SectionLabel>
          <Segmented
            options={[
              { value: 'ltr', label: 'Left to right' },
              { value: 'rtl', label: 'Right to left' },
            ]}
            value={order}
            onChange={setOrder}
          />
          <ToolNote>
            {order === 'rtl'
              ? 'The right page of each spread comes first, for books read right to left (Arabic, Hebrew, Persian, Urdu, manga).'
              : 'The left page of each spread comes first.'}
          </ToolNote>
        </MoreOptions>
      </View>
    </ToolScreen>
  );
}

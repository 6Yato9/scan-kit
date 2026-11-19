// app/tools/id-card.tsx
// Capture the front (and optionally the back) of an ID card and save it as a
// document named "ID card …", in one of two layouts:
// - One page (default): both sides on ONE sheet of the paper size from
//   Document settings, each at the card's real size (85.6 × 53.98 mm), like a
//   photocopy (lib/id-card-sheet.ts, composed in an off-screen canvas). Its
//   text is recognised from the composed page, so search finds both sides.
// - Two pages: each side its own page. Camera captures keep their photo, so
//   either side can be re-cropped later.
import { useEffect, useRef, useState } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import { ActionSheetIOS, Alert, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { AppIcon } from '@/components/app-icon';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { useScan } from '@/contexts/scan-context';
import { PrimaryButton } from '@/components/primary-button';
import { Segmented, SectionRow, ToolNote, ToolScreen } from '@/components/tool-ui';
import { SectionLabel } from '@/components/section-label';
import { LocalWebView } from '@/components/local-webview';
import { saveScan, indexDocText } from '@/lib/save-scan';
import { getDocSettings, getScanSettings } from '@/lib/storage';
import { getImageSize } from '@/lib/image-size';
import { buildIdCardSheetHtml, ID_CARD_SCALES, planIdCardSheet, sheetPaperFor, type IdCardSize, type SheetPaper } from '@/lib/id-card-sheet';
import { MoreOptions } from '@/components/more-options';
import { oneOf, readToolPrefs, TOOL_PREF_KEYS, writeToolPrefs } from '@/lib/tool-prefs';
import { autoName } from '@/lib/auto-name';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { alertScanError, cameraTempUri, deleteTempFiles, pickPhotos, renderSourcePage, scanPagesWithCamera } from '@/lib/tool-scan';
import { inputUri, isSourceInput, type ScanPageInput } from '@/lib/page-source';
import { Radius, Spacing, Type } from '@/lib/theme';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { noteNewDocument } from '@/lib/new-doc-note';

type Side = 'front' | 'back';
/** A captured side: what is saved, and the image shown in its slot. */
type Shot = { page: ScanPageInput; preview: string };

/** Every temp file of a shot (its photo or image, and a rendered preview). */
const shotFiles = (s: Shot | null | undefined) => (s ? [inputUri(s.page), s.preview] : []);

/** The slot image for a captured page: the image itself, or the photo's crop rendered small. */
async function toShot(page: ScanPageInput): Promise<Shot> {
  if (!isSourceInput(page)) return { page, preview: page };
  try {
    return { page, preview: await renderSourcePage(page, 0.8, 1200) };
  } catch {
    return { page, preview: page.sourceUri };
  }
}
const QUALITY = { low: 0.5, medium: 0.75, high: 0.9 } as const;

type Layout = 'one' | 'two';

/**
 * Round 16 options for the one-page layout (remembered in lib/tool-prefs.ts):
 * the paper (null = Document settings, as before) and the card's size on it
 * (real size, as before, or enlarged 150 % for small print).
 */
type IdCardPrefs = { paper: SheetPaper | null; size: IdCardSize };
function parseIdCardPrefs(o: Record<string, unknown>): IdCardPrefs {
  return {
    paper: o.paper === 'A4' || o.paper === 'Letter' ? o.paper : null,
    size: oneOf<IdCardSize>(['actual', 'large'], o.size, 'actual'),
  };
}
const PAPER_OPTIONS: { value: SheetPaper; label: string }[] = [
  { value: 'A4', label: 'A4' },
  { value: 'Letter', label: 'US Letter' },
];
const SIZE_OPTIONS: { value: IdCardSize; label: string }[] = [
  { value: 'actual', label: 'Real size' },
  { value: 'large', label: 'Enlarged 150%' },
];
const LAYOUTS: { value: Layout; label: string }[] = [
  { value: 'one', label: 'One page' },
  { value: 'two', label: 'Two pages' },
];
/** The composing canvas gets this long before the save gives up. */
const COMPOSE_TIMEOUT_MS = 30_000;

function chooseSource(title: string): Promise<'camera' | 'photos' | null> {
  return new Promise(resolve => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title, options: ['Scan with camera', 'Choose photo', 'Cancel'], cancelButtonIndex: 2 },
        i => resolve(i === 0 ? 'camera' : i === 1 ? 'photos' : null),
      );
    } else {
      Alert.alert(title, undefined, [
        { text: 'Scan with camera', onPress: () => resolve('camera') },
        { text: 'Choose photo', onPress: () => resolve('photos') },
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
      ]);
    }
  });
}

export default function IdCardScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { bumpLastSaved } = useScan();
  const [front, setFront] = useState<Shot | null>(null);
  const [back, setBack] = useState<Shot | null>(null);
  const [saving, setSaving] = useState(false);
  const [layout, setLayout] = useState<Layout>('one');
  // Document settings' paper, used unless More options chose one.
  const [docPaper, setDocPaper] = useState<SheetPaper>('A4');
  const [prefs, setPrefsState] = useState<IdCardPrefs>({ paper: null, size: 'actual' });
  const prefsRef = useRef(prefs);
  const [moreOpen, setMoreOpen] = useState(false);
  const paperLabel: SheetPaper = prefs.paper ?? docPaper;
  const setPrefs = (patch: Partial<IdCardPrefs>) => {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    setPrefsState(next);
    writeToolPrefs(TOOL_PREF_KEYS.idCard, next).catch(() => {});
  };
  // The off-screen canvas composing the one-page sheet, while it runs.
  const [compose, setCompose] = useState<{ html: string; key: number } | null>(null);
  const composeWait = useRef<{ resolve: (dataUrl: string) => void; reject: (err: Error) => void } | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    getDocSettings().then(s => setDocPaper(sheetPaperFor(s.pdfPageSize))).catch(() => {});
    readToolPrefs(TOOL_PREF_KEYS.idCard, parseIdCardPrefs).then(p => {
      prefsRef.current = p;
      setPrefsState(p);
    });
  }, []);
  // Captures not saved when the screen closes are temp files: remove them.
  const shotsRef = useRef<(Shot | null)[]>([]);
  shotsRef.current = [front, back];
  useEffect(() => () => { deleteTempFiles(shotsRef.current.flatMap(shotFiles)); }, []);

  const capture = async (side: Side) => {
    if (busy.current) return;
    const source = await chooseSource(side === 'front' ? 'Front of card' : 'Back of card');
    if (!source) return;
    busy.current = true;
    try {
      let pages: ScanPageInput[] | null;
      try {
        pages = source === 'camera'
          ? await scanPagesWithCamera({
            title: side === 'front' ? 'ID card' : 'Back of card',
            guidance: side === 'front' ? 'Fit the front of the card in the frame' : 'Fit the back of the card in the frame',
            // Scanning the front, a second capture is taken as the back.
            maxPages: side === 'front' ? 2 : 1,
          })
          : await pickPhotos(false);
      } catch (err) {
        alertScanError(err);
        return;
      }
      if (!pages?.length) return;
      const shots: Shot[] = [];
      for (const p of pages.slice(0, side === 'front' ? 2 : 1)) shots.push(await toShot(p));
      deleteTempFiles(pages.slice(side === 'front' ? 2 : 1).map(inputUri));
      if (side === 'front') {
        deleteTempFiles([...shotFiles(front), ...(shots[1] ? shotFiles(back) : [])]);
        setFront(shots[0]);
        if (shots[1]) setBack(shots[1]);
      } else {
        deleteTempFiles(shotFiles(back));
        setBack(shots[0]);
      }
    } finally {
      busy.current = false;
    }
  };

  /** Draws `srcs` into the sheet in the off-screen canvas; resolves with its JPEG data URL. */
  const composeSheet = (html: string) => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      composeWait.current = null;
      setCompose(null);
      reject(new Error('compose timed out'));
    }, COMPOSE_TIMEOUT_MS);
    composeWait.current = {
      resolve: url => { clearTimeout(timer); resolve(url); },
      reject: err => { clearTimeout(timer); reject(err); },
    };
    setCompose({ html, key: Date.now() });
  });

  const onComposeMessage = (e: { nativeEvent: { data: string } }) => {
    const wait = composeWait.current;
    composeWait.current = null;
    setCompose(null);
    const data = e.nativeEvent.data;
    if (!wait) return;
    if (data.startsWith('data:image/jpeg')) wait.resolve(data);
    else wait.reject(new Error(data.slice(0, 40)));
  };
  const onComposeFail = () => {
    const wait = composeWait.current;
    composeWait.current = null;
    setCompose(null);
    wait?.reject(new Error('compose failed'));
  };

  /** Both sides on one sheet at real size (lib/id-card-sheet.ts), as a temp JPEG. */
  const buildSheet = async (shots: Shot[]): Promise<{ uri: string; temps: string[] }> => {
    const temps: string[] = [];
    try {
      const srcs: string[] = [];
      for (const s of shots) {
        if (isSourceInput(s.page)) {
          const rendered = await renderSourcePage(s.page, 0.92);
          temps.push(rendered);
          srcs.push(rendered);
        } else {
          srcs.push(s.page);
        }
      }
      const sizes = [];
      for (const src of srcs) sizes.push((await getImageSize(src)) ?? { width: 856, height: 540 });
      const docSettings = await getDocSettings().catch(() => null);
      const chosen = prefsRef.current;
      const plan = planIdCardSheet(
        sizes,
        chosen.paper ?? sheetPaperFor(docSettings?.pdfPageSize),
        undefined,
        ID_CARD_SCALES[chosen.size],
      );
      const dataUrl = await composeSheet(buildIdCardSheetHtml(srcs.map(u => u.split('?')[0]), plan));
      const out = cameraTempUri('id-sheet');
      temps.push(out);
      await FileSystem.writeAsStringAsync(out, dataUrl.slice(dataUrl.indexOf(',') + 1), { encoding: 'base64' });
      return { uri: out, temps };
    } catch (err) {
      deleteTempFiles(temps);
      throw err;
    }
  };

  const save = async () => {
    if (!front || saving) return;
    setSaving(true);
    let temps: string[] = [];
    try {
      const settings = await getScanSettings();
      const shots = back ? [front, back] : [front];
      let pages: ScanPageInput[] = shots.map(s => s.page);
      if (layout === 'one') {
        const sheet = await buildSheet(shots);
        temps = sheet.temps;
        pages = [sheet.uri];
      }
      const { id, pages: stored } = await saveScan({
        pages,
        name: autoName(new Date(), 'ID card'),
        quality: QUALITY[settings.quality],
      });
      deleteTempFiles([...shots.flatMap(shotFiles), ...temps]);
      bumpLastSaved();
      indexDocText(id, stored).catch(() => {});
      notifySuccess();
      // Said by the viewer (it covers the app-wide toast host): "Saved as …".
      noteNewDocument(id);
      navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id } }));
    } catch {
      deleteTempFiles(temps);
      notifyError();
      Alert.alert(
        'Couldn’t save the ID card',
        layout === 'one'
          ? 'The page couldn’t be put together. Try again, or choose Two pages.'
          : 'There may not be enough storage space. Try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  const slot = (side: Side, shot: Shot | null) => {
    const uri = shot?.preview ?? null;
    return (
      <>
        <SectionRow
          label={side === 'front' ? 'Front' : 'Back (optional)'}
          action={uri ? 'Retake' : undefined}
          onAction={() => capture(side)}
        />
        <Pressable
          onPress={() => capture(side)}
          accessibilityRole="button"
          accessibilityLabel={uri ? `Retake ${side}` : `Add ${side} of card`}
          style={({ pressed }) => [
            styles.slot,
            { backgroundColor: colors.card, borderColor: uri ? colors.card : colors.ring },
            !uri && styles.dashed,
            pressed && { opacity: 0.7 },
          ]}
        >
          {uri ? (
            <Image source={{ uri }} style={styles.preview} resizeMode="contain" />
          ) : (
            <View style={styles.placeholder}>
              <View style={[styles.addIcon, { backgroundColor: colors.accentLight }]}>
                <AppIcon name="id-card" size={26} color={colors.accent} />
              </View>
              <Text style={[Type.subhead, { color: colors.accent }]}>
                {side === 'front' ? 'Add front' : 'Add back'}
              </Text>
            </View>
          )}
        </Pressable>
      </>
    );
  };

  return (
    <ToolScreen
      title="ID card"
      footer={
        <PrimaryButton
          title={back ? 'Save both sides' : 'Save ID card'}
          onPress={save}
          disabled={!front}
          loading={saving}
        />
      }
    >
      <SectionLabel>Layout</SectionLabel>
      <Segmented options={LAYOUTS} value={layout} onChange={setLayout} />
      {slot('front', front)}
      {slot('back', back)}
      <ToolNote>
        {layout === 'one'
          ? prefs.size === 'large'
            ? `Both sides go on one ${paperLabel === 'Letter' ? 'US Letter' : 'A4'} page, enlarged to 150% (128 × 81 mm) so small print is easier to read. It stays on this device.`
            : `Both sides go on one ${paperLabel === 'Letter' ? 'US Letter' : 'A4'} page at the card’s real size, 85.6 × 54 mm, ready to print at 100%. It stays on this device.`
          : 'Each side is saved as its own page of one document. It stays on this device.'}
      </ToolNote>
      {layout === 'one' ? (
        <View pointerEvents={saving ? 'none' : 'auto'}>
          <MoreOptions
            open={moreOpen}
            onToggle={setMoreOpen}
            changed={(prefs.paper && prefs.paper !== docPaper ? 1 : 0) + (prefs.size !== 'actual' ? 1 : 0)}
          >
            <SectionLabel>Paper</SectionLabel>
            <Segmented options={PAPER_OPTIONS} value={paperLabel} onChange={v => setPrefs({ paper: v })} />
            <SectionLabel>Card size</SectionLabel>
            <Segmented options={SIZE_OPTIONS} value={prefs.size} onChange={v => setPrefs({ size: v })} />
          </MoreOptions>
        </View>
      ) : null}
      {compose ? (
        <View style={styles.host} pointerEvents="none">
          <LocalWebView
            key={compose.key}
            html={compose.html}
            style={styles.web}
            onMessage={onComposeMessage}
            onError={onComposeFail}
            onContentProcessDidTerminate={onComposeFail}
            javaScriptEnabled
          />
        </View>
      ) : null}
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  // The shape of a real card (ISO/IEC 7810 ID-1, 85.6 × 54 mm), so a capture
  // fills its slot instead of sitting in a band of empty space.
  slot: { width: '100%', aspectRatio: 85.6 / 54, borderRadius: Radius.md, borderWidth: 1.5, overflow: 'hidden' },
  dashed: { borderStyle: 'dashed' },
  preview: { width: '100%', height: '100%' },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm },
  addIcon: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  // Same host trick as Long image: WKWebView only runs its JavaScript when it
  // is really laid out, so it is kept on screen at 1% opacity in a 2pt strip.
  host: { position: 'absolute', top: 0, left: 0, width: 320, height: 2, overflow: 'hidden', opacity: 0.01 },
  web: { width: 320, height: 480 },
});

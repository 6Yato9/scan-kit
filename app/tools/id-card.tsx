// app/tools/id-card.tsx
// Capture the front (and optionally the back) of an ID card and save them as a
// two-page document named "ID card …". Camera captures keep their photo, so
// either side can be re-cropped later.
import { useEffect, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { AppIcon } from '@/components/app-icon';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { useScan } from '@/contexts/scan-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionRow, ToolNote, ToolScreen } from '@/components/tool-ui';
import { saveScan, indexDocText } from '@/lib/save-scan';
import { getScanSettings } from '@/lib/storage';
import { autoName } from '@/lib/auto-name';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { alertScanError, deleteTempFiles, pickPhotos, renderSourcePage, scanPagesWithCamera } from '@/lib/tool-scan';
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
  const busy = useRef(false);
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

  const save = async () => {
    if (!front || saving) return;
    setSaving(true);
    try {
      const settings = await getScanSettings();
      const shots = back ? [front, back] : [front];
      const { id, pages: stored } = await saveScan({
        pages: shots.map(s => s.page),
        name: autoName(new Date(), 'ID card'),
        quality: QUALITY[settings.quality],
      });
      deleteTempFiles(shots.flatMap(shotFiles));
      bumpLastSaved();
      indexDocText(id, stored).catch(() => {});
      notifySuccess();
      // Said by the viewer (it covers the app-wide toast host): "Saved as …".
      noteNewDocument(id);
      navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id } }));
    } catch {
      notifyError();
      Alert.alert('Couldn’t save the ID card', 'There may not be enough storage space. Try again.');
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
      {slot('front', front)}
      {slot('back', back)}
      <ToolNote>Both sides are saved together as one document. It stays on this device.</ToolNote>
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
});

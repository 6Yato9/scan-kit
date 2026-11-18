// app/tools/id-card.tsx
// Capture the front (and optionally the back) of an ID card and save them as a
// two-page document named "ID card …".
import { useRef, useState } from 'react';
import { ActionSheetIOS, Alert, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { useScan } from '@/contexts/scan-context';
import { PrimaryButton } from '@/components/primary-button';
import { useToast } from '@/components/toast';
import { SectionRow, ToolNote, ToolScreen } from '@/components/tool-ui';
import { saveScan, indexDocText } from '@/lib/save-scan';
import { getScanSettings } from '@/lib/storage';
import { autoName } from '@/lib/auto-name';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { alertScanError, deleteTempFiles, pickPhotos, scanWithCamera } from '@/lib/tool-scan';
import { Radius, Spacing, Type } from '@/lib/theme';
import { navigateWhenUnlocked } from '@/lib/nav-guard';

type Side = 'front' | 'back';
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
  const { show } = useToast();
  const { bumpLastSaved } = useScan();
  const [front, setFront] = useState<string | null>(null);
  const [back, setBack] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);

  const capture = async (side: Side) => {
    if (busy.current) return;
    const source = await chooseSource(side === 'front' ? 'Front of card' : 'Back of card');
    if (!source) return;
    busy.current = true;
    try {
      let shots: string[] | null;
      try {
        shots = source === 'camera' ? await scanWithCamera() : await pickPhotos(false);
      } catch (err) {
        alertScanError(err);
        return;
      }
      if (!shots?.length) return;
      // The scanner can return several captures in one session: when scanning
      // the front, a second capture is taken as the back.
      if (side === 'front') {
        deleteTempFiles([front, shots[1] ? back : null]);
        setFront(shots[0]);
        if (shots[1]) setBack(shots[1]);
      } else {
        deleteTempFiles([back]);
        setBack(shots[0]);
      }
      deleteTempFiles(shots.slice(side === 'front' ? 2 : 1));
    } finally {
      busy.current = false;
    }
  };

  const save = async () => {
    if (!front || saving) return;
    setSaving(true);
    try {
      const settings = await getScanSettings();
      const pages = back ? [front, back] : [front];
      const { id, pages: stored } = await saveScan({
        pages,
        name: autoName(new Date(), 'ID card'),
        quality: QUALITY[settings.quality],
      });
      deleteTempFiles(pages);
      bumpLastSaved();
      indexDocText(id, stored).catch(() => {});
      notifySuccess();
      show('ID card saved');
      navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id } }));
    } catch {
      notifyError();
      Alert.alert('Couldn’t save the ID card', 'There may not be enough storage space. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const slot = (side: Side, uri: string | null) => (
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
              <Ionicons name="id-card-outline" size={26} color={colors.accent} />
            </View>
            <Text style={[Type.subhead, { color: colors.accent }]}>
              {side === 'front' ? 'Add front' : 'Add back'}
            </Text>
          </View>
        )}
      </Pressable>
    </>
  );

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
  slot: { height: 190, borderRadius: Radius.md, borderWidth: 1.5, overflow: 'hidden' },
  dashed: { borderStyle: 'dashed' },
  preview: { width: '100%', height: '100%' },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm },
  addIcon: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
});

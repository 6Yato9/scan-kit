// app/tools/id-card.tsx
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import DocumentScanner from 'react-native-document-scanner-plugin';
import * as Crypto from 'expo-crypto';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { copyPageWithQuality } from '@/lib/files';
import { saveDocument } from '@/lib/storage';
import { autoName } from '@/lib/auto-name';

export default function IdCardScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const [frontUri, setFrontUri] = useState<string | null>(null);
  const [backUri, setBackUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const scanSide = async (side: 'front' | 'back') => {
    try {
      const { scannedImages } = await DocumentScanner.scanDocument({ letUserAdjustCrop: true } as any);
      if (!scannedImages?.length) return;
      if (side === 'front') setFrontUri(scannedImages[0]);
      else setBackUri(scannedImages[0]);
    } catch {
      Alert.alert('Scan failed', 'Could not open scanner. Make sure you are using the dev build.');
    }
  };

  const handleSave = async () => {
    if (!frontUri) return;
    setSaving(true);
    try {
      const id = Crypto.randomUUID();
      const now = Date.now();
      const uris = backUri ? [frontUri, backUri] : [frontUri];
      const pages = await Promise.all(
        uris.map((uri, i) => copyPageWithQuality(uri, id, i, 0.9))
      );
      await saveDocument({
        id,
        name: `ID Card ${autoName().replace('Scan ', '')}`,
        pages,
        createdAt: now,
        updatedAt: now,
      });
      Alert.alert('Saved', 'ID card saved to your documents.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch {
      Alert.alert('Error', 'Could not save the ID card.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.bg }]}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24 }]}
    >
      {/* Header */}
      <View style={[styles.topBar, { top: insets.top }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>ID Card</Text>
        <View style={{ width: 32 }} />
      </View>

      <Text style={[styles.desc, { color: colors.muted }]}>
        Scan the front and back of your ID card. Both sides will be saved as a single 2-page document.
      </Text>

      {/* Front */}
      <Text style={[styles.sideLabel, { color: colors.muted }]}>FRONT</Text>
      <Pressable
        style={[styles.scanSlot, { backgroundColor: colors.card, borderColor: frontUri ? colors.accent : colors.border }]}
        onPress={() => scanSide('front')}
      >
        {frontUri ? (
          <Image source={{ uri: frontUri }} style={styles.preview} resizeMode="contain" />
        ) : (
          <View style={styles.slotPlaceholder}>
            <Ionicons name="card-outline" size={36} color={colors.muted} />
            <Text style={[styles.slotHint, { color: colors.muted }]}>Tap to scan front</Text>
          </View>
        )}
      </Pressable>
      {frontUri && (
        <Pressable onPress={() => scanSide('front')} style={styles.rescanLink}>
          <Text style={[styles.rescanText, { color: colors.accent }]}>Rescan front</Text>
        </Pressable>
      )}

      {/* Back */}
      <Text style={[styles.sideLabel, { color: colors.muted, marginTop: 20 }]}>BACK (optional)</Text>
      <Pressable
        style={[styles.scanSlot, { backgroundColor: colors.card, borderColor: backUri ? colors.accent : colors.border }]}
        onPress={() => scanSide('back')}
      >
        {backUri ? (
          <Image source={{ uri: backUri }} style={styles.preview} resizeMode="contain" />
        ) : (
          <View style={styles.slotPlaceholder}>
            <Ionicons name="card-outline" size={36} color={colors.muted} />
            <Text style={[styles.slotHint, { color: colors.muted }]}>Tap to scan back</Text>
          </View>
        )}
      </Pressable>
      {backUri && (
        <Pressable onPress={() => scanSide('back')} style={styles.rescanLink}>
          <Text style={[styles.rescanText, { color: colors.accent }]}>Rescan back</Text>
        </Pressable>
      )}

      {/* Save */}
      {frontUri && (
        <Pressable
          style={[styles.saveBtn, { backgroundColor: colors.accent, opacity: saving ? 0.6 : 1 }]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.saveBtnText}>Save ID Card</Text>
          }
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20 },
  topBar: {
    position: 'absolute',
    left: 0, right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 17, fontWeight: '700' },
  desc: { fontSize: 14, lineHeight: 20, marginBottom: 24 },
  sideLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 },
  scanSlot: {
    borderRadius: 12,
    borderWidth: 1.5,
    height: 180,
    overflow: 'hidden',
  },
  slotPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  slotHint: { fontSize: 14 },
  preview: { width: '100%', height: '100%' },
  rescanLink: { alignSelf: 'flex-end', marginTop: 6 },
  rescanText: { fontSize: 13 },
  saveBtn: {
    marginTop: 32,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});

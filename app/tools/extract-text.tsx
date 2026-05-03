// app/tools/extract-text.tsx
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { useTheme } from '@/contexts/theme-context';
import { getScanSettings } from '@/lib/storage';

let TextRecognition: { recognize: (uri: string) => Promise<{ text: string }> } | null = null;
try {
  TextRecognition = require('@react-native-ml-kit/text-recognition').default;
} catch {
  TextRecognition = null;
}

export default function ExtractTextScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const busyRef = useRef(false);

  const runScanAndOcr = async () => {
    if (busyRef.current) return;
    if (!TextRecognition) {
      Alert.alert(
        'OCR not available',
        'Rebuild your dev client after installing @react-native-ml-kit/text-recognition.'
      );
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const settings = await getScanSettings();
      const { scannedImages } = await DocumentScanner.scanDocument({
        croppedImageQuality: 90,
        maxNumDocuments: 1,
        letUserAdjustCrop: settings.autoCrop,
      } as any);
      if (!scannedImages?.length) return;
      const result = await TextRecognition.recognize(scannedImages[0]);
      setText(result.text?.trim() || '');
    } catch {
      Alert.alert('Failed', 'Could not extract text. Please try again.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!text) return;
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', 'Text copied to clipboard.');
  };

  const handleShare = async () => {
    if (!text) return;
    try {
      await Share.share({ message: text });
    } catch {
      // user cancelled
    }
  };

  const reset = () => setText(null);

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Extract Text</Text>
        <View style={styles.iconBtn} />
      </View>

      {text === null ? (
        <View style={styles.body}>
          <View style={[styles.iconWrap, { backgroundColor: '#66BB6A28' }]}>
            <MaterialCommunityIcons name="text-recognition" size={48} color="#66BB6A" />
          </View>
          <Text style={[styles.heading, { color: colors.text }]}>Quick Text Scan</Text>
          <Text style={[styles.sub, { color: colors.faint }]}>
            Point the camera at any page. The text is recognised automatically and ready to copy or share.
          </Text>
          <Pressable
            style={[styles.btn, { opacity: busy ? 0.6 : 1 }]}
            onPress={runScanAndOcr}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <MaterialCommunityIcons name="camera" size={20} color="#fff" />
                <Text style={styles.btnText}>Scan & Extract</Text>
              </>
            )}
          </Pressable>
        </View>
      ) : (
        <View style={styles.resultWrap}>
          <ScrollView
            contentContainerStyle={[styles.resultScroll, { paddingBottom: insets.bottom + 120 }]}
          >
            {text.length === 0 ? (
              <Text style={[styles.empty, { color: colors.faint }]}>No text found on this page.</Text>
            ) : (
              <Text style={[styles.resultText, { color: colors.text }]} selectable>
                {text}
              </Text>
            )}
          </ScrollView>

          <View
            style={[
              styles.actionBar,
              { paddingBottom: insets.bottom + 16, borderTopColor: colors.border, backgroundColor: colors.bg },
            ]}
          >
            <Pressable
              style={[styles.smallBtn, { backgroundColor: colors.card }]}
              onPress={reset}
            >
              <MaterialCommunityIcons name="camera-retake" size={18} color={colors.text} />
              <Text style={[styles.smallBtnText, { color: colors.text }]}>Rescan</Text>
            </Pressable>
            <Pressable
              style={[styles.smallBtn, { backgroundColor: colors.card, opacity: text.length === 0 ? 0.4 : 1 }]}
              onPress={handleCopy}
              disabled={text.length === 0}
            >
              <MaterialCommunityIcons name="content-copy" size={18} color={colors.text} />
              <Text style={[styles.smallBtnText, { color: colors.text }]}>Copy</Text>
            </Pressable>
            <Pressable
              style={[styles.primaryBtn, { opacity: text.length === 0 ? 0.4 : 1 }]}
              onPress={handleShare}
              disabled={text.length === 0}
            >
              <MaterialCommunityIcons name="share-variant" size={18} color="#fff" />
              <Text style={styles.primaryBtnText}>Share</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700' },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  heading: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  sub: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#66BB6A',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 8,
    minWidth: 200,
    justifyContent: 'center',
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  resultWrap: { flex: 1 },
  resultScroll: { padding: 20 },
  resultText: { fontSize: 15, lineHeight: 22 },
  empty: { fontSize: 15, fontStyle: 'italic', textAlign: 'center', marginTop: 40 },
  actionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  smallBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
  },
  smallBtnText: { fontSize: 14, fontWeight: '600' },
  primaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#66BB6A',
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});

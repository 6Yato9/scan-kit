import { useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';

function getImageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

export default function BookScreen() {
  const { openImport } = useScan();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [scanning, setScanning] = useState(false);

  const handleScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const { scannedImages } = await DocumentScanner.scanDocument({
        croppedImageQuality: 90,
        maxNumDocuments: 1,
      });
      if (!scannedImages?.length) return;
      const uri = scannedImages[0];
      const { width, height } = await getImageSize(uri);
      const halfWidth = Math.floor(width / 2);

      const [leftResult, rightResult] = await Promise.all([
        manipulateAsync(
          uri,
          [{ crop: { originX: 0, originY: 0, width: halfWidth, height } }],
          { compress: 0.9, format: SaveFormat.JPEG }
        ),
        manipulateAsync(
          uri,
          [{ crop: { originX: halfWidth, originY: 0, width: width - halfWidth, height } }],
          { compress: 0.9, format: SaveFormat.JPEG }
        ),
      ]);

      await openImport([leftResult.uri, rightResult.uri]);
      router.back();
    } catch {
      Alert.alert('Scan failed', 'Could not process book scan. Please try again.');
    } finally {
      setScanning(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Book Mode</Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.body}>
        <View style={[styles.iconWrap, { backgroundColor: '#FFA72628' }]}>
          <MaterialCommunityIcons name="book-open-page-variant" size={48} color="#FFA726" />
        </View>
        <Text style={[styles.heading, { color: colors.text }]}>Scan a Book Spread</Text>
        <Text style={[styles.sub, { color: colors.faint }]}>
          Point the camera at two open pages. The image is automatically split at the centre into two separate pages.
        </Text>
        <Pressable
          style={[styles.btn, { opacity: scanning ? 0.6 : 1 }]}
          onPress={handleScan}
          disabled={scanning}
        >
          <MaterialCommunityIcons name="camera" size={20} color="#fff" />
          <Text style={styles.btnText}>{scanning ? 'Processing…' : 'Scan Spread'}</Text>
        </Pressable>
      </View>
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
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
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
    backgroundColor: '#FFA726',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 8,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});

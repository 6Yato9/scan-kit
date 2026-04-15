import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';

export default function WhiteboardScreen() {
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
      });
      if (!scannedImages?.length) {
        setScanning(false);
        return;
      }
      await openImport(scannedImages, 'enhanced');
      router.back();
    } catch {
      Alert.alert('Scan failed', 'Could not scan. Please try again.');
      setScanning(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Whiteboard</Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.body}>
        <View style={[styles.iconWrap, { backgroundColor: '#4FC3F728' }]}>
          <MaterialCommunityIcons name="presentation" size={48} color="#4FC3F7" />
        </View>
        <Text style={[styles.heading, { color: colors.text }]}>Scan a Whiteboard</Text>
        <Text style={[styles.sub, { color: colors.faint }]}>
          Enhanced contrast is applied automatically to make whiteboard content crisp and clear.
        </Text>
        <Pressable
          style={[styles.btn, { opacity: scanning ? 0.6 : 1 }]}
          onPress={handleScan}
          disabled={scanning}
        >
          <MaterialCommunityIcons name="camera" size={20} color="#fff" />
          <Text style={styles.btnText}>{scanning ? 'Scanning…' : 'Start Scan'}</Text>
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
    backgroundColor: '#4FC3F7',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 8,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});

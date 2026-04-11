// app/tools/qr.tsx
import { useCallback, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';

type BarcodeResult = {
  type: string;
  data: string;
};

function formatType(type: string): string {
  const map: Record<string, string> = {
    qr: 'QR Code',
    ean13: 'EAN-13',
    ean8: 'EAN-8',
    code128: 'Code 128',
    code39: 'Code 39',
    datamatrix: 'Data Matrix',
    pdf417: 'PDF417',
    aztec: 'Aztec',
    upc_a: 'UPC-A',
    upc_e: 'UPC-E',
    itf14: 'ITF-14',
  };
  return map[type] ?? type.toUpperCase();
}

function isUrl(text: string): boolean {
  return /^https?:\/\//i.test(text) || /^www\./i.test(text);
}

export default function QrScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [result, setResult] = useState<BarcodeResult | null>(null);
  const scanned = useRef(false);

  const handleBarcode = useCallback(({ type, data }: BarcodeResult) => {
    if (scanned.current) return;
    scanned.current = true;
    setResult({ type, data });
  }, []);

  const handleRescan = () => {
    scanned.current = false;
    setResult(null);
  };

  const handleCopy = async () => {
    if (!result) return;
    await Clipboard.setStringAsync(result.data);
    Alert.alert('Copied', 'Result copied to clipboard.');
  };

  const handleOpen = () => {
    if (!result) return;
    const url = isUrl(result.data) && !result.data.startsWith('http')
      ? `https://${result.data}`
      : result.data;
    Linking.openURL(url).catch(() =>
      Alert.alert('Cannot open', 'Could not open this URL.')
    );
  };

  if (!permission) return <View style={[styles.container, { backgroundColor: colors.bg }]} />;

  if (!permission.granted) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: colors.bg, paddingTop: insets.top }]}>
        <Pressable onPress={() => router.back()} style={[styles.backBtn, { top: insets.top + 8 }]}>
          <Ionicons name="close" size={24} color={colors.text} />
        </Pressable>
        <Ionicons name="camera-outline" size={56} color={colors.muted} />
        <Text style={[styles.permTitle, { color: colors.text }]}>Camera Access Needed</Text>
        <Text style={[styles.permSub, { color: colors.muted }]}>Allow camera access to scan QR codes and barcodes.</Text>
        <Pressable style={[styles.permBtn, { backgroundColor: colors.accent }]} onPress={requestPermission}>
          <Text style={styles.permBtnText}>Allow Camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        onBarcodeScanned={result ? undefined : handleBarcode}
        barcodeScannerSettings={{
          barcodeTypes: ['qr', 'ean13', 'ean8', 'code128', 'code39', 'datamatrix', 'pdf417', 'aztec', 'upc_a', 'upc_e', 'itf14'],
        }}
      />

      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.closeBtn}>
          <Ionicons name="close" size={24} color="#fff" />
        </Pressable>
        <Text style={styles.topTitle}>QR / Barcode</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Scan frame */}
      {!result && (
        <View style={styles.frameWrapper}>
          <View style={styles.frame}>
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>
          <Text style={styles.hint}>Align code within the frame</Text>
        </View>
      )}

      {/* Result sheet */}
      {result && (
        <View style={[styles.resultSheet, { backgroundColor: isDark ? '#1c1c1e' : '#fff', paddingBottom: insets.bottom + 16 }]}>
          <Text style={[styles.resultType, { color: colors.muted }]}>{formatType(result.type)}</Text>
          <Text style={[styles.resultData, { color: colors.text }]} numberOfLines={4} selectable>
            {result.data}
          </Text>

          <View style={styles.resultActions}>
            <Pressable style={[styles.actionBtn, { backgroundColor: colors.accent }]} onPress={handleCopy}>
              <Ionicons name="copy-outline" size={18} color="#fff" />
              <Text style={styles.actionBtnText}>Copy</Text>
            </Pressable>

            {isUrl(result.data) && (
              <Pressable style={[styles.actionBtn, { backgroundColor: colors.accent }]} onPress={handleOpen}>
                <Ionicons name="open-outline" size={18} color="#fff" />
                <Text style={styles.actionBtnText}>Open</Text>
              </Pressable>
            )}

            <Pressable style={[styles.actionBtn, { backgroundColor: colors.secondary }]} onPress={handleRescan}>
              <Ionicons name="scan-outline" size={18} color={colors.text} />
              <Text style={[styles.actionBtnText, { color: colors.text }]}>Scan Again</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const CORNER = 24;
const BORDER = 3;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centered: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  topBar: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  closeBtn: { width: 40, alignItems: 'flex-start' },
  topTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  frameWrapper: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20 },
  frame: {
    width: 240,
    height: 240,
    position: 'relative',
  },
  corner: { position: 'absolute', width: CORNER, height: CORNER, borderColor: '#fff', borderRadius: 4 },
  cornerTL: { top: 0, left: 0, borderTopWidth: BORDER, borderLeftWidth: BORDER },
  cornerTR: { top: 0, right: 0, borderTopWidth: BORDER, borderRightWidth: BORDER },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: BORDER, borderLeftWidth: BORDER },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: BORDER, borderRightWidth: BORDER },
  hint: { color: 'rgba(255,255,255,0.7)', fontSize: 13 },
  resultSheet: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 12,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -4 },
    elevation: 20,
  },
  resultType: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  resultData: { fontSize: 15, lineHeight: 22 },
  resultActions: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  actionBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  backBtn: { position: 'absolute', left: 16, zIndex: 10, padding: 8 },
  permTitle: { fontSize: 20, fontWeight: '700', marginTop: 16, marginBottom: 8, textAlign: 'center' },
  permSub: { fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  permBtn: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 14 },
  permBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});

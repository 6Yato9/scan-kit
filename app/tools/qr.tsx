// app/tools/qr.tsx
import { useCallback, useRef, useState } from 'react';
import {
  Alert,
  Linking,
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
import { useToast } from '@/components/toast';
import { ScreenHeader } from '@/components/screen-header';
import { PrimaryButton } from '@/components/primary-button';
import { notifySuccess, tapLight } from '@/lib/haptics';
import { Radius, Spacing, Type } from '@/lib/theme';

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
  const { colors } = useTheme();
  const { show } = useToast();
  const [permission, requestPermission] = useCameraPermissions();
  const [result, setResult] = useState<BarcodeResult | null>(null);
  const scanned = useRef(false);

  const handleBarcode = useCallback(({ type, data }: BarcodeResult) => {
    if (scanned.current) return;
    scanned.current = true;
    notifySuccess();
    setResult({ type, data });
  }, []);

  const handleRescan = () => {
    scanned.current = false;
    setResult(null);
  };

  const handleCopy = async () => {
    if (!result) return;
    await Clipboard.setStringAsync(result.data);
    tapLight();
    show('Copied to clipboard');
  };

  const handleOpen = () => {
    if (!result) return;
    let url = result.data;
    // Normalize www-prefixed URLs.
    if (isUrl(url) && !/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    // QR codes can encode arbitrary URLs including `tel:`, `sms:`, custom deep
    // links, `javascript:`, `itms-services:`, etc. Auto-open only http(s);
    // confirm for low-risk known schemes; reject the rest.
    const safeAutoOpen = /^https?:\/\//i.test(url);
    const requiresConfirm = /^(mailto:|tel:|sms:|geo:|maps:)/i.test(url);

    const openIt = () => {
      Linking.openURL(url).catch(() =>
        Alert.alert('Couldn’t open the link', 'No app on this device can open it.'),
      );
    };

    if (safeAutoOpen) {
      openIt();
      return;
    }
    if (requiresConfirm) {
      Alert.alert(
        'Open this link?',
        url,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open', onPress: openIt },
        ],
      );
      return;
    }
    Alert.alert(
      'Link not opened',
      `For your safety, this kind of link isn’t opened directly. You can copy it instead.\n\n${url}`,
    );
  };

  // The whole QR screen is camera chrome, always dark (the status bar is light
  // here too — see lib/status-bar-style.ts), including the permission step.
  if (!permission) return <View style={[styles.container, { backgroundColor: colors.chrome }]} />;

  if (!permission.granted) {
    // After the user has tapped "Don't Allow" once, the OS won't show the
    // permission dialog again — sending them to Settings is the only path.
    const mustGoToSettings = permission.canAskAgain === false;
    return (
      <View style={[styles.container, { backgroundColor: colors.chrome }]}>
        <ScreenHeader title="QR code" dark onBack={() => router.back()} backIcon="close" />
        <View style={styles.centered}>
          <View style={[styles.permIcon, { backgroundColor: colors.chromeRaised }]}>
            <Ionicons name="camera-outline" size={36} color={colors.chromeAccent} />
          </View>
          <Text style={[Type.title, styles.permTitle, { color: colors.chromeText }]}>Camera access needed</Text>
          <Text style={[Type.callout, styles.permSub, { color: colors.chromeMuted }]}>
            {mustGoToSettings
              ? 'Camera access is turned off. Open Settings to allow it for Scan Kit.'
              : 'Allow camera access to scan QR codes and barcodes.'}
          </Text>
          <PrimaryButton
            title={mustGoToSettings ? 'Open Settings' : 'Allow camera'}
            onPress={mustGoToSettings ? () => Linking.openSettings() : requestPermission}
            style={styles.permBtn}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.chrome }]}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        onBarcodeScanned={result ? undefined : handleBarcode}
        barcodeScannerSettings={{
          barcodeTypes: ['qr', 'ean13', 'ean8', 'code128', 'code39', 'datamatrix', 'pdf417', 'aztec', 'upc_a', 'upc_e', 'itf14'],
        }}
      />

      {/* Top bar: always-dark chrome over the camera feed */}
      <View style={styles.topBar}>
        <ScreenHeader title="QR code" dark onBack={() => router.back()} backIcon="close" />
      </View>

      {/* Scan frame */}
      {!result && (
        <View style={styles.frameWrapper}>
          <View style={styles.frame}>
            <View style={[styles.corner, styles.cornerTL, { borderColor: colors.chromeText }]} />
            <View style={[styles.corner, styles.cornerTR, { borderColor: colors.chromeText }]} />
            <View style={[styles.corner, styles.cornerBL, { borderColor: colors.chromeText }]} />
            <View style={[styles.corner, styles.cornerBR, { borderColor: colors.chromeText }]} />
          </View>
          <Text style={[Type.footnote, { color: colors.chromeText }]}>Point the camera at a QR code or barcode</Text>
        </View>
      )}

      {/* Result sheet */}
      {result && (
        <View style={[styles.resultSheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + Spacing.lg }]}>
          <Text style={[Type.sectionLabel, { color: colors.muted }]}>{formatType(result.type)}</Text>
          <Text style={[Type.body, styles.resultData, { color: colors.text }]} numberOfLines={4} selectable>
            {result.data}
          </Text>

          {isUrl(result.data) ? (
            <PrimaryButton title="Open link" icon="open-outline" onPress={handleOpen} />
          ) : null}
          <View style={styles.resultActions}>
            <PrimaryButton
              title="Copy"
              icon="copy-outline"
              variant={isUrl(result.data) ? 'secondary' : 'primary'}
              onPress={handleCopy}
              style={styles.flex}
            />
            <PrimaryButton
              title="Scan again"
              icon="scan-outline"
              variant="secondary"
              onPress={handleRescan}
              style={styles.flex}
            />
          </View>
        </View>
      )}
    </View>
  );
}

const CORNER = 24;
const BORDER = 3;

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xxxl },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0 },
  frameWrapper: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.xl },
  frame: { width: 240, height: 240, position: 'relative' },
  corner: { position: 'absolute', width: CORNER, height: CORNER, borderRadius: 4 },
  cornerTL: { top: 0, left: 0, borderTopWidth: BORDER, borderLeftWidth: BORDER },
  cornerTR: { top: 0, right: 0, borderTopWidth: BORDER, borderRightWidth: BORDER },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: BORDER, borderLeftWidth: BORDER },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: BORDER, borderRightWidth: BORDER },
  resultSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    padding: Spacing.xl,
    gap: Spacing.md,
  },
  resultData: { lineHeight: 22 },
  resultActions: { flexDirection: 'row', gap: Spacing.md },
  permTitle: { marginTop: Spacing.lg, marginBottom: Spacing.sm, textAlign: 'center' },
  permIcon: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center' },
  permSub: { textAlign: 'center', lineHeight: 21, marginBottom: Spacing.xxl },
  permBtn: { alignSelf: 'stretch' },
});

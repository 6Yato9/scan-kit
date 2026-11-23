// app/tools/qr.tsx
// Read a QR code or barcode with the camera, or from a photo (Vision, on
// device). The content is selectable text with Copy and, for web links, Open.
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
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DarkThemeScope, useTheme } from '@/contexts/theme-context';
import { DocChooserSheet } from '@/components/tool-doc';
import { useToolDocuments } from '@/components/tool-ui';
import { documentReadPages, docReadErrorText } from '@/lib/doc-read';
import type { Document } from '@/types/document';
import { useToast } from '@/components/toast';
import { ScreenHeader } from '@/components/screen-header';
import { PrimaryButton } from '@/components/primary-button';
import { RecognizedText } from '@/components/recognized-text';
import { notifyError, notifySuccess, tapLight } from '@/lib/haptics';
import { HIT, Radius, SHEET_MAX_WIDTH, Spacing, Type } from '@/lib/theme';
import { barcodeTypeLabel, canDetectBarcodes, detectBarcodes, openWebLink } from '@/lib/text-actions';
import { deleteTempFiles, pickPhotos } from '@/lib/tool-scan';

type BarcodeResult = {
  type: string;
  data: string;
};

function formatType(type: string): string {
  return barcodeTypeLabel(type);
}

function isUrl(text: string): boolean {
  return /^https?:\/\//i.test(text) || /^www\./i.test(text);
}

const anyDoc = (d: Document) => d.pages.length > 0 || !!d.pdfUri;

export default function QrScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { show } = useToast();
  const [permission, requestPermission] = useCameraPermissions();
  const [result, setResult] = useState<BarcodeResult | null>(null);
  // Codes found in a chosen photo (several are possible) and which one is shown.
  const [photoCodes, setPhotoCodes] = useState<BarcodeResult[]>([]);
  const [picking, setPicking] = useState(false);
  const scanned = useRef(false);
  const pickingRef = useRef(false);
  // A document already in Scan Kit, read page by page for its codes.
  const { docs } = useToolDocuments(anyDoc);
  const [choosingDoc, setChoosingDoc] = useState(false);
  const [codesFrom, setCodesFrom] = useState<'photo' | 'doc'>('photo');

  const handleBarcode = useCallback(({ type, data }: BarcodeResult) => {
    if (scanned.current) return;
    scanned.current = true;
    notifySuccess();
    setResult({ type, data });
  }, []);

  const handleRescan = () => {
    scanned.current = false;
    setPhotoCodes([]);
    setResult(null);
  };

  const handleChoosePhoto = async () => {
    if (pickingRef.current) return;
    pickingRef.current = true;
    scanned.current = true; // the camera stops reporting while a photo is read
    setPicking(true);
    let picked: string[] | null = null;
    try {
      picked = await pickPhotos(false, { autoCrop: false });
      if (!picked?.length) {
        scanned.current = result !== null;
        return;
      }
      const codes = await detectBarcodes(picked[0]);
      if (!codes.length) {
        scanned.current = result !== null;
        notifyError();
        Alert.alert('No code found', 'Choose a photo where the code is sharp and not too small.');
        return;
      }
      notifySuccess();
      const list = codes.map(c => ({ type: c.symbology, data: c.payload }));
      setCodesFrom('photo');
      setPhotoCodes(list);
      setResult(list[0]);
    } catch {
      scanned.current = result !== null;
      notifyError();
      Alert.alert('Couldn’t read the photo', 'Try another photo.');
    } finally {
      deleteTempFiles(picked ?? []);
      pickingRef.current = false;
      setPicking(false);
    }
  };

  /** Every code on every page of a saved document (the same code twice counts once). */
  const handleDocument = async (doc: Document) => {
    if (pickingRef.current) return;
    pickingRef.current = true;
    scanned.current = true;
    setPicking(true);
    try {
      let pages: string[];
      try {
        pages = await documentReadPages(doc);
      } catch (err) {
        scanned.current = result !== null;
        notifyError();
        const [title, message] = docReadErrorText(err);
        Alert.alert(title, message);
        return;
      }
      const list: BarcodeResult[] = [];
      for (const page of pages) {
        try {
          for (const c of await detectBarcodes(page)) {
            if (!list.some(x => x.data === c.payload && x.type === c.symbology)) list.push({ type: c.symbology, data: c.payload });
          }
        } catch {
          // a page that can't be read has no codes
        }
      }
      if (!list.length) {
        scanned.current = result !== null;
        notifyError();
        Alert.alert('No code found', `There’s no QR code or barcode Scan Kit can read in “${doc.name}”.`);
        return;
      }
      notifySuccess();
      setCodesFrom('doc');
      setPhotoCodes(list);
      setResult(list[0]);
    } finally {
      pickingRef.current = false;
      setPicking(false);
    }
  };

  const photoIndex = result ? photoCodes.indexOf(result) : -1;
  // The result came from a chosen photo (not the camera): "Another photo" instead of "Scan again".
  const fromPhoto = photoIndex >= 0 && codesFrom === 'photo';
  const handleNextCode = () => {
    if (photoCodes.length < 2) return;
    tapLight();
    setResult(photoCodes[(photoIndex + 1) % photoCodes.length]);
  };

  const handleCopy = async () => {
    if (!result) return;
    await Clipboard.setStringAsync(result.data);
    tapLight();
    show('Copied');
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
      // In the in-app browser (a Safari view), like links found in a page's text.
      openWebLink(url).then(ok => {
        if (!ok) Alert.alert('Couldn’t open the link', 'No app on this device can open it.');
      });
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

  function renderResult() {
    if (!result) return null;
    const many = photoCodes.length > 1 && photoIndex >= 0;
    return (
      // Docked at the bottom, as wide as the app's other sheets (centred on an iPad).
      <View style={styles.resultDock} pointerEvents="box-none">
        <View style={[styles.resultSheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + Spacing.lg }]}>
          <View style={styles.resultHead}>
            <Text style={[Type.sectionLabel, styles.flex, { color: colors.muted }]}>
              {many ? `${formatType(result.type)} · ${photoIndex + 1} of ${photoCodes.length}` : formatType(result.type)}
            </Text>
            {many ? (
              <Pressable
                onPress={handleNextCode}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Next code in this photo"
                style={({ pressed }) => [styles.nextBtn, pressed && { opacity: 0.5 }]}
              >
                <Text style={[Type.subhead, { color: colors.accent }]}>Next</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.accent} />
              </Pressable>
            ) : null}
          </View>
          {/* Selectable range by range (touch and hold), not only as a whole. */}
          <RecognizedText value={result.data} onChangeText={() => {}} readOnly maxHeight={132} />

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
              title={fromPhoto ? 'Another photo' : 'Scan again'}
              icon={fromPhoto ? 'images-outline' : 'scan-outline'}
              variant="secondary"
              onPress={fromPhoto ? handleChoosePhoto : handleRescan}
              loading={fromPhoto && picking}
              style={styles.flex}
            />
          </View>
        </View>
      </View>
    );
  }

  // Over the always-dark camera, in the dark look like the screen's other sheets.
  const docSheet = (
    <DarkThemeScope>
      <DocChooserSheet
        visible={choosingDoc}
        docs={docs}
        note="Every QR code and barcode on its pages is read."
        onClose={() => setChoosingDoc(false)}
        onPick={d => { void handleDocument(d); }}
      />
    </DarkThemeScope>
  );

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
            icon={mustGoToSettings ? 'settings-outline' : 'camera-outline'}
            onPress={mustGoToSettings ? () => Linking.openSettings() : requestPermission}
            style={styles.permBtn}
          />
          {canDetectBarcodes() ? (
            <PrimaryButton
              title="Choose photo"
              icon="images-outline"
              variant="secondary"
              onPress={handleChoosePhoto}
              loading={picking}
              disabled={picking}
              style={styles.permSecondary}
            />
          ) : null}
          {canDetectBarcodes() && docs.length ? (
            <PrimaryButton
              title="From a document"
              icon="document-outline"
              variant="secondary"
              onPress={() => setChoosingDoc(true)}
              disabled={picking}
              style={styles.permSecondary}
            />
          ) : null}
        </View>
        {result ? renderResult() : null}
        {docSheet}
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

      {!result && canDetectBarcodes() ? (
        <View style={[styles.photoBar, { paddingBottom: insets.bottom + Spacing.xl }]} pointerEvents="box-none">
          <Pressable
            onPress={handleChoosePhoto}
            disabled={picking}
            accessibilityRole="button"
            accessibilityLabel="Choose photo"
            accessibilityHint="Reads a QR code or barcode from a photo"
            style={({ pressed }) => [
              styles.photoBtn,
              { backgroundColor: colors.chromeRaised, borderColor: colors.chromeBorder },
              (pressed || picking) && { opacity: 0.6 },
            ]}
          >
            <Ionicons name="images-outline" size={20} color={colors.chromeText} />
            <Text style={[Type.subhead, { color: colors.chromeText }]}>{picking ? 'Reading…' : 'Choose photo'}</Text>
          </Pressable>
          {docs.length ? (
            <Pressable
              onPress={() => setChoosingDoc(true)}
              disabled={picking}
              accessibilityRole="button"
              accessibilityLabel="From a document"
              accessibilityHint="Reads the QR codes and barcodes in a saved document"
              style={({ pressed }) => [
                styles.photoBtn,
                { backgroundColor: colors.chromeRaised, borderColor: colors.chromeBorder },
                (pressed || picking) && { opacity: 0.6 },
              ]}
            >
              <Ionicons name="document-outline" size={20} color={colors.chromeText} />
              <Text style={[Type.subhead, { color: colors.chromeText }]}>Document</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {result ? renderResult() : null}
      {docSheet}
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
  resultDock: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center' },
  resultSheet: {
    width: '100%',
    maxWidth: SHEET_MAX_WIDTH,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    padding: Spacing.xl,
    gap: Spacing.md,
  },
  resultHead: { flexDirection: 'row', alignItems: 'center', minHeight: 22 },
  nextBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: HIT, marginVertical: -11 },
  photoBar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', justifyContent: 'center', gap: Spacing.md },
  photoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    minHeight: HIT,
    paddingHorizontal: Spacing.xl,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  permSecondary: { alignSelf: 'stretch', marginTop: Spacing.md },
  resultActions: { flexDirection: 'row', gap: Spacing.md },
  permTitle: { marginTop: Spacing.lg, marginBottom: Spacing.sm, textAlign: 'center' },
  permIcon: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center' },
  permSub: { textAlign: 'center', lineHeight: 21, marginBottom: Spacing.xxl },
  permBtn: { alignSelf: 'stretch' },
});

// app/tools/extract-text.tsx
// Recognise text from a fresh scan or from photos, then copy or share it.
// OCR goes through lib/ocr (Apple Vision on iOS, ML Kit on Android).
import { useRef, useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '@/contexts/theme-context';
import { useToast } from '@/components/toast';
import { PrimaryButton } from '@/components/primary-button';
import { HeaderIconButton } from '@/components/screen-header';
import { ToolIntro, ToolProgress, ToolScreen } from '@/components/tool-ui';
import { notifyError, notifySuccess, tapLight } from '@/lib/haptics';
import { ocrAvailable, recognizeLines } from '@/lib/ocr';
import { alertScanError, deleteTempFiles, pickPhotos, scanWithCamera } from '@/lib/tool-scan';
import { Radius, Spacing, Type } from '@/lib/theme';

export default function ExtractTextScreen() {
  const { colors } = useTheme();
  const { show } = useToast();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [text, setText] = useState<string | null>(null);
  const busyRef = useRef(false);
  const available = ocrAvailable();

  const recognize = async (uris: string[]) => {
    const parts: string[] = [];
    for (let i = 0; i < uris.length; i++) {
      setProgress({ current: i, total: uris.length });
      const { text: t } = await recognizeLines(uris[i]);
      if (t.trim()) parts.push(t.trim());
    }
    setProgress({ current: uris.length, total: uris.length });
    return parts.join('\n\n');
  };

  const run = async (source: 'camera' | 'photos') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    let temp: string[] = [];
    try {
      let uris: string[] | null = null;
      if (source === 'camera') {
        try {
          uris = await scanWithCamera();
        } catch (err) {
          alertScanError(err);
          return;
        }
      } else {
        uris = await pickPhotos(true);
      }
      if (!uris?.length) return;
      temp = uris;
      const result = await recognize(uris);
      setText(result);
      if (result) notifySuccess();
    } catch {
      notifyError();
      Alert.alert('Couldn’t read the text', 'Text recognition failed on this image. Try a sharper, well-lit photo.');
    } finally {
      // Captures and picked photos are temporary copies; nothing is saved.
      deleteTempFiles(temp);
      busyRef.current = false;
      setBusy(false);
      setProgress(null);
    }
  };

  const handleCopy = async () => {
    if (!text) return;
    await Clipboard.setStringAsync(text);
    tapLight();
    show('Text copied');
  };

  const handleShare = async () => {
    if (!text) return;
    try {
      await Share.share({ message: text });
    } catch {
      // dismissed
    }
  };

  // ── Result ────────────────────────────────────────────────────────────────
  if (text !== null) {
    const empty = text.length === 0;
    return (
      <ToolScreen
        title="Extract text"
        scroll={false}
        right={
          !empty ? <HeaderIconButton icon="copy-outline" label="Copy text" onPress={handleCopy} /> : undefined
        }
        footer={
          empty ? (
            <PrimaryButton title="Try another image" icon="refresh-outline" onPress={() => setText(null)} />
          ) : (
            <View style={styles.actions}>
              <PrimaryButton
                title="Scan again"
                variant="secondary"
                onPress={() => setText(null)}
                style={styles.flex}
              />
              <PrimaryButton title="Share" icon="share-outline" onPress={handleShare} style={styles.flex} />
            </View>
          )
        }
      >
        {empty ? (
          <View style={styles.pad}>
            <ToolIntro
              icon="reader-outline"
              title="No text found"
              text="We couldn’t find any readable text. Make sure the page is in focus and well lit."
            />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.resultScroll}>
            <View style={[styles.resultCard, { backgroundColor: colors.card }]}>
              <Text style={[Type.body, styles.resultText, { color: colors.text }]} selectable>
                {text}
              </Text>
            </View>
            <Text style={[Type.footnote, styles.hint, { color: colors.muted }]}>
              Touch and hold the text to select part of it.
            </Text>
          </ScrollView>
        )}
      </ToolScreen>
    );
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  return (
    <ToolScreen
      title="Extract text"
      footer={
        <>
          {progress ? (
            <ToolProgress
              label={progress.total > 1 ? `Reading image ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…` : 'Reading text…'}
              current={progress.current}
              total={progress.total}
            />
          ) : null}
          <PrimaryButton
            title="Scan a page"
            icon="camera-outline"
            onPress={() => run('camera')}
            disabled={!available || busy}
            loading={busy && !progress}
          />
          <PrimaryButton
            title="Import photos"
            icon="images-outline"
            variant="secondary"
            onPress={() => run('photos')}
            disabled={!available || busy}
          />
        </>
      }
    >
      <ToolIntro
        icon="reader-outline"
        title="Turn a page into text"
        text={
          available
            ? 'Scan a page or pick photos. The text is recognized on your device, ready to copy or share.'
            : 'Text recognition isn’t available on this device.'
        }
        points={
          available
            ? [
                { icon: 'lock-closed-outline', text: 'Recognition runs on this device. Nothing is uploaded.' },
                { icon: 'copy-outline', text: 'Copy the text, share it, or select just the part you need.' },
              ]
            : undefined
        }
      />
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: { paddingHorizontal: Spacing.gutter },
  actions: { flexDirection: 'row', gap: Spacing.md },
  resultScroll: { padding: Spacing.gutter },
  resultCard: { borderRadius: Radius.md, padding: Spacing.lg },
  resultText: { lineHeight: 23 },
  hint: { textAlign: 'center', marginTop: Spacing.md },
});

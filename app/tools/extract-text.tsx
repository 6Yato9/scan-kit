// app/tools/extract-text.tsx
// Recognise text from a fresh scan or from photos, then copy or share it.
// OCR goes through lib/ocr (Apple Vision on iOS, ML Kit on Android).
//
// Round 16 (lib/text-format.ts, remembered in lib/tool-prefs.ts): line breaks
// as on the page (the default, as before) or joined into paragraphs — chosen
// before reading under More options, or switched on the result — and Share
// as plain text (as before) or as a .txt file.
import { useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '@/contexts/theme-context';
import { useToast } from '@/components/toast';
import { PrimaryButton } from '@/components/primary-button';
import { HeaderIconButton } from '@/components/screen-header';
import { RecognizedText } from '@/components/recognized-text';
import { TextActions } from '@/components/text-actions';
import { Segmented, ToolIntro, ToolNote, ToolProgress, ToolScreen } from '@/components/tool-ui';
import { MoreOptions } from '@/components/more-options';
import { SectionLabel } from '@/components/section-label';
import {
  DEFAULT_EXTRACT_TEXT,
  formatRecognized,
  paragraphText,
  parseExtractTextPrefs,
  textFileName,
  type ExtractTextPrefs,
  type LineBreaks,
  type TextShareAs,
} from '@/lib/text-format';
import { readToolPrefs, TOOL_PREF_KEYS, writeToolPrefs } from '@/lib/tool-prefs';
import { useRememberedPrefs } from '@/components/use-remembered-prefs';
import { notifyError, notifySuccess, tapLight } from '@/lib/haptics';
import { ocrAvailable, recognizeLines } from '@/lib/ocr';
import { alertScanError, deleteTempFiles, pickPhotos, scanWithCamera } from '@/lib/tool-scan';
import { Spacing } from '@/lib/theme';
import { makeExportDir, shareFile, ShareError, shareText } from '@/lib/share';

const LINE_OPTIONS: { value: LineBreaks; label: string }[] = [
  { value: 'keep', label: 'As on the page' },
  { value: 'join', label: 'Joined' },
];
const SHARE_OPTIONS: { value: TextShareAs; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'file', label: '.txt file' },
];

const loadExtractPrefs = () => readToolPrefs(TOOL_PREF_KEYS.extractText, parseExtractTextPrefs);
const saveExtractPrefs = (p: ExtractTextPrefs) => writeToolPrefs(TOOL_PREF_KEYS.extractText, p);

export default function ExtractTextScreen() {
  const { colors } = useTheme();
  const { show } = useToast();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [text, setText] = useState<string | null>(null);
  // `found`: recognition read something. Kept apart from `text`, which the user can edit (even to empty).
  const [found, setFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const busyRef = useRef(false);
  const available = ocrAvailable();
  // Remembered; a choice made before it loads wins (components/use-remembered-prefs.ts).
  const [prefs, setPrefs, latestPrefs] = useRememberedPrefs<ExtractTextPrefs>(DEFAULT_EXTRACT_TEXT, loadExtractPrefs, saveExtractPrefs);
  const [moreOpen, setMoreOpen] = useState(false);
  // The text as recognized, before any formatting or edit, and the text it was formatted to.
  const rawRef = useRef({ plain: '', paragraphs: '' });
  const formattedRef = useRef('');
  /** On the result: the line breaks switched, from the recognized text (asks before dropping edits). */
  const switchLineBreaks = (v: LineBreaks) => {
    const apply = () => {
      setPrefs({ lineBreaks: v });
      const t = formatted(v);
      formattedRef.current = t;
      setText(t);
    };
    if (text !== null && text !== formattedRef.current) {
      Alert.alert('Replace your changes?', 'The text is formatted again from what was recognized, so your edits are lost.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Replace', style: 'destructive', onPress: apply },
      ]);
      return;
    }
    apply();
  };

  /** The text as recognized (`plain`, exactly as before) and with paragraph breaks found from the line spacing. */
  const recognize = async (uris: string[]) => {
    const parts: string[] = [];
    const paragraphs: string[] = [];
    for (let i = 0; i < uris.length; i++) {
      setProgress({ current: i, total: uris.length });
      const { text: t, lines } = await recognizeLines(uris[i]);
      if (t.trim()) {
        parts.push(t.trim());
        paragraphs.push(paragraphText(lines).trim() || t.trim());
      }
    }
    setProgress({ current: uris.length, total: uris.length });
    return { plain: parts.join('\n\n'), paragraphs: paragraphs.join('\n\n') };
  };
  const formatted = (lineBreaks: LineBreaks) =>
    lineBreaks === 'join' ? formatRecognized(rawRef.current.paragraphs, 'join') : rawRef.current.plain;

  const run = async (source: 'camera' | 'photos') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    let temp: string[] = [];
    try {
      let uris: string[] | null = null;
      if (source === 'camera') {
        try {
          // Finished pages (the photos aren't kept: nothing is saved here).
          uris = await scanWithCamera({ title: 'Extract text', doneLabel: 'Read text' });
        } catch (err) {
          alertScanError(err);
          return;
        }
      } else {
        uris = await pickPhotos(true);
      }
      if (!uris?.length) return;
      temp = uris;
      rawRef.current = await recognize(uris);
      const result = formatted(latestPrefs().lineBreaks);
      formattedRef.current = result;
      setText(result);
      setFound(!!result);
      setEditing(false);
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
    if (!text?.trim()) return;
    await Clipboard.setStringAsync(text);
    tapLight();
    show('Text copied');
  };

  const handleShare = async () => {
    if (!text?.trim()) return;
    if (prefs.shareAs !== 'file') {
      await shareText(text); // waits while App Lock is on; dismissing isn't an error
      return;
    }
    // A .txt file named after the first words, in its own export folder (swept at launch).
    try {
      const dir = await makeExportDir();
      const uri = `${dir}${encodeURIComponent(textFileName(text))}`;
      await FileSystem.writeAsStringAsync(uri, text, { encoding: 'utf8' });
      await shareFile(uri, { mimeType: 'text/plain', UTI: 'public.plain-text', dialogTitle: 'Recognized text' });
    } catch (err) {
      Alert.alert('Couldn’t share the text file', err instanceof ShareError ? err.message : 'Try again, or share it as text.');
    }
  };

  // ── Result ────────────────────────────────────────────────────────────────
  if (text !== null) {
    const empty = !found;
    return (
      <ToolScreen
        title="Extract text"
        scroll={false}
        right={
          !empty && !editing ? <HeaderIconButton icon="refresh-outline" label="Start over" onPress={() => setText(null)} /> : undefined
        }
        footer={
          empty ? (
            <PrimaryButton title="Try another image" icon="refresh-outline" onPress={() => setText(null)} />
          ) : editing ? undefined : (
            <View style={styles.actions}>
              <PrimaryButton
                title="Copy all"
                icon="copy-outline"
                variant="secondary"
                onPress={handleCopy}
                disabled={!text.trim()}
                style={styles.flex}
              />
              <PrimaryButton title="Share" icon="share-outline" onPress={handleShare} disabled={!text.trim()} style={styles.flex} />
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
          // Select any part (touch and hold, drag the handles) or fix OCR
          // mistakes before copying. Nothing is saved: the photos were temporary.
          <View style={styles.result}>
            {editing ? null : (
              <View style={styles.format}>
                <Segmented options={LINE_OPTIONS} value={prefs.lineBreaks} onChange={switchLineBreaks} />
              </View>
            )}
            <RecognizedText
              fill
              value={text}
              onChangeText={setText}
              onEditingChange={setEditing}
              surface={colors.card}
            />
            {/* Read aloud, and act on phone numbers, emails, links, addresses and dates. */}
            {editing ? null : <TextActions text={text} bleed={Spacing.gutter} style={styles.textActions} />}
          </View>
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
            ? 'Scan a page or pick photos. The text is recognized on your device, ready to copy or\u00A0share.'
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
      {available ? (
        <View pointerEvents={busy ? 'none' : 'auto'}>
          <MoreOptions
            open={moreOpen}
            onToggle={setMoreOpen}
            changed={(prefs.lineBreaks !== 'keep' ? 1 : 0) + (prefs.shareAs !== 'text' ? 1 : 0)}
          >
            <SectionLabel>Line breaks</SectionLabel>
            <Segmented options={LINE_OPTIONS} value={prefs.lineBreaks} onChange={v => setPrefs({ lineBreaks: v })} />
            <ToolNote>
              {prefs.lineBreaks === 'join'
                ? 'Each paragraph comes out as one line, ready to paste into an email or a document. Words split across lines are joined.'
                : 'Line breaks stay where they are on the page.'}
            </ToolNote>
            <SectionLabel>Share as</SectionLabel>
            <Segmented options={SHARE_OPTIONS} value={prefs.shareAs} onChange={v => setPrefs({ shareAs: v })} />
            <ToolNote>
              {prefs.shareAs === 'file'
                ? 'Share sends a .txt file, named after the first words, that you can save to Files or attach.'
                : 'Share sends the text itself, to paste into a message or a note.'}
            </ToolNote>
          </MoreOptions>
        </View>
      ) : null}
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: { paddingHorizontal: Spacing.gutter },
  actions: { flexDirection: 'row', gap: Spacing.md },
  result: { flex: 1, paddingHorizontal: Spacing.gutter, paddingTop: Spacing.md, paddingBottom: Spacing.xs },
  textActions: { marginTop: Spacing.sm },
  format: { marginBottom: Spacing.sm },
});

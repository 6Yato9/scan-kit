// app/tools/watermark.tsx
// Stamp a text watermark on every page of the document itself (drawn into the
// pages, so they stay searchable and re-filterable; the viewer offers Undo —
// lib/page-stamp.ts), or on a copy with "Save as a copy".
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import {
  ColorSwatches,
  NoDocumentsScreen,
  PagePreview,
  Segmented,
  ToolNote,
  ToolProgress,
  ToolScreen,
  useImageAspect,
  useToolDocuments,
} from '@/components/tool-ui';
import { ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import { FilterBaker } from '@/components/filter-baker';
import { usePageStamper, useStampFinish } from '@/components/page-stamper';
import { copyName, PDF_NOT_LISTED_NOTE, stampCopy, stampPages, StampError, targetPages } from '@/lib/page-stamp';
import { notifyError, notifySuccess } from '@/lib/haptics';
import {
  STAMP_RGB,
  WATERMARK_ANGLE,
  watermarkFontFraction,
  watermarkOpacity,
  type StampColor,
  type WatermarkStyle,
} from '@/lib/stamp';
import { Radius, Spacing, Type } from '@/lib/theme';

const STYLES: { value: WatermarkStyle; label: string }[] = [
  { value: 'diagonal', label: 'Diagonal' },
  { value: 'center', label: 'Centered' },
  { value: 'footer', label: 'Footer' },
];
const COLORS: { value: StampColor; label: string }[] = [
  { value: 'gray', label: 'Gray' },
  { value: 'red', label: 'Red' },
  { value: 'blue', label: 'Blue' },
];

export default function WatermarkScreen() {
  const { colors } = useTheme();
  const { width: screenW } = useWindowDimensions();
  const { docs, loaded } = useToolDocuments();
  const [text, setText] = useState('CONFIDENTIAL');
  const [style, setStyle] = useState<WatermarkStyle>('diagonal');
  const [color, setColor] = useState<StampColor>('gray');
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  // Never a default: stamping the wrong document is worse than one more tap.
  const { doc, setDocId, fixed, fromViewer } = useToolDoc(docs);
  const stamper = usePageStamper();
  const finish = useStampFinish(fromViewer);
  // From the Tools tab with a single document: there is nothing to choose.
  useEffect(() => {
    if (loaded && !fixed && !doc && docs.length === 1) setDocId(docs[0].id);
  }, [loaded, fixed, doc, docs, setDocId]);
  const aspect = useImageAspect(doc?.pages[0]);
  const label = text.trim();

  /** Watermarks every page of the document itself (Undo in the viewer), or of a copy. */
  const apply = async (mode: 'in-place' | 'copy') => {
    if (!doc || !label || progress) return;
    const spec = { kind: 'watermark' as const, text: label, style, color };
    const render = (pageUri: string, origUri: string | null) => stamper.stamp(pageUri, origUri, spec);
    const pages = targetPages(doc.pages.length, 0, true);
    const onProgress = (done: number, total: number) => setProgress({ current: done, total });
    setProgress({ current: 0, total: pages.length });
    try {
      if (mode === 'copy') {
        const copy = await stampCopy(doc, copyName(doc.name, 'watermarked'), pages, render, onProgress);
        notifySuccess();
        finish({ docId: copy.id, message: 'Watermarked copy saved. The original is unchanged.', openCopy: true });
      } else {
        const { undo } = await stampPages(doc.id, pages, render, { onProgress });
        notifySuccess();
        finish({
          docId: doc.id,
          message: pages.length > 1 ? `Watermark added to ${pages.length} pages` : 'Watermark added',
          undo,
          undoneMessage: 'Watermark removed',
        });
      }
    } catch (err) {
      notifyError();
      if (!(err instanceof StampError)) console.error('Watermark failed', err);
      Alert.alert(
        'Couldn’t add the watermark',
        err instanceof StampError ? err.message : 'Your document is unchanged. Try again.',
      );
    } finally {
      setProgress(null);
    }
  };

  if (loaded && docs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Watermark"
        icon="watermark"
        subtitle="Watermark stamps text on every page of a scan. Scan or import a document first."
      />
    );
  }

  // Small enough that the text and style controls stay above the fold.
  const previewW = Math.min(screenW * 0.5, 220);
  const [r, g, b] = STAMP_RGB[color];

  return (
    <ToolScreen
      title="Watermark"
      footer={
        <>
          {progress ? (
            <ToolProgress
              label={progress.total > 1 ? `Adding the watermark to page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…` : 'Adding the watermark…'}
              current={progress.current}
              total={progress.total}
            />
          ) : null}
          <PrimaryButton
            title={!doc || label ? 'Add watermark' : 'Enter watermark text'}
            onPress={() => apply('in-place')}
            disabled={!doc || !label}
            loading={!!progress}
          />
          {doc && label && !progress ? (
            <PrimaryButton title="Save as a copy" variant="secondary" onPress={() => apply('copy')} style={styles.secondary} />
          ) : null}
        </>
      }
    >
      {/* Presented over the viewer: a baker underneath would never run (see FilterBaker). */}
      {fromViewer ? <FilterBaker /> : null}
      {stamper.host}
      <ToolDocPicker
        docs={docs}
        doc={doc}
        fixed={fixed}
        disabled={!!progress}
        onPick={d => setDocId(d.id)}
        autoOpen={loaded && !fromViewer}
        note={PDF_NOT_LISTED_NOTE}
      />

      {/* Live preview: the first page (a sample page until one is chosen) with
          the watermark drawn exactly as the PDF will get it. */}
      <View style={styles.previewWrap}>
        <PagePreview uri={doc ? `${doc.pages[0]}?v=${doc.updatedAt}` : null} aspect={aspect} width={previewW}>
          {({ width }) => {
            const fontSize = watermarkFontFraction(label, style) * width;
            const ink = `rgba(${r},${g},${b},${watermarkOpacity(style)})`;
            const textEl = (
              <Text style={{ fontSize, fontWeight: '700', color: ink, letterSpacing: fontSize * 0.04 }}>
                {label}
              </Text>
            );
            return style === 'footer' ? (
              <View style={[styles.footerStamp, { bottom: width * aspect * 0.03 }]}>{textEl}</View>
            ) : (
              <View style={styles.centerStamp}>
                <View
                  style={[
                    { width: width * 2, alignItems: 'center' },
                    style === 'diagonal' && { transform: [{ rotate: `${WATERMARK_ANGLE}deg` }] },
                  ]}
                >
                  {textEl}
                </View>
              </View>
            );
          }}
        </PagePreview>
      </View>

      <SectionLabel>Text</SectionLabel>
      <TextInput
        style={[Type.body, styles.input, { color: colors.text, backgroundColor: colors.card }]}
        value={text}
        onChangeText={setText}
        placeholder="For example, CONFIDENTIAL"
        placeholderTextColor={colors.muted}
        autoCapitalize="characters"
        returnKeyType="done"
        maxLength={40}
        accessibilityLabel="Watermark text"
      />

      <SectionLabel>Style</SectionLabel>
      <Segmented options={STYLES} value={style} onChange={setStyle} />

      <SectionLabel>Color</SectionLabel>
      <ColorSwatches
        options={COLORS.map(c => ({ ...c, color: `rgb(${STAMP_RGB[c.value].join(',')})` }))}
        value={color}
        onChange={setColor}
      />

      <ToolNote>The watermark becomes part of every page, and you can undo it right after. To keep this document as it is, save a watermarked copy instead.</ToolNote>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  secondary: { marginTop: Spacing.sm },
  previewWrap: { marginTop: Spacing.lg },
  input: { borderRadius: Radius.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  centerStamp: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  footerStamp: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
});

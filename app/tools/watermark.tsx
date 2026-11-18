// app/tools/watermark.tsx
// Stamp a text watermark on every page and save the result as a new PDF.
import { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import {
  ColorSwatches,
  DocGroup,
  DocRow,
  NoDocumentsScreen,
  PagePreview,
  Segmented,
  SectionRow,
  ToolNote,
  ToolProgress,
  ToolScreen,
  useImageAspect,
  useToolDocuments,
} from '@/components/tool-ui';
import { ToolDocHeader, useToolDoc } from '@/components/tool-doc';
import { FilterBaker } from '@/components/filter-baker';
import { generatePdf } from '@/lib/pdf';
import { copyPdfToStorage, deleteDocumentFiles } from '@/lib/files';
import { deleteQuietly } from '@/lib/share';
import { getDocSettings, saveDocument } from '@/lib/storage';
import { notifyError, notifySuccess } from '@/lib/haptics';
import {
  STAMP_RGB,
  WATERMARK_ANGLE,
  watermarkFontFraction,
  watermarkOpacity,
  watermarkOverlay,
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
  const router = useRouter();
  const { colors } = useTheme();
  const { width: screenW } = useWindowDimensions();
  const { docs, loaded } = useToolDocuments();
  const [text, setText] = useState('CONFIDENTIAL');
  const [style, setStyle] = useState<WatermarkStyle>('diagonal');
  const [color, setColor] = useState<StampColor>('gray');
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  // Never a default: stamping the wrong document is worse than one more tap.
  const { doc, setDocId, fixed, fromViewer } = useToolDoc(docs);
  const aspect = useImageAspect(doc?.pages[0]);
  const label = text.trim();

  const apply = async () => {
    if (!doc || !label || progress) return;
    const id = Crypto.randomUUID();
    let temp: string | null = null;
    setProgress({ current: 0, total: doc.pages.length });
    try {
      const { pdfPageSize } = await getDocSettings();
      temp = await generatePdf(doc.pages, {
        pageSize: pdfPageSize,
        overlayHtml: (_i, size) => watermarkOverlay(label, style, color, size.width),
        onProgress: done => setProgress({ current: done, total: doc.pages.length }),
      });
      const stored = copyPdfToStorage(temp, id);
      const now = Date.now();
      await saveDocument({
        id,
        name: `${doc.name} (watermarked)`,
        pages: [],
        pdfUri: stored,
        folder: doc.folder,
        createdAt: now,
        updatedAt: now,
      });
      notifySuccess();
      // The viewer shows the toast: it covers the app-wide toast host.
      router.replace({ pathname: '/viewer', params: { id, notice: 'Watermarked copy saved' } });
    } catch {
      try { deleteDocumentFiles(id); } catch {}
      notifyError();
      Alert.alert('Couldn’t add the watermark', 'The PDF couldn’t be created. Try again, or try with fewer pages.');
    } finally {
      deleteQuietly(temp);
      setProgress(null);
    }
  };

  if (loaded && docs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Watermark"
        subtitle="Watermark stamps text on every page of a scan. Scan or import a document first."
      />
    );
  }

  const previewW = Math.min(screenW * 0.62, 260);
  const [r, g, b] = STAMP_RGB[color];

  return (
    <ToolScreen
      title="Watermark"
      footer={
        <>
          {progress ? (
            <ToolProgress
              label={`Adding watermark to page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…`}
              current={progress.current}
              total={progress.total}
            />
          ) : null}
          <PrimaryButton
            title={!doc ? 'Choose a document' : label ? 'Save watermarked PDF' : 'Enter watermark text'}
            onPress={apply}
            disabled={!doc || !label}
            loading={!!progress}
          />
        </>
      }
    >
      {/* Presented over the viewer: a baker underneath would never run (see FilterBaker). */}
      {fromViewer ? <FilterBaker /> : null}
      {fixed && doc ? (
        <ToolDocHeader doc={doc} />
      ) : doc ? (
        // Chosen: collapse the list so the preview and options sit right below.
        <>
          <SectionRow label="Document" action="Change" onAction={() => !progress && setDocId(null)} />
          <ToolDocHeader doc={doc} flush />
        </>
      ) : (
        <>
          <SectionLabel>Document</SectionLabel>
          <DocGroup>
            {docs.map(d => (
              <DocRow key={d.id} doc={d} selected={false} onPress={() => !progress && setDocId(d.id)} />
            ))}
          </DocGroup>
        </>
      )}

      {doc ? (
        <View style={styles.previewWrap}>
          <PagePreview uri={`${doc.pages[0]}?v=${doc.updatedAt}`} aspect={aspect} width={previewW}>
            {({ width }) => {
              const fontSize = watermarkFontFraction(label, style) * width;
              const ink = `rgba(${r},${g},${b},${watermarkOpacity(style)})`;
              const textEl = (
                <Text
                  style={{ fontSize, fontWeight: '700', color: ink, letterSpacing: fontSize * 0.04 }}
>
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
      ) : null}

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

      <ToolNote>A new PDF is saved with the watermark on every page. The original document is kept.</ToolNote>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  previewWrap: { marginTop: Spacing.lg },
  input: { borderRadius: Radius.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  centerStamp: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  footerStamp: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
});

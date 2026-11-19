// app/tools/watermark.tsx
// Stamp a text watermark on every page of the document itself (drawn into the
// pages, so they stay searchable and re-filterable; the viewer offers Undo —
// lib/page-stamp.ts), or on a copy with "Save as a copy".
//
// Type: one Single mark (diagonal, centered or footer) or the text Tiled in a
// diagonal grid over the whole page. Size (points on an A4-wide page) and
// Strength (ink opacity) start automatic — exactly the look the tool always
// had — and become numbers once moved (lib/stamp.ts resolveWatermarkLook).
// The choices are remembered for next time once a watermark is added
// (lib/watermark-prefs.ts).
//
// Round 16: the colour comes from the shared stamp palette, or Custom (hue
// and shade), and the text can be bold (the original) or regular. Strength
// and weight sit under "More options", which opens by itself when either
// isn't the default.
//
// The preview stays pinned above the controls while they scroll, so every
// change shows at once, and it is drawn from the same resolved numbers as the
// bake (lib/stamp.ts resolveStamp / watermarkTiles), in the same font.
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import {
  FooterActions,
  NoDocumentsScreen,
  PagePreview,
  SectionRow,
  Segmented,
  ToolNote,
  ToolProgress,
  ToolScreen,
  useImageAspect,
  useToolDocuments,
} from '@/components/tool-ui';
import { ToolDocPicker, useConvertiblePdfs, useToolDoc, type PickerConvert } from '@/components/tool-doc';
import { FilterBaker } from '@/components/filter-baker';
import { reportStampFailure, usePageStamper, useStampFinish } from '@/components/page-stamper';
import { ValueSlider } from '@/components/value-slider';
import { ColorPalette } from '@/components/color-palette';
import { MoreOptions } from '@/components/more-options';
import { copyName, stampCopy, stampPages, targetPages } from '@/lib/page-stamp';
import { notifySuccess } from '@/lib/haptics';
import {
  WATERMARK_SIZE_RANGE,
  WATERMARK_STRENGTH_RANGE,
  resolveStamp,
  resolveWatermarkLook,
  watermarkTiles,
  type StampSpec,
  type WatermarkLayout,
  type WatermarkStyle,
} from '@/lib/stamp';
import {
  DEFAULT_WATERMARK_PREFS,
  WATERMARK_TEXT_MAX,
  loadWatermarkPrefs,
  saveWatermarkPrefs,
  type PerLayout,
} from '@/lib/watermark-prefs';
import { INK_PALETTE, type InkChoice } from '@/lib/stamp-colors';
import { Radius, Spacing, Type } from '@/lib/theme';

const LAYOUTS: { value: WatermarkLayout; label: string }[] = [
  { value: 'single', label: 'Single' },
  { value: 'tiled', label: 'Tiled' },
];
const STYLES: { value: WatermarkStyle; label: string }[] = [
  { value: 'diagonal', label: 'Diagonal' },
  { value: 'center', label: 'Centered' },
  { value: 'footer', label: 'Footer' },
];
const COLORS = INK_PALETTE.map(p => ({ value: p.id, label: p.label, color: p.hex }));
const WEIGHTS: { value: 'bold' | 'regular'; label: string }[] = [
  { value: 'bold', label: 'Bold' },
  { value: 'regular', label: 'Regular' },
];

/** The canvas draws in Helvetica (lib/stamp.ts STAMP_FONT), bold or regular; so does the preview. */
const previewFont = (weight: '400' | '700') => ({ fontFamily: 'Helvetica', fontWeight: weight });
/** Text is measured once at this size; its width scales with the font size. */
const MEASURE_PT = 100;

export default function WatermarkScreen() {
  const { colors } = useTheme();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const { docs, loaded, reload } = useToolDocuments();
  // Imported PDFs: listed in the picker with Convert, never a dead end.
  const { pdfs, loaded: pdfsLoaded, reload: reloadPdfs } = useConvertiblePdfs();
  const d = DEFAULT_WATERMARK_PREFS;
  const [text, setText] = useState(d.text);
  const [layout, setLayout] = useState<WatermarkLayout>(d.layout);
  const [style, setStyle] = useState<WatermarkStyle>(d.style);
  const [color, setColor] = useState<InkChoice>(d.color);
  const [customColor, setCustomColor] = useState<string | null>(d.customColor);
  const [bold, setBold] = useState(d.bold);
  const [moreOpen, setMoreOpen] = useState(false);
  const [size, setSize] = useState<PerLayout>(d.size);
  const [strength, setStrength] = useState<PerLayout>(d.strength);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  // The remembered choices arrive a moment after the screen opens; anything
  // the user has already changed by then wins.
  const touched = useRef(false);
  const touch = () => {
    touched.current = true;
  };
  useEffect(() => {
    let live = true;
    loadWatermarkPrefs().then(p => {
      if (!live || touched.current) return;
      setText(p.text);
      setLayout(p.layout);
      setStyle(p.style);
      setColor(p.color);
      setCustomColor(p.customColor);
      setBold(p.bold);
      setSize(p.size);
      setStrength(p.strength);
      // Something under More options isn't the default: show it.
      if (!p.bold || p.strength.single != null || p.strength.tiled != null) setMoreOpen(true);
    });
    return () => {
      live = false;
    };
  }, []);

  // Never a default: stamping the wrong document is worse than one more tap.
  const { doc, docId, setDocId, fixed, fromViewer } = useToolDoc(docs);
  const stamper = usePageStamper();
  const finish = useStampFinish(fromViewer);
  // From the Tools tab with a single document: there is nothing to choose.
  useEffect(() => {
    if (loaded && !fixed && !docId && docs.length === 1) setDocId(docs[0].id);
  }, [loaded, fixed, docId, docs, setDocId]);
  const aspect = useImageAspect(doc?.pages[0]);
  const label = text.trim();

  const spec: Extract<StampSpec, { kind: 'watermark' }> = {
    kind: 'watermark',
    text: label,
    style,
    color,
    customColor,
    bold,
    layout,
    sizePt: size[layout],
    strength: strength[layout],
  };
  const look = resolveWatermarkLook(label, spec);

  /** Watermarks every page of the document itself (Undo in the viewer), or of a copy. */
  const apply = async (mode: 'in-place' | 'copy') => {
    if (!doc || !label || progress) return;
    saveWatermarkPrefs({ text: label, layout, style, color, customColor, bold, size, strength });
    const render = (pageUri: string, origUri: string | null) => stamper.stamp(pageUri, origUri, spec);
    const pages = targetPages(doc.pages.length, 0, true);
    const onProgress = (done: number, total: number) => setProgress({ current: done, total });
    setProgress({ current: 0, total: pages.length });
    try {
      if (mode === 'copy') {
        const copy = await stampCopy(doc, copyName(doc.name, 'watermarked'), pages, render, onProgress, stamper.signal);
        notifySuccess();
        finish({ docId: copy.id, message: 'Watermarked copy saved. The original is unchanged.', openCopy: true });
      } else {
        const { undo } = await stampPages(doc.id, pages, render, { onProgress, signal: stamper.signal });
        notifySuccess();
        finish({
          docId: doc.id,
          message: pages.length > 1 ? `Watermark added to ${pages.length} pages` : 'Watermark added',
          undo,
          undoneMessage: 'Watermark removed',
        });
      }
    } catch (err) {
      // Says only what is true: cancelled (closed), partly done, or unchanged.
      reportStampFailure(err, 'Couldn’t add the watermark', 'Watermark removed');
    } finally {
      setProgress(null);
    }
  };

  // Picking an imported PDF converts it to pages (with Undo), then chooses it.
  const convert: PickerConvert = {
    pdfs,
    verb: 'watermark',
    onConverted: d => {
      reload();
      reloadPdfs();
      setDocId(d.id);
    },
    onUndone: id => {
      reload();
      reloadPdfs();
      if (docId === id) setDocId(null);
    },
  };

  if (loaded && pdfsLoaded && docs.length === 0 && pdfs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Watermark"
        icon="watermark"
        subtitle="Watermark stamps text on every page of a scan. Scan or import a document first."
      />
    );
  }

  // The preview is pinned while the controls scroll under it, so it is kept
  // to a fifth of the screen's height (and half its width): the controls keep
  // most of the screen.
  const previewMaxH = Math.round(screenH * 0.2);
  const previewW = Math.min(screenW * 0.5, 220, previewMaxH / aspect);
  const sizeRange = WATERMARK_SIZE_RANGE[layout];
  // Size and strength are kept per type (a good tile is far smaller than a single mark).
  const setSizeValue = (v: number | null) => {
    touch();
    setSize(prev => ({ ...prev, [layout]: v }));
  };
  const setStrengthValue = (v: number | null) => {
    touch();
    setStrength(prev => ({ ...prev, [layout]: v }));
  };

  return (
    <ToolScreen
      title="Watermark"
      busy={!!progress}
      // The preview (third child) stays in view while the options scroll.
      stickyHeaderIndices={[2]}
      footer={
        <>
          {progress ? (
            <ToolProgress
              label={progress.total > 1 ? `Adding the watermark to page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…` : 'Adding the watermark…'}
              current={progress.current}
              total={progress.total}
            />
          ) : null}
          <FooterActions
            secondary={
              <PrimaryButton title="Save as a copy" variant="secondary" onPress={() => apply('copy')} disabled={!doc || !label || !!progress} />
            }
            primary={
              <PrimaryButton
                title={!doc || label ? 'Add watermark' : 'Enter text'}
                onPress={() => apply('in-place')}
                disabled={!doc || !label}
                loading={!!progress}
              />
            }
          />
        </>
      }
    >
      {/* Child 0: off-screen hosts, always one element so the sticky index holds.
          Presented over the viewer: a baker underneath would never run (see FilterBaker). */}
      <>
        {fromViewer ? <FilterBaker /> : null}
        {stamper.host}
      </>
      <ToolDocPicker
        docs={docs}
        doc={doc}
        fixed={fixed}
        disabled={!!progress}
        onPick={d => setDocId(d.id)}
        autoOpen={loaded && !fromViewer}
        convert={convert}
      />

      {/* Live preview: the first page (a sample page until one is chosen) with
          the watermark drawn exactly as the page will get it. */}
      <View style={[styles.previewWrap, { backgroundColor: colors.bg }]}>
        <PagePreview uri={doc ? `${doc.pages[0]}?v=${doc.updatedAt}` : null} aspect={aspect} width={previewW}>
          {({ width, height }) => <WatermarkLayer spec={spec} width={width} height={height} />}
        </PagePreview>
      </View>

      <SectionLabel>Text</SectionLabel>
      <TextInput
        style={[Type.body, styles.input, { color: colors.text, backgroundColor: colors.card }]}
        value={text}
        onChangeText={v => {
          touch();
          setText(v);
        }}
        placeholder="For example, CONFIDENTIAL"
        placeholderTextColor={colors.muted}
        autoCapitalize="characters"
        returnKeyType="done"
        maxLength={WATERMARK_TEXT_MAX}
        accessibilityLabel="Watermark text"
      />

      <SectionLabel>Type</SectionLabel>
      <Segmented options={LAYOUTS} value={layout} onChange={v => {
          touch();
          setLayout(v);
        }} />

      {layout === 'single' ? (
        <>
          <SectionLabel>Style</SectionLabel>
          <Segmented options={STYLES} value={style} onChange={v => {
              touch();
              setStyle(v);
            }} />
        </>
      ) : null}

      <SectionRow label="Size" action={look.autoSize ? undefined : 'Reset'} onAction={() => setSizeValue(null)} />
      <ValueSlider
        label="Watermark size"
        value={Math.min(sizeRange.max, Math.max(sizeRange.min, look.sizePt))}
        min={sizeRange.min}
        max={sizeRange.max}
        step={2}
        format={v => `${v} pt`}
        onChange={setSizeValue}
      />

      <SectionLabel>Color</SectionLabel>
      <ColorPalette
        options={COLORS}
        value={color}
        onChange={v => {
          touch();
          setColor(v as InkChoice);
        }}
        custom={customColor}
        onCustomChange={hex => {
          touch();
          setCustomColor(hex);
        }}
        accessibilityLabel="Watermark color"
      />

      <MoreOptions
        open={moreOpen}
        onToggle={setMoreOpen}
        changed={(look.autoStrength ? 0 : 1) + (bold ? 0 : 1)}
      >
        <SectionRow label="Strength" action={look.autoStrength ? undefined : 'Reset'} onAction={() => setStrengthValue(null)} />
        <ValueSlider
          label="Watermark strength"
          value={look.strength}
          min={WATERMARK_STRENGTH_RANGE.min}
          max={WATERMARK_STRENGTH_RANGE.max}
          step={5}
          format={v => `${v}%`}
          onChange={setStrengthValue}
        />

        <SectionLabel>Weight</SectionLabel>
        <Segmented
          options={WEIGHTS}
          value={bold ? 'bold' : 'regular'}
          onChange={v => {
            touch();
            setBold(v === 'bold');
          }}
        />
      </MoreOptions>

      <ToolNote>Size is in points on an A4-wide page and scales with each page. The watermark becomes part of every page, and you can undo it right after. To keep this document as it is, save a watermarked copy instead.</ToolNote>
    </ToolScreen>
  );
}

/**
 * The watermark over a preview page `width` × `height` points, from the same
 * resolved numbers the canvas bakes with (lib/stamp.ts resolveStamp): font
 * size as a fraction of the page width, ink, angle and, for Tiled, the repeat
 * grid (watermarkTiles) laid out with the text's measured width.
 */
function WatermarkLayer({ spec, width, height }: { spec: StampSpec; width: number; height: number }) {
  const r = resolveStamp(spec);
  // The text's width at MEASURE_PT, for the tile spacing (as the canvas
  // measures its own); keyed by the text so a stale width is never used.
  const [measured, setMeasured] = useState<{ text: string; w: number } | null>(null);
  if (r.kind !== 'watermark' || !r.text) return null;
  const fontSize = r.fontFrac * width;
  // Bold and regular measure differently: a width is only reused for the same text in the same weight.
  const measureKey = `${r.weight}|${r.text}`;
  const textStyle = { ...previewFont(r.weight), fontSize, color: r.ink, letterSpacing: fontSize * 0.04 };
  const textEl = (
    <Text style={textStyle} numberOfLines={1} allowFontScaling={false}>
      {r.text}
    </Text>
  );

  if (r.layout === 'footer') {
    return <View style={[styles.footerStamp, { bottom: height * 0.03 }]}>{textEl}</View>;
  }
  if (r.layout !== 'tiled') {
    return (
      <View style={styles.centerStamp}>
        <View style={[{ width: width * 2, alignItems: 'center' }, r.angle ? { transform: [{ rotate: `${r.angle}deg` }] } : null]}>
          {textEl}
        </View>
      </View>
    );
  }

  // Until measured, the width the fit formula assumes (0.62 em a character).
  const unitW =
    measured && measured.text === measureKey ? measured.w / MEASURE_PT : [...r.text].length * 0.62 * 1.04;
  const textW = unitW * fontSize;
  const tiles = watermarkTiles(width, height, fontSize, textW, r.angle, r.gapEm, r.rowEm);
  const boxW = textW * 2 + fontSize * 2;
  const boxH = fontSize * 2;
  return (
    <View style={styles.clip}>
      <View style={styles.measure} pointerEvents="none">
        <Text
          style={{ ...previewFont(r.weight), fontSize: MEASURE_PT, letterSpacing: MEASURE_PT * 0.04 }}
          numberOfLines={1}
          allowFontScaling={false}
          onLayout={e => {
            const w = e.nativeEvent.layout.width;
            if (w > 0 && (measured?.text !== measureKey || Math.abs(measured.w - w) > 0.5)) setMeasured({ text: measureKey, w });
          }}
        >
          {r.text}
        </Text>
      </View>
      {tiles.map((t, i) => (
        <View
          key={i}
          style={[
            styles.tile,
            { left: t.x - boxW / 2, top: t.y - boxH / 2, width: boxW, height: boxH, transform: [{ rotate: `${r.angle}deg` }] },
          ]}
        >
          {textEl}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Pinned while scrolling: an opaque band the full width of the screen (out
  // over the body's gutters) so the options pass cleanly under it.
  previewWrap: {
    marginHorizontal: -Spacing.gutter,
    paddingHorizontal: Spacing.gutter,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.xs,
  },
  input: { borderRadius: Radius.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  centerStamp: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  footerStamp: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  clip: { ...StyleSheet.absoluteFillObject, overflow: 'hidden' },
  measure: { position: 'absolute', left: 0, top: 0, width: 100_000, flexDirection: 'row', alignItems: 'flex-start', opacity: 0 },
  tile: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
});

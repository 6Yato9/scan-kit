// app/tools/long-image.tsx
// Stacks every page of a document into one tall image, previews it, and shares
// it. Rendering happens in an off-screen WebView canvas (lib/long-image.ts).
//
// Round 16: spacing between pages on the screen; under More options an outer
// margin, the background colour, the widest the pages may be and the JPEG
// quality — remembered (lib/tool-prefs.ts), defaults exactly the old image.
// Changing a choice drops the preview, so what is shown is what is shared.
import { useEffect, useRef, useState } from 'react';
import { Alert, Image, StyleSheet, View, useWindowDimensions } from 'react-native';
import { LocalWebView } from '@/components/local-webview';
import * as FileSystem from 'expo-file-system/legacy';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { ColorSwatches, NoDocumentsScreen, Segmented, ToolNote, ToolScreen, isImageDoc, isSinglePageDoc, useToolDocuments } from '@/components/tool-ui';
import { MoreOptions } from '@/components/more-options';
import { readToolPrefs, TOOL_PREF_KEYS, writeToolPrefs } from '@/lib/tool-prefs';
import { useRememberedPrefs } from '@/components/use-remembered-prefs';
import { ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import {
  BACKGROUND_HEX,
  buildLongImageHtml,
  DEFAULT_LONG_IMAGE,
  JPEG_QUALITY,
  parseLongImageOptions,
  planLongImage,
  shownWidthChoice,
  WIDTH_CHOICES,
  widthChoices,
  type LongImageBackground,
  type LongImageOptions,
  type LongImagePlan,
  type LongImageQuality,
  type LongImageSpace,
} from '@/lib/long-image';
import { deleteQuietly, exportFileName, makeExportDir, shareFile } from '@/lib/share';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { Radius, Spacing } from '@/lib/theme';
import type { Document } from '@/types/document';

const TIMEOUT_MS = 45_000;
/** The width choices before a document's page sizes are known: all offered. */
const DEFAULT_WIDTHS = WIDTH_CHOICES.map(value => ({ value, width: value, same: false }));

const loadLongImagePrefs = () => readToolPrefs(TOOL_PREF_KEYS.longImage, parseLongImageOptions);
const saveLongImagePrefs = (o: LongImageOptions) => writeToolPrefs(TOOL_PREF_KEYS.longImage, o);

function imageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise(resolve => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), () => resolve({ width: 0, height: 0 }));
  });
}

const isMultiPageImageDoc = (d: Document) => isImageDoc(d) && d.pages.length >= 2;

type Output = { uri: string; dir: string; plan: LongImagePlan; docName: string; docId: string };

const SPACE_OPTIONS: { value: LongImageSpace; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'small', label: 'Small' },
  { value: 'large', label: 'Large' },
];
const BACKGROUND_OPTIONS: { value: LongImageBackground; label: string; color: string }[] = [
  { value: 'white', label: 'White', color: BACKGROUND_HEX.white },
  { value: 'grey', label: 'Grey', color: BACKGROUND_HEX.grey },
  { value: 'black', label: 'Black', color: BACKGROUND_HEX.black },
];
const QUALITY_OPTIONS: { value: LongImageQuality; label: string }[] = [
  { value: 'smaller', label: 'Smaller file' },
  { value: 'standard', label: 'Standard' },
  { value: 'best', label: 'Best' },
];

export default function LongImageScreen() {
  const { colors } = useTheme();
  const { width: screenW } = useWindowDimensions();
  // One page has nothing to join: only documents with two or more pages.
  const { docs, loaded } = useToolDocuments(isMultiPageImageDoc);
  // One-page documents: offered "Add pages" instead of a dead end.
  const { docs: singles, loaded: singlesLoaded } = useToolDocuments(isSinglePageDoc);
  const [job, setJob] = useState<{ html: string; plan: LongImagePlan; doc: Document } | null>(null);
  const [output, setOutput] = useState<Output | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outputRef = useRef<Output | null>(null);
  outputRef.current = output;

  const { doc, docId, setDocId, fixed } = useToolDoc(docs);
  const working = job !== null;
  // Remembered; a choice made before they load wins (components/use-remembered-prefs.ts).
  const [opts, updateOpts, latestOpts] = useRememberedPrefs<LongImageOptions>(DEFAULT_LONG_IMAGE, loadLongImagePrefs, saveLongImagePrefs);
  const [moreOpen, setMoreOpen] = useState(false);
  /** A new choice: remembered, and the image made with the old one goes. */
  const setOpts = (patch: Partial<LongImageOptions>) => {
    if (working) return;
    updateOpts(patch);
    deleteQuietly(outputRef.current?.dir);
    setOutput(null);
  };
  const changed =
    (opts.margin !== DEFAULT_LONG_IMAGE.margin ? 1 : 0) +
    (opts.background !== DEFAULT_LONG_IMAGE.background ? 1 : 0) +
    (opts.maxWidth !== DEFAULT_LONG_IMAGE.maxWidth ? 1 : 0) +
    (opts.quality !== DEFAULT_LONG_IMAGE.quality ? 1 : 0);

  // The pages' sizes, for the widths this document can really have.
  const [sizes, setSizes] = useState<{ docId: string; sizes: { width: number; height: number }[] } | null>(null);
  const sizesKey = doc ? `${doc.id}:${doc.updatedAt}` : null;
  useEffect(() => {
    if (!doc) return;
    let live = true;
    Promise.all(doc.pages.map(p => imageSize(p.split('?')[0]))).then(s => {
      if (live) setSizes({ docId: doc.id, sizes: s });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizesKey]);
  const docSizes = sizes && doc && sizes.docId === doc.id ? sizes.sizes : null;
  // A width that would make the same image as a narrower one is greyed out.
  const widths = docSizes ? widthChoices(docSizes, opts) : null;
  const widthOptions = (widths ?? DEFAULT_WIDTHS).map(c => ({
    value: String(c.value),
    label: `${c.value.toLocaleString('en-US')} px`,
    disabled: c.same,
  }));
  const shownWidth = widths ? shownWidthChoice(widths, opts.maxWidth) : opts.maxWidth;
  const widest = widths ? widths[widths.length - 1].width : null;
  // The widest choice isn't reached: the note says how wide this document can be.
  const limited = !!widest && widest < WIDTH_CHOICES[WIDTH_CHOICES.length - 1];

  // Remove the rendered file when leaving the screen.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      deleteQuietly(outputRef.current?.dir);
    },
    [],
  );

  const fail = () => {
    if (timer.current) clearTimeout(timer.current);
    setJob(null);
    notifyError();
    Alert.alert(
      'Couldn’t create the long image',
      'This document may have too many pages for one image. Try extracting fewer pages first.',
    );
  };

  const start = async () => {
    if (!doc || working) return;
    deleteQuietly(output?.dir);
    setOutput(null);
    const srcs = doc.pages.map(p => p.split('?')[0]);
    const sizes: { width: number; height: number }[] = [];
    for (const s of srcs) sizes.push(await imageSize(s));
    const o = latestOpts();
    const plan = planLongImage(sizes, o);
    setJob({
      html: buildLongImageHtml(srcs, plan, { background: BACKGROUND_HEX[o.background], quality: JPEG_QUALITY[o.quality] }),
      plan,
      doc,
    });
    timer.current = setTimeout(fail, TIMEOUT_MS);
  };

  const onMessage = async (e: { nativeEvent: { data: string } }) => {
    const current = job;
    if (!current) return;
    if (timer.current) clearTimeout(timer.current);
    const data = e.nativeEvent.data;
    if (!data.startsWith('data:image/jpeg')) {
      fail();
      return;
    }
    try {
      const dir = await makeExportDir();
      const uri = `${dir}${encodeURIComponent(exportFileName(`${current.doc.name} long`, 'jpg'))}`;
      await FileSystem.writeAsStringAsync(uri, data.slice(data.indexOf(',') + 1), { encoding: 'base64' });
      setOutput({ uri, dir, plan: current.plan, docName: current.doc.name, docId: current.doc.id });
      setJob(null);
      notifySuccess();
    } catch {
      fail();
    }
  };

  const share = async () => {
    if (!output) return;
    try {
      await shareFile(output.uri, { mimeType: 'image/jpeg', UTI: 'public.jpeg', dialogTitle: output.docName });
    } catch {
      Alert.alert('Couldn’t open the share sheet', 'Try again in a moment.');
    }
  };

  if (loaded && singlesLoaded && docs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Long image"
        icon="long-image"
        title="No multi-page documents"
        subtitle={
          singles.length
            ? 'Long image joins a document’s pages into one tall picture, and yours have one page each. Add pages to one, or scan a new document.'
            : 'Long image joins a document’s pages into one tall picture. Scan or import a document with two or more pages first.'
        }
        addPagesTo={singles}
      />
    );
  }

  const shown = output && output.docId === docId ? output : null;
  const previewW = screenW - Spacing.gutter * 2;

  return (
    <ToolScreen
      title="Long image"
      footer={
        shown ? (
          <PrimaryButton title="Share image" icon="share-outline" onPress={share} />
        ) : (
          <PrimaryButton
            title={working ? 'Creating long image…' : 'Create long image'}
            onPress={start}
            disabled={!doc}
            loading={working}
          />
        )
      }
    >
      <ToolDocPicker
        docs={docs}
        doc={doc}
        fixed={fixed}
        disabled={working}
        note="Documents with two or more pages."
        onPick={d => setDocId(d.id)}
      />
      <View pointerEvents={working ? 'none' : 'auto'}>
        <SectionLabel>Space between pages</SectionLabel>
        <Segmented options={SPACE_OPTIONS} value={opts.gap} onChange={v => setOpts({ gap: v })} />
        <MoreOptions open={moreOpen} onToggle={setMoreOpen} changed={changed}>
          <SectionLabel>Margin around the pages</SectionLabel>
          <Segmented options={SPACE_OPTIONS} value={opts.margin} onChange={v => setOpts({ margin: v })} />
          <SectionLabel>Background</SectionLabel>
          <ColorSwatches options={BACKGROUND_OPTIONS} value={opts.background} onChange={v => setOpts({ background: v })} />
          <ToolNote>The color of the space between and around the pages.</ToolNote>
          <SectionLabel>Page width</SectionLabel>
          <Segmented options={widthOptions} value={String(shownWidth)} onChange={v => setOpts({ maxWidth: Number(v) })} />
          <ToolNote>
            {limited && widest
              ? `The widest the pages can be. This document can be at most ${widest.toLocaleString('en-US')} px wide: pages are never enlarged, and many pages are made narrower to fit in one image.`
              : 'The widest the pages can be. Pages are never enlarged, and many pages are made narrower to fit in one image.'}
          </ToolNote>
          <SectionLabel>Image quality</SectionLabel>
          <Segmented options={QUALITY_OPTIONS} value={opts.quality} onChange={v => setOpts({ quality: v })} />
        </MoreOptions>
      </View>
      {shown ? (
        <>
          <SectionLabel>Preview</SectionLabel>
          <View style={[styles.preview, { backgroundColor: colors.card, borderColor: colors.thumbBorder }]}>
            <Image
              source={{ uri: shown.uri }}
              style={{ width: previewW, height: (previewW * shown.plan.totalHeight) / shown.plan.canvasWidth }}
              resizeMode="contain"
              accessibilityLabel={`Long image of ${shown.docName}`}
            />
          </View>
          <ToolNote>{`${shown.plan.canvasWidth.toLocaleString('en-US')} × ${shown.plan.totalHeight.toLocaleString('en-US')} pixels, ${shown.plan.heights.length} pages.`}</ToolNote>
        </>
      ) : (
        <ToolNote>All pages are stacked top to bottom into a single JPEG you can share or save to Photos.</ToolNote>
      )}

      {job ? (
        <View style={styles.host} pointerEvents="none">
          <LocalWebView
            html={job.html}
            style={styles.web}
            onMessage={onMessage}
            onError={fail}
            onContentProcessDidTerminate={fail}
            javaScriptEnabled
          />
        </View>
      ) : null}
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  preview: { borderRadius: Radius.md, overflow: 'hidden', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth },
  // Same host trick as components/filter-baker.tsx: WKWebView only runs its
  // JavaScript when it is really laid out, so it is kept on screen at 1%
  // opacity in a 2pt strip rather than hidden or sized to nothing.
  host: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 320,
    height: 2,
    overflow: 'hidden',
    opacity: 0.01,
  },
  web: { width: 320, height: 480 },
});

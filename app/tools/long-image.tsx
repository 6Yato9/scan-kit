// app/tools/long-image.tsx
// Stacks every page of a document into one tall image, previews it, and shares
// it. Rendering happens in an off-screen WebView canvas (lib/long-image.ts).
import { useEffect, useRef, useState } from 'react';
import { Alert, Image, StyleSheet, View, useWindowDimensions } from 'react-native';
import { LocalWebView } from '@/components/local-webview';
import * as FileSystem from 'expo-file-system/legacy';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { NoDocumentsScreen, ToolNote, ToolScreen, isImageDoc, isSinglePageDoc, useToolDocuments } from '@/components/tool-ui';
import { ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import { buildLongImageHtml, planLongImage, type LongImagePlan } from '@/lib/long-image';
import { deleteQuietly, exportFileName, makeExportDir, shareFile } from '@/lib/share';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { Radius, Spacing } from '@/lib/theme';
import type { Document } from '@/types/document';

const TIMEOUT_MS = 45_000;

function imageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise(resolve => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), () => resolve({ width: 0, height: 0 }));
  });
}

const isMultiPageImageDoc = (d: Document) => isImageDoc(d) && d.pages.length >= 2;

type Output = { uri: string; dir: string; plan: LongImagePlan; docName: string; docId: string };

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
    const plan = planLongImage(sizes);
    setJob({ html: buildLongImageHtml(srcs, plan), plan, doc });
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
      {shown ? (
        <>
          <SectionLabel>Preview</SectionLabel>
          <View style={[styles.preview, { backgroundColor: colors.card, borderColor: colors.thumbBorder }]}>
            <Image
              source={{ uri: shown.uri }}
              style={{ width: previewW, height: (previewW * shown.plan.totalHeight) / shown.plan.width }}
              resizeMode="contain"
              accessibilityLabel={`Long image of ${shown.docName}`}
            />
          </View>
          <ToolNote>{`${shown.plan.width} × ${shown.plan.totalHeight} pixels, ${shown.plan.heights.length} pages.`}</ToolNote>
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

// app/annotate.tsx
// Markup: pen, highlighter, text, shapes and eraser on a page, with undo/redo
// for everything and two-finger zoom. The drawing runs in a LocalWebView
// (lib/markup-html.ts + lib/markup-core.ts); Done draws the marks into the page
// (and its unfiltered .orig shadow) at full size, exactly as previewed.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { LocalWebView } from '@/components/local-webview';
import { AppIcon, type AppIconName } from '@/components/app-icon';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { getDocuments, patchDocument } from '@/lib/storage';
import { originalSideUri, originalUri, pageSideUri, promoteOriginalSide, promotePageSide } from '@/lib/files';
import { pageFileUri } from '@/lib/image';
import { bakePage, runPageEdit } from '@/lib/bake';
import { buildMarkupHtml, type MarkupConfig } from '@/lib/markup-html';
import { luminance } from '@/lib/stamp-colors';
import { Highlight, HIT, Ink, Radius, Spacing, Type } from '@/lib/theme';
import { DarkThemeScope, useTheme } from '@/contexts/theme-context';
import { HeaderTextButton, ScreenHeader } from '@/components/screen-header';
import { BottomSheet, SheetHeader } from '@/components/bottom-sheet';
import { PrimaryButton } from '@/components/primary-button';
import { FilterBaker } from '@/components/filter-baker';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { selection, tapLight } from '@/lib/haptics';
import type { Document, PageAdjustment, PageFilter } from '@/types/document';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
type Tool = MarkupConfig['tool'];
type Shape = MarkupConfig['shape'];

// This screen's chrome is always dark (like the viewer): it uses the theme's
// `chrome*` colours. Ink and highlight colours are content, not UI, so they
// are fixed (lib/theme Ink / Highlight).
const INK_COLORS = [
  { hex: Ink.black, label: 'Black' },
  { hex: Ink.red, label: 'Red' },
  { hex: Ink.blue, label: 'Blue' },
  { hex: Ink.green, label: 'Green' },
];
const HIGHLIGHT_COLORS = [
  { hex: Highlight.yellow, label: 'Yellow' },
  { hex: Highlight.green, label: 'Green' },
  { hex: Highlight.pink, label: 'Pink' },
  { hex: Highlight.blue, label: 'Blue' },
];
/** Widths in screen points: constant on screen, so zooming in draws finer. */
const PEN_SIZES = [
  { size: 2, label: 'Fine' },
  { size: 4, label: 'Medium' },
  { size: 8, label: 'Bold' },
];
const HIGHLIGHT_SIZES = [
  { size: 14, label: 'Narrow' },
  { size: 24, label: 'Wide' },
];
const ERASER_SIZES = [
  { size: 14, label: 'Small eraser' },
  { size: 32, label: 'Large eraser' },
];
/** Text sizes in points at the page's fitted size (they scale with the page). */
const TEXT_SIZES = [
  { size: 14, icon: 13, label: 'Small text' },
  { size: 20, icon: 17, label: 'Medium text' },
  { size: 30, icon: 22, label: 'Large text' },
];
const SHAPES: { id: Shape; icon: IconName; label: string }[] = [
  { id: 'rect', icon: 'square-outline', label: 'Rectangle' },
  { id: 'ellipse', icon: 'ellipse-outline', label: 'Oval' },
  { id: 'line', icon: 'remove-outline', label: 'Line' },
  { id: 'arrow', icon: 'arrow-forward-outline', label: 'Arrow' },
];
const TOOLS: { id: Tool; icon: AppIconName; label: string }[] = [
  { id: 'pen', icon: 'pen', label: 'Pen' },
  { id: 'highlighter', icon: 'highlighter', label: 'Highlight' },
  { id: 'text', icon: 'text-outline', label: 'Text' },
  { id: 'shape', icon: 'shapes-outline', label: 'Shape' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser' },
];
const SHAPE_WIDTH = 3;
/**
 * The options row has two groups of this many fixed slots (colours, then
 * sizes or shapes), so nothing moves sideways when the tool changes.
 */
const SLOTS = 4;
/** Done waits this long for the drawing before giving up (the page may have died). */
const RESULT_TIMEOUT_MS = 30_000;

type TextDraft = { mode: 'new'; x: number; y: number } | { mode: 'edit'; id: string };

export default function AnnotateScreen() {
  const { docId, pageIndex: pageIndexStr } = useLocalSearchParams<{ docId: string; pageIndex: string }>();
  const pageIndex = parseInt(pageIndexStr ?? '0', 10);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const webRef = useRef<WebView>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false, count: 0 });
  const [tool, setTool] = useState<Tool>('pen');
  const [inkColor, setInkColor] = useState<string>(Ink.black);
  const [penSize, setPenSize] = useState(4);
  const [hlColor, setHlColor] = useState<string>(Highlight.yellow);
  const [hlSize, setHlSize] = useState(24);
  const [eraserSize, setEraserSize] = useState(32);
  const [shape, setShape] = useState<Shape>('rect');
  const [textSize, setTextSize] = useState(20);
  // Text sheet
  const [draft, setDraft] = useState<TextDraft | null>(null);
  const [draftText, setDraftText] = useState('');
  const [draftColor, setDraftColor] = useState<string>(Ink.black);
  const [draftSize, setDraftSize] = useState(20);
  // The page's filter/adjustment when the screen opened. If a bake changes them
  // while the user draws, the page pixels we composite onto are stale and the
  // page is re-baked from the (now inked) .orig after saving.
  const loadedLook = useRef<string>('');
  // The drawing's whole history as the page last reported it (HIST:), kept
  // here so it survives the WebView's content process being killed: the page
  // reloads and gets it back (restoreHistory).
  const historyCopy = useRef<string | null>(null);
  // Done is waiting for the page's RESULT: its timer, and a token so a result
  // that arrives after the timeout is ignored.
  const resultWait = useRef<{ token: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const resultSeq = useRef(0);
  const dirty = history.count > 0;

  const stopWaiting = () => {
    if (resultWait.current) clearTimeout(resultWait.current.timer);
    resultWait.current = null;
  };
  useEffect(() => () => stopWaiting(), []);

  const config = (): MarkupConfig => ({
    tool,
    color: inkColor,
    width: penSize,
    hlColor,
    hlWidth: hlSize,
    eraserWidth: eraserSize,
    shape,
    shapeWidth: SHAPE_WIDTH,
  });
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const docs = await getDocuments();
      const found = docs.find(d => d.id === docId);
      if (cancelled) return;
      // Defend against bad routing: doc deleted, PDF-only doc, or pageIndex
      // out of range. Bail back rather than crashing on `pages[NaN]`.
      if (!found || found.pdfUri || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= found.pages.length) {
        // After an await: the app may be locked now, and back would close /lock.
        navigateWhenUnlocked(() => router.back());
        return;
      }
      loadedLook.current = lookOf(found, pageIndex);
      const uri = pageFileUri(found.id, pageIndex);
      const orig = new File(originalUri(found.id, pageIndex));
      // Loaded by file:// URL (LocalWebView grants read access to the app's
      // container — a device requires it). The query defeats WebKit's image
      // cache after an in-place edit such as a rotate.
      const bust = `?t=${found.updatedAt}`;
      setHtml(buildMarkupHtml(uri + bust, orig.exists ? orig.uri + bust : null, {
        background: colors.chrome,
        guide: colors.chromeAccent,
        config: configRef.current(),
      }));
    })();
    return () => { cancelled = true; };
    // The page is built once; later tool changes go through setConfig.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, pageIndex, router]);

  const inject = (js: string) => {
    if (!webRef.current || !loaded) return;
    webRef.current.injectJavaScript(`${js}; true;`);
  };

  // Every option change reaches the page.
  useEffect(() => {
    if (!loaded || !webRef.current) return;
    webRef.current.injectJavaScript(`setConfig(${JSON.stringify(config())}); true;`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, tool, inkColor, penSize, hlColor, hlSize, eraserSize, shape]);

  const save = async (payload: { page: string; orig: string | null }) => {
    const strip = (d: string) => d.replace(/^data:image\/jpeg;base64,/, '');
    let rebake: { filter: PageFilter; adjustment: PageAdjustment | undefined } | null = null;
    await runPageEdit(docId, { pages: [pageIndex] }, async () => {
      const docs = await getDocuments();
      const current = docs.find(d => d.id === docId);
      if (!current || pageIndex >= current.pages.length) throw new Error('page missing');
      // Written beside the page and its shadow, then renamed over them: a
      // crash mid-write leaves a side file the startup sweep discards, never a
      // truncated page (lib/files.ts: pages are only ever replaced by a rename).
      await FileSystem.writeAsStringAsync(pageSideUri(docId, pageIndex), strip(payload.page), { encoding: 'base64' });
      const orig = new File(originalUri(docId, pageIndex));
      const inkOrig = !!payload.orig && orig.exists;
      if (inkOrig) {
        await FileSystem.writeAsStringAsync(originalSideUri(docId, pageIndex), strip(payload.orig!), { encoding: 'base64' });
      }
      promotePageSide(docId, pageIndex);
      if (inkOrig) promoteOriginalSide(docId, pageIndex);
      // Touch updatedAt so the viewer's images reload. patchDocument merges onto
      // the stored record, so a filter recorded meanwhile isn't overwritten.
      await patchDocument(docId, { updatedAt: Date.now() });
      if (payload.orig && lookOf(current, pageIndex) !== loadedLook.current) {
        rebake = {
          filter: current.filters?.[pageIndex] ?? 'original',
          adjustment: current.adjustments?.[pageIndex],
        };
      }
    });
    if (rebake) {
      const { filter, adjustment } = rebake;
      bakePage(docId, pageIndex, filter, adjustment).catch(err => console.error('Re-bake after annotate failed', err));
    }
  };

  const openText = (next: TextDraft, text: string, color: string, size: number) => {
    setDraftText(text);
    setDraftColor(color);
    setDraftSize(nearestTextSize(size));
    setDraft(next);
  };

  const handleMessage = async (event: { nativeEvent: { data: string } }) => {
    const data = event.nativeEvent.data;
    const body = (prefix: string) => JSON.parse(data.slice(prefix.length));
    if (data.startsWith('READY:')) {
      // A reload after the page's process died: put the drawing back.
      const copy = historyCopy.current;
      if (copy) webRef.current?.injectJavaScript(`restoreHistory(JSON.parse(${JSON.stringify(copy)})); true;`);
      setLoaded(true);
      return;
    }
    if (data.startsWith('HIST:')) {
      historyCopy.current = data.slice('HIST:'.length);
      return;
    }
    if (data === 'LOAD_ERROR') {
      Alert.alert('Couldn’t open this page in Mark up', 'Go back to the page and try again.', [
        { text: 'Close', onPress: () => router.back() },
      ]);
      return;
    }
    if (data.startsWith('STATE:')) {
      setHistory(body('STATE:'));
      return;
    }
    if (data.startsWith('TEXT_NEW:')) {
      const { x, y } = body('TEXT_NEW:') as { x: number; y: number };
      openText({ mode: 'new', x, y }, '', inkColor, textSize);
      return;
    }
    if (data.startsWith('TEXT_EDIT:')) {
      const t = body('TEXT_EDIT:') as { id: string; text: string; color: string; size: number };
      openText({ mode: 'edit', id: t.id }, t.text, t.color, t.size);
      return;
    }
    if (data.startsWith('ERROR:')) {
      if (!resultWait.current) return;
      stopWaiting();
      setSaving(false);
      console.error('Markup render failed', data);
      Alert.alert('Couldn’t save your markup', 'Try again.');
      return;
    }
    if (!data.startsWith('RESULT:')) return;
    // Only the answer Done is waiting for (not one that came after the timeout).
    if (!resultWait.current) return;
    stopWaiting();
    try {
      const payload = body('RESULT:') as { page: string; orig: string | null };
      await save(payload);
      // The drawing comes back from the WebView on its own time: if the app
      // was locked meanwhile, /lock is the top screen and back() would close
      // IT, leaving the editor usable without unlocking. Held until unlocked
      // (lib/nav-guard); this screen draws the lock itself meanwhile
      // (app/_layout.tsx lockCoverLayout).
      navigateWhenUnlocked(() => router.back());
    } catch (err) {
      console.error('Annotate save failed', err);
      Alert.alert('Couldn’t save your markup', 'There may not be enough free space. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDone = () => {
    if (saving) return;
    if (!dirty || !loaded) {
      router.back();
      return;
    }
    setSaving(true);
    const token = ++resultSeq.current;
    const timer = setTimeout(() => {
      if (resultWait.current?.token !== token) return;
      resultWait.current = null;
      setSaving(false);
      Alert.alert('Couldn’t save your markup', 'Try again. Your marks are still on the page.');
    }, RESULT_TIMEOUT_MS);
    resultWait.current = { token, timer };
    inject('getResult()');
  };

  // iOS can kill the WebView's content process (memory pressure, often while
  // the app is in the background): the page goes blank and stops answering.
  // Reload it; READY then restores the drawing from historyCopy.
  const onPageDied = () => {
    setLoaded(false);
    if (resultWait.current) {
      stopWaiting();
      setSaving(false);
      Alert.alert('Couldn’t save your markup', 'Markup had to reload the page. Your marks are back — tap Done again.');
    }
    webRef.current?.reload();
  };

  const handleCancel = () => {
    if (!dirty) {
      router.back();
      return;
    }
    Alert.alert('Discard your markup?', 'The changes you made on this page will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => router.back() },
    ]);
  };

  // Android's back button / gesture works like Cancel: it asks before
  // throwing marks away, and waits while the page is being saved. (iOS has no
  // back gesture on this full-screen modal; BackHandler never fires there.)
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (saving) return true;
      if (!dirty) return false;
      Alert.alert('Discard your markup?', 'The changes you made on this page will be lost.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => router.back() },
      ]);
      return true;
    });
    return () => sub.remove();
  }, [dirty, saving, router]);

  const commitText = () => {
    if (!draft) return;
    const text = draftText.replace(/\s+$/, '');
    if (draft.mode === 'new') {
      if (text) inject(`addText(${draft.x}, ${draft.y}, ${JSON.stringify(text)}, ${JSON.stringify(draftColor)}, ${draftSize})`);
    } else if (text) {
      inject(`updateText(${JSON.stringify(draft.id)}, ${JSON.stringify(text)}, ${JSON.stringify(draftColor)}, ${draftSize})`);
    } else {
      inject(`deleteText(${JSON.stringify(draft.id)})`);
    }
    // The next new text starts with the look just used.
    setInkColor(draftColor);
    setTextSize(draftSize);
    setDraft(null);
  };

  const deleteDraftText = () => {
    if (draft?.mode === 'edit') inject(`deleteText(${JSON.stringify(draft.id)})`);
    setDraft(null);
  };

  const pickTool = (next: Tool) => {
    selection();
    setTool(next);
  };

  // ── Toolbar pieces ────────────────────────────────────────────────────────
  // Every option is drawn the same way: its content in a circle that gets a
  // ring when it is the one chosen (colours, sizes, shapes, text sizes alike).
  const option = (key: string, active: boolean, label: string, onPress: () => void, content: ReactNode) => (
    <View key={key} style={styles.slot}>
      <Pressable
        onPress={() => { selection(); onPress(); }}
        style={({ pressed }) => [styles.optionHit, pressed && { opacity: 0.6 }]}
        accessibilityRole="radio"
        accessibilityLabel={label}
        accessibilityState={{ selected: active }}
      >
        <View style={[styles.ring, { borderColor: active ? colors.chromeText : 'transparent' }]}>{content}</View>
      </Pressable>
    </View>
  );

  /** A group of SLOTS fixed slots, filled from the left (empty slots keep the spacing). */
  const group = (label: string, items: ReactNode[]) => (
    <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {items}
      {Array.from({ length: Math.max(0, SLOTS - items.length) }, (_, i) => <View key={`empty-${i}`} style={styles.slot} />)}
    </View>
  );

  const swatches = (list: { hex: string; label: string }[], value: string, onPick: (hex: string) => void, label: string) =>
    group(label, list.map(c => option(c.hex, value === c.hex, c.label, () => onPick(c.hex), (
      <View style={[styles.swatch, { backgroundColor: c.hex, borderColor: colors.chromeMuted }]} />
    ))));

  const dots = (list: { size: number; label: string }[], value: number, onPick: (n: number) => void, color: string, scale: (n: number) => number) =>
    group('Size', list.map(({ size, label }) => {
      const d = scale(size);
      // The dots show the ink, but a near-black ink vanished on the dark
      // toolbar: those are drawn in the toolbar's text colour instead.
      const fill = color.startsWith('#') && luminance(color) < 0.05 ? colors.chromeText : color;
      return option(String(size), value === size, label, () => onPick(size), (
        <View style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: fill, borderWidth: 1, borderColor: colors.chromeMuted }} />
      ));
    }));

  const iconOptions = <T extends string | number>(
    list: { id: T; icon: IconName; label: string; iconSize?: number }[],
    value: T,
    onPick: (v: T) => void,
    label: string,
  ) =>
    group(label, list.map(o => option(String(o.id), value === o.id, o.label, () => onPick(o.id), (
      <Ionicons name={o.icon} size={o.iconSize ?? 22} color={colors.chromeText} />
    ))));

  const divider = <View style={[styles.divider, { backgroundColor: colors.chromeBorder }]} />;
  const textSizeOptions = TEXT_SIZES.map(t => ({ id: t.size, icon: 'text-outline' as IconName, label: t.label, iconSize: t.icon }));

  // Colours always on the left; sizes (or shapes) always start right after the divider.
  const options = (() => {
    switch (tool) {
      case 'pen':
        return <>{swatches(INK_COLORS, inkColor, setInkColor, 'Pen color')}{divider}{dots(PEN_SIZES, penSize, setPenSize, inkColor, s => s * 2 + 4)}</>;
      case 'highlighter':
        return <>{swatches(HIGHLIGHT_COLORS, hlColor, setHlColor, 'Highlight color')}{divider}{dots(HIGHLIGHT_SIZES, hlSize, setHlSize, hlColor, s => s * 0.75)}</>;
      case 'text':
        return <>{swatches(INK_COLORS, inkColor, setInkColor, 'Text color')}{divider}{iconOptions(textSizeOptions, textSize, setTextSize, 'Text size')}</>;
      case 'shape':
        return <>{swatches(INK_COLORS, inkColor, setInkColor, 'Shape color')}{divider}{iconOptions(SHAPES, shape, setShape, 'Shape')}</>;
      case 'eraser':
        return (
          <>
            <View style={styles.group}>
              <Pressable
                onPress={() => { tapLight(); inject('clearAll()'); }}
                disabled={!dirty}
                style={({ pressed }) => [styles.eraseAll, (pressed || !dirty) && { opacity: dirty ? 0.6 : 0.35 }]}
                accessibilityRole="button"
                accessibilityLabel="Erase all marks"
                accessibilityState={{ disabled: !dirty }}
              >
                <Ionicons name="trash-outline" size={20} color={colors.chromeText} />
                <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={[Type.subhead, { color: colors.chromeText }]}>Erase all</Text>
              </Pressable>
            </View>
            {divider}
            {dots(ERASER_SIZES, eraserSize, setEraserSize, colors.chromeMuted, s => s * 0.7)}
          </>
        );
    }
  })();

  const hint =
    tool === 'text' ? 'Tap to add text. Drag text to move it.'
    : tool === 'shape' ? 'Drag on the page to draw.'
    : tool === 'eraser' ? 'Erases your marks, never the page.'
    : null;

  // Same shape as a tool button (an icon box over a label line), so the
  // arrows line up with the tool icons.
  const historyButton = (icon: IconName, label: string, enabled: boolean, onPress: () => void) => (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      hitSlop={4}
      style={({ pressed }) => [styles.toolBtn, styles.historyBtn, pressed && { opacity: 0.6 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
    >
      <View style={styles.toolIcon}>
        <Ionicons name={icon} size={22} color={enabled ? colors.chromeText : colors.chromeBorder} />
      </View>
      <Text allowFontScaling={false} style={[styles.toolLabel, styles.labelSpacer]} importantForAccessibility="no" accessibilityElementsHidden>
        {' '}
      </Text>
    </Pressable>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.chrome }]}>
      <StatusBar style="light" />
      {/* This screen covers the viewer, whose baker can't run while buried. */}
      <FilterBaker />
      <ScreenHeader
        dark
        title="Mark up"
        left={<HeaderTextButton title="Cancel" color={colors.chromeText} onPress={handleCancel} />}
        right={
          saving ? (
            <ActivityIndicator color={colors.chromeAccent} style={styles.busy} />
          ) : (
            <HeaderTextButton title="Done" emphasis color={colors.chromeAccent} disabled={!loaded} onPress={handleDone} />
          )
        }
      />

      <View style={styles.canvasArea}>
        {html ? (
          <LocalWebView
            ref={webRef}
            html={html}
            style={[styles.webview, { backgroundColor: colors.chrome }]}
            scrollEnabled={false}
            bounces={false}
            onMessage={handleMessage}
            onContentProcessDidTerminate={onPageDied}
            onRenderProcessGone={onPageDied}
            onError={() => {
              Alert.alert('Couldn’t open this page in Mark up', 'Go back to the page and try again.', [
                { text: 'Close', onPress: () => router.back() },
              ]);
            }}
          />
        ) : null}
        {!loaded ? (
          <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: colors.chrome }]} pointerEvents="none">
            <ActivityIndicator color={colors.chromeText} />
          </View>
        ) : hint ? (
          <View style={styles.hintWrap} pointerEvents="none">
            <View style={[styles.hint, { backgroundColor: colors.chromeRaised, borderColor: colors.chromeBorder }]}>
              <Text maxFontSizeMultiplier={1.4} numberOfLines={2} style={[Type.footnote, styles.hintText, { color: colors.chromeText }]}>{hint}</Text>
            </View>
          </View>
        ) : null}
      </View>

      <View style={[styles.toolbar, { paddingBottom: insets.bottom + Spacing.xs, backgroundColor: colors.chromeRaised, borderTopColor: colors.chromeBorder }]}>
        <View style={styles.optionsRow}>{options}</View>
        <View style={styles.toolsRow}>
          {historyButton('arrow-undo-outline', 'Undo', loaded && history.canUndo, () => inject('undo()'))}
          {historyButton('arrow-redo-outline', 'Redo', loaded && history.canRedo, () => inject('redo()'))}
          <View style={[styles.toolsDivider, { backgroundColor: colors.chromeBorder }]} />
          {TOOLS.map(t => {
            const active = tool === t.id;
            return (
              <Pressable
                key={t.id}
                onPress={() => pickTool(t.id)}
                style={({ pressed }) => [styles.toolBtn, pressed && { opacity: 0.6 }]}
                accessibilityRole="button"
                accessibilityLabel={t.label}
                accessibilityState={{ selected: active }}
              >
                <View style={[styles.toolIcon, { backgroundColor: active ? colors.chromeBorder : 'transparent' }]}>
                  <AppIcon name={t.icon} size={22} color={active ? colors.chromeAccent : colors.chromeText} />
                </View>
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.75}
                  maxFontSizeMultiplier={1.3}
                  style={[styles.toolLabel, { color: active ? colors.chromeAccent : colors.chromeMuted }]}
                >
                  {t.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <DarkThemeScope>
        <TextSheet
          draft={draft}
          text={draftText}
          onChangeText={setDraftText}
          color={draftColor}
          onColor={setDraftColor}
          size={draftSize}
          onSize={setDraftSize}
          onCommit={commitText}
          onDelete={deleteDraftText}
          onClose={() => setDraft(null)}
        />
      </DarkThemeScope>
    </View>
  );
}

/** Add or edit a text box: the words, their colour and size. */
function TextSheet({
  draft, text, onChangeText, color, onColor, size, onSize, onCommit, onDelete, onClose,
}: {
  draft: TextDraft | null;
  text: string;
  onChangeText: (t: string) => void;
  color: string;
  onColor: (c: string) => void;
  size: number;
  onSize: (s: number) => void;
  onCommit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const editing = draft?.mode === 'edit';
  const empty = !text.trim();
  return (
    <BottomSheet visible={draft !== null} onClose={onClose}>
      <SheetHeader title={editing ? 'Edit text' : 'Add text'} />
      <TextInput
        value={text}
        onChangeText={onChangeText}
        placeholder="Type your text"
        placeholderTextColor={colors.muted}
        autoFocus
        multiline
        keyboardAppearance="dark"
        selectionColor={colors.accent}
        accessibilityLabel="Text"
        style={[Type.body, styles.textInput, { color: colors.text, backgroundColor: colors.bg }]}
      />
      <View style={styles.sheetOptions}>
        <View style={styles.sheetGroup} accessibilityRole="radiogroup" accessibilityLabel="Text color">
          {INK_COLORS.map(c => {
            const active = color === c.hex;
            return (
              <Pressable
                key={c.hex}
                onPress={() => { selection(); onColor(c.hex); }}
                style={styles.optionHit}
                accessibilityRole="radio"
                accessibilityLabel={c.label}
                accessibilityState={{ selected: active }}
              >
                <View style={[styles.ring, { borderColor: active ? colors.text : 'transparent' }]}>
                  <View style={[styles.swatch, { backgroundColor: c.hex, borderColor: colors.muted }]} />
                </View>
              </Pressable>
            );
          })}
        </View>
        <View style={[styles.divider, styles.sheetDivider, { backgroundColor: colors.border }]} />
        <View style={styles.sheetGroup} accessibilityRole="radiogroup" accessibilityLabel="Text size">
          {TEXT_SIZES.map(t => {
            const active = size === t.size;
            return (
              <Pressable
                key={t.size}
                onPress={() => { selection(); onSize(t.size); }}
                style={styles.optionHit}
                accessibilityRole="radio"
                accessibilityLabel={t.label}
                accessibilityState={{ selected: active }}
              >
                <View style={[styles.ring, { borderColor: active ? colors.text : 'transparent' }]}>
                  <Ionicons name="text-outline" size={t.icon} color={colors.text} />
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>
      <View style={styles.sheetActions}>
        {editing ? (
          <PrimaryButton title="Delete" icon="trash-outline" variant="destructive" onPress={onDelete} style={styles.flex} />
        ) : (
          <PrimaryButton title="Cancel" variant="secondary" onPress={onClose} style={styles.flex} />
        )}
        <PrimaryButton title={editing ? 'Done' : 'Add text'} onPress={onCommit} disabled={!editing && empty} style={styles.flex} />
      </View>
    </BottomSheet>
  );
}

function nearestTextSize(size: number): number {
  let best = TEXT_SIZES[0].size;
  for (const t of TEXT_SIZES) if (Math.abs(t.size - size) < Math.abs(best - size)) best = t.size;
  return best;
}

/** A comparable snapshot of a page's recorded filter + adjustment. */
function lookOf(doc: Document, pageIndex: number): string {
  return JSON.stringify([doc.filters?.[pageIndex] ?? 'original', doc.adjustments?.[pageIndex] ?? null]);
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  busy: { minWidth: 60 },
  center: { alignItems: 'center', justifyContent: 'center' },
  canvasArea: { flex: 1 },
  webview: { flex: 1 },
  hintWrap: { position: 'absolute', top: Spacing.sm, left: Spacing.gutter, right: Spacing.gutter, alignItems: 'center' },
  hint: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toolbar: {
    paddingTop: Spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  optionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    minHeight: HIT + Spacing.xs,
  },
  // Each half of the options row: SLOTS equal slots, whatever the tool.
  group: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  slot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  divider: { width: StyleSheet.hairlineWidth, height: 28, marginHorizontal: Spacing.xs },
  optionHit: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  ring: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatch: { width: 24, height: 24, borderRadius: 12, borderWidth: 1 },
  eraseAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs + 2,
    minHeight: HIT,
    paddingHorizontal: Spacing.md,
  },
  toolsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.sm,
  },
  toolsDivider: { width: StyleSheet.hairlineWidth, height: 32 },
  toolBtn: { flex: 1, minHeight: HIT + 8, alignItems: 'center', justifyContent: 'center', gap: 2 },
  historyBtn: { flex: 0, width: 44 },
  labelSpacer: { opacity: 0 },
  toolIcon: { width: 40, height: 30, borderRadius: Radius.sm + 2, alignItems: 'center', justifyContent: 'center' },
  toolLabel: { fontSize: 11, fontWeight: '500' },
  hintText: { textAlign: 'center' },
  textInput: {
    minHeight: 88,
    maxHeight: 160,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.md,
    lineHeight: 22,
  },
  sheetOptions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: Spacing.sm },
  sheetGroup: { flexDirection: 'row', alignItems: 'center' },
  sheetDivider: { marginHorizontal: Spacing.sm },
  sheetActions: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.md },
});

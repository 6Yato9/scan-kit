// app/tools/timestamp.tsx
// Print the scan date (or today's date) on the pages of the document itself
// (drawn into the pages, so they stay searchable and re-filterable; the viewer
// offers Undo — lib/page-stamp.ts), or of a copy. The date starts in the
// bottom-right corner and is dragged anywhere on the page preview
// (components/placement-frame.tsx LabelPlacer); it settles on the corners,
// the edges' middles and the centre, and always keeps clear of the page edge.
//
// Round 16 made it formattable (lib/timestamp-style.ts): what it says (date
// and time, date only, time only; an optional word such as "Received"), its
// size, colour, weight and strength, a highlight box and a border, the date
// order and the clock, and whether it goes on every page or one. The common
// choices are on the screen, the rest under "More options". Every default is
// the stamp the tool always printed, and the choices are remembered once a
// timestamp is added.
//
// Previews: the page with the stamp where it lands (drag it there), and a
// close-up of that spot, pinned above the options while they scroll, so a
// change of colour or size shows at once at a readable size. Both are drawn
// from lib/stamp.ts resolveStamp, the numbers the canvas bakes with.
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { AppSwitch } from '@/components/app-switch';
import {
  FooterActions,
  NoDocumentsScreen,
  OptionList,
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
import { LabelPlacer } from '@/components/placement-frame';
import { reportStampFailure, usePageStamper, useStampFinish } from '@/components/page-stamper';
import { ValueSlider } from '@/components/value-slider';
import { ColorPalette } from '@/components/color-palette';
import { MoreOptions } from '@/components/more-options';
import { ChoiceChips } from '@/components/choice-chips';
import { TimestampBox, TimestampCloseUp } from '@/components/timestamp-preview';
import { copyName, stampCopy, stampPages, targetPages } from '@/lib/page-stamp';
import { notifySuccess, selection } from '@/lib/haptics';
import {
  CORNER_INSET,
  TIMESTAMP_SIZE_RANGE,
  TIMESTAMP_STRENGTH_RANGE,
  WATERMARK_REF_WIDTH_PT,
  resolveStamp,
  type StampSpec,
} from '@/lib/stamp';
import {
  DEFAULT_TIMESTAMP_PREFS,
  STAMP_WORD_MAX,
  formatStampDate,
  formatTimestampText,
  loadTimestampPrefs,
  saveTimestampPrefs,
  timestampLookSpec,
  type ClockStyle,
  type DateStyle,
  type StampWord,
  type TimestampContent,
  type TimestampPrefs,
  type TimestampWhen,
} from '@/lib/timestamp-style';
import { HIGHLIGHT_PALETTE, INK_PALETTE, TOOL_INKS, type HighlightChoice, type InkChoice } from '@/lib/stamp-colors';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

const CONTENTS: { value: TimestampContent; label: string }[] = [
  { value: 'datetime', label: 'Date and time' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
];
const WORDS: { value: StampWord; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'received', label: 'Received' },
  { value: 'approved', label: 'Approved' },
  { value: 'paid', label: 'Paid' },
  { value: 'custom', label: 'Custom' },
];
const DATE_STYLE_NAMES: Record<DateStyle, string> = {
  device: 'As on this iPhone',
  dmy: 'Day/month/year',
  mdy: 'Month/day/year',
  iso: 'Year-month-day (ISO)',
  long: 'Written out',
};
const CLOCKS: { value: ClockStyle; label: string }[] = [
  { value: 'device', label: 'Automatic' },
  { value: '12h', label: '12-hour' },
  { value: '24h', label: '24-hour' },
];
const WEIGHTS: { value: 'regular' | 'bold'; label: string }[] = [
  { value: 'regular', label: 'Regular' },
  { value: 'bold', label: 'Bold' },
];
/** The text palette, with this tool's own black (#222, what it always printed). */
const TEXT_COLORS = INK_PALETTE.map(p => ({ value: p.id, label: p.label, color: TOOL_INKS.timestamp[p.id] ?? p.hex }));
const HIGHLIGHT_COLORS = HIGHLIGHT_PALETTE.map(p => ({ value: p.id, label: p.label, color: p.hex }));
/** Height of the pinned close-up. */
const CLOSE_UP_H = 76;

/** How many "More options" settings differ from the defaults. */
function changedAdvanced(p: TimestampPrefs): number {
  const d = DEFAULT_TIMESTAMP_PREFS;
  return [
    p.dateStyle !== d.dateStyle,
    p.clock !== d.clock,
    p.bold !== d.bold,
    p.strength !== d.strength,
    p.highlight !== d.highlight,
    p.highlight !== 'none' && p.highlightStrength !== d.highlightStrength,
    p.border !== d.border,
  ].filter(Boolean).length;
}

export default function TimestampScreen() {
  const { colors, isDark } = useTheme();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { docs, loaded, reload } = useToolDocuments();
  // Imported PDFs: listed in the picker with Convert, never a dead end.
  const { pdfs, loaded: pdfsLoaded, reload: reloadPdfs } = useConvertiblePdfs();
  const [p, setP] = useState<TimestampPrefs>(DEFAULT_TIMESTAMP_PREFS);
  const [moreOpen, setMoreOpen] = useState(false);
  // Every page (as before), or only the one shown.
  const [onlyThisPage, setOnlyThisPage] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  // A finger is moving the date: the screen doesn't scroll.
  const [placing, setPlacing] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [now] = useState(() => Date.now());

  // The remembered choices arrive a moment after the screen opens; anything
  // the user has already changed by then wins. A ref, not state: the React
  // Compiler memoises, and this guard must never lag a render behind.
  const touched = useRef(false);
  const set = (patch: Partial<TimestampPrefs>) => {
    touched.current = true;
    setP(prev => ({ ...prev, ...patch }));
  };
  useEffect(() => {
    let live = true;
    loadTimestampPrefs().then(saved => {
      if (!live || touched.current) return;
      setP(saved);
      // Something under More options isn't the default: show it, so the
      // stamp never looks different for a reason the screen hides.
      if (changedAdvanced(saved) > 0) setMoreOpen(true);
    });
    return () => {
      live = false;
    };
  }, []);

  // Never a default: stamping the wrong document is worse than one more tap.
  const { doc, docId, setDocId, fixed, fromViewer, routePage } = useToolDoc(docs);
  const stamper = usePageStamper();
  const finish = useStampFinish(fromViewer);
  // From the Tools tab with a single document: there is nothing to choose.
  useEffect(() => {
    if (loaded && !fixed && !docId && docs.length === 1) setDocId(docs[0].id);
  }, [loaded, fixed, docId, docs, setDocId]);
  // A document starts on its first page — or, opened from the viewer, on the
  // page it was showing (its Tools sheet passes it).
  const startedOn = useRef<string | null>(null);
  useEffect(() => {
    if (doc && startedOn.current !== doc.id) {
      startedOn.current = doc.id;
      setPageIndex(fixed && routePage != null ? Math.min(routePage, doc.pages.length - 1) : 0);
    }
  }, [doc, fixed, routePage]);
  const pageCount = doc?.pages.length ?? 0;
  const page = Math.min(pageIndex, Math.max(0, pageCount - 1));
  const pageUri = doc ? doc.pages[page] : null;
  const aspect = useImageAspect(pageUri);

  const lookSpec = timestampLookSpec(p);
  const textAt = (ts: number) => formatTimestampText(ts, p);
  const sampleTs = p.when === 'scanned' && doc ? doc.createdAt : now;
  const stampText = textAt(sampleTs);
  // `corner` is the nearest one, for anything that reads only that.
  const corner = `${p.anchor.y < 0.5 ? 'top' : 'bottom'}-${p.anchor.x < 0.5 ? 'left' : 'right'}` as const;
  const specFor = (text: string): Extract<StampSpec, { kind: 'timestamp' }> => ({
    kind: 'timestamp',
    text,
    corner,
    anchor: p.anchor,
    ...lookSpec,
  });
  const resolved = resolveStamp(specFor(stampText));
  const r = resolved.kind === 'timestamp' ? resolved : null;
  const hasText = stampText.trim().length > 0;

  const pages = doc ? targetPages(doc.pages.length, page, !onlyThisPage) : [];

  /** Stamps the pages of the document itself (Undo in the viewer), or of a copy. */
  const apply = async (mode: 'in-place' | 'copy') => {
    if (!doc || progress || !hasText) return;
    saveTimestampPrefs(p);
    const spec = specFor(textAt(p.when === 'scanned' ? doc.createdAt : Date.now()));
    const render = (pageUri: string, origUri: string | null) => stamper.stamp(pageUri, origUri, spec);
    const onProgress = (done: number, total: number) => setProgress({ current: done, total });
    setProgress({ current: 0, total: pages.length });
    try {
      if (mode === 'copy') {
        const copy = await stampCopy(doc, copyName(doc.name, 'timestamped'), pages, render, onProgress, stamper.signal);
        notifySuccess();
        finish({ docId: copy.id, message: 'Timestamped copy saved. The original is unchanged.', page: pages[0], openCopy: true });
      } else {
        const { undo } = await stampPages(doc.id, pages, render, { onProgress, signal: stamper.signal });
        notifySuccess();
        finish({
          docId: doc.id,
          message:
            pages.length > 1
              ? `Timestamp added to ${pages.length} pages`
              : doc.pages.length > 1
                ? `Timestamp added to page ${pages[0] + 1}`
                : 'Timestamp added',
          page: pages[0],
          undo,
          undoneMessage: 'Timestamp removed',
        });
      }
    } catch (err) {
      // Says only what is true: cancelled (closed), partly done, or unchanged.
      reportStampFailure(err, 'Couldn’t add the timestamp', 'Timestamp removed');
    } finally {
      setProgress(null);
    }
  };

  // Picking an imported PDF converts it to pages (with Undo), then chooses it.
  const convert: PickerConvert = {
    pdfs,
    verb: 'timestamp',
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
        toolTitle="Timestamp"
        icon="time-outline"
        subtitle="Timestamp prints the date on the pages of a scan. Scan or import a document first."
      />
    );
  }

  // Large enough to drag the date with a finger; never taller than about a
  // third of the screen, so the pinned close-up and the options fit below it.
  const maxPreviewW = screenW - Spacing.gutter * 2 - Spacing.sm * 2;
  const maxPreviewH = Math.max(200, (screenH - insets.top - insets.bottom) * 0.34);
  const previewW = Math.floor(Math.min(maxPreviewW, maxPreviewH / aspect));
  const previewH = previewW * aspect;
  const multiPage = pageCount > 1;
  const goTo = (i: number) => {
    const next = Math.min(Math.max(0, i), pageCount - 1);
    if (next === page) return;
    setPageIndex(next);
    selection();
  };
  const sizeAuto = p.sizePt == null;
  const sizeShown = r ? Math.round(r.fontFrac * WATERMARK_REF_WIDTH_PT) : 10;
  const primaryTitle = doc && onlyThisPage && multiPage ? `Add to page ${page + 1}` : 'Add timestamp';

  return (
    <ToolScreen
      title="Timestamp"
      busy={!!progress}
      scrollEnabled={!placing}
      // The close-up (fourth child) stays in view while the options scroll.
      stickyHeaderIndices={[3]}
      footer={
        <>
          {progress ? (
            <ToolProgress
              label={progress.total > 1 ? `Stamping page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…` : 'Stamping…'}
              current={progress.current}
              total={progress.total}
            />
          ) : null}
          <FooterActions
            secondary={
              <PrimaryButton title="Save as a copy" variant="secondary" onPress={() => apply('copy')} disabled={!doc || !hasText || !!progress} />
            }
            primary={<PrimaryButton title={primaryTitle} onPress={() => apply('in-place')} disabled={!doc || !hasText} loading={!!progress} />}
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

      {/* Child 2: the page with the stamp exactly where it lands. Drag it to move it. */}
      <View style={styles.previewWrap}>
        {doc && pageUri && r ? (
          <LabelPlacer
            uri={`${pageUri}?v=${doc.updatedAt}`}
            width={previewW}
            height={previewH}
            inset={CORNER_INSET * previewW}
            anchor={p.anchor}
            onChange={anchor => set({ anchor })}
            onInteracting={setPlacing}
            label="Timestamp"
          >
            <TimestampBox r={r} fontSize={r.fontFrac * previewW} />
          </LabelPlacer>
        ) : (
          <PagePreview uri={null} aspect={aspect} width={previewW} />
        )}
        {multiPage ? (
          <View style={styles.pager}>
            <Pressable
              onPress={() => goTo(page - 1)}
              disabled={page === 0}
              accessibilityRole="button"
              accessibilityLabel="Previous page"
              style={({ pressed }) => [styles.pageBtn, pressed && styles.pressed]}
            >
              <Ionicons name="chevron-back" size={22} color={page === 0 ? colors.faint : colors.accent} />
            </Pressable>
            <Text style={[Type.subhead, styles.pagerText, { color: colors.text }]} maxFontSizeMultiplier={1.4} accessibilityLiveRegion="polite">
              {`Page ${page + 1} of ${pageCount}`}
            </Text>
            <Pressable
              onPress={() => goTo(page + 1)}
              disabled={page >= pageCount - 1}
              accessibilityRole="button"
              accessibilityLabel="Next page"
              style={({ pressed }) => [styles.pageBtn, pressed && styles.pressed]}
            >
              <Ionicons name="chevron-forward" size={22} color={page >= pageCount - 1 ? colors.faint : colors.accent} />
            </Pressable>
          </View>
        ) : null}
        <ToolNote>
          {doc ? 'Drag the timestamp to move it. It settles on the corners and the middle of each edge.' : 'Choose a document to place the timestamp on its pages.'}
        </ToolNote>
      </View>

      {/* Child 3, pinned: the stamp up close, as it will print. */}
      <View style={[styles.closeUpWrap, { backgroundColor: colors.bg }]}>
        {doc && pageUri && r ? (
          <TimestampCloseUp uri={`${pageUri}?v=${doc.updatedAt}`} aspect={aspect} anchor={p.anchor} r={r} height={CLOSE_UP_H} />
        ) : null}
      </View>

      {multiPage ? (
        <>
          <SectionLabel>Pages</SectionLabel>
          <Segmented
            options={[
              { value: 'all', label: `All ${pageCount} pages` },
              { value: 'one', label: `Page ${page + 1} only` },
            ]}
            value={onlyThisPage ? 'one' : 'all'}
            onChange={v => setOnlyThisPage(v === 'one')}
          />
        </>
      ) : null}

      <SectionLabel>Date</SectionLabel>
      <OptionList
        options={[
          // Both rows always carry a detail line, so they are the same height.
          { value: 'scanned' as TimestampWhen, label: 'Date scanned', detail: doc ? textAt(doc.createdAt) : 'From the document you choose' },
          { value: 'now' as TimestampWhen, label: 'Current date', detail: textAt(now) },
        ]}
        value={p.when}
        onChange={when => set({ when })}
      />

      <SectionLabel>Show</SectionLabel>
      <Segmented options={CONTENTS} value={p.content} onChange={content => set({ content })} />

      <SectionLabel>Label</SectionLabel>
      <ChoiceChips options={WORDS} value={p.word} onChange={word => set({ word })} accessibilityLabel="Label in front of the date" />
      {p.word === 'custom' ? (
        <TextInput
          style={[Type.body, styles.input, { color: colors.text, backgroundColor: colors.card }]}
          value={p.customWord}
          onChangeText={customWord => set({ customWord })}
          placeholder="For example, Checked"
          placeholderTextColor={colors.muted}
          returnKeyType="done"
          maxLength={STAMP_WORD_MAX}
          keyboardAppearance={isDark ? 'dark' : 'light'}
          accessibilityLabel="Label text"
        />
      ) : null}

      <SectionRow label="Size" action={sizeAuto ? undefined : 'Reset'} onAction={() => set({ sizePt: null })} />
      <ValueSlider
        label="Timestamp size"
        value={Math.min(TIMESTAMP_SIZE_RANGE.max, Math.max(TIMESTAMP_SIZE_RANGE.min, sizeShown))}
        min={TIMESTAMP_SIZE_RANGE.min}
        max={TIMESTAMP_SIZE_RANGE.max}
        step={1}
        format={v => `${v} pt`}
        onChange={sizePt => set({ sizePt })}
      />

      <SectionLabel>Color</SectionLabel>
      <ColorPalette
        options={TEXT_COLORS}
        value={p.color}
        onChange={v => set({ color: v as InkChoice })}
        custom={p.customColor}
        onCustomChange={customColor => set({ customColor })}
        accessibilityLabel="Text color"
      />

      <MoreOptions open={moreOpen} onToggle={setMoreOpen} changed={changedAdvanced(p)}>
        {p.content !== 'time' ? (
          <>
            <SectionLabel>Date style</SectionLabel>
            <OptionList
              options={(['device', 'dmy', 'mdy', 'iso', 'long'] as DateStyle[]).map(s => ({
                value: s,
                label: DATE_STYLE_NAMES[s],
                detail: formatStampDate(sampleTs, s),
              }))}
              value={p.dateStyle}
              onChange={dateStyle => set({ dateStyle })}
            />
          </>
        ) : null}
        {p.content !== 'date' ? (
          <>
            <SectionLabel>Clock</SectionLabel>
            <Segmented options={CLOCKS} value={p.clock} onChange={clock => set({ clock })} />
          </>
        ) : null}

        <SectionLabel>Weight</SectionLabel>
        <Segmented options={WEIGHTS} value={p.bold ? 'bold' : 'regular'} onChange={v => set({ bold: v === 'bold' })} />

        <SectionRow
          label="Strength"
          action={p.strength !== DEFAULT_TIMESTAMP_PREFS.strength ? 'Reset' : undefined}
          onAction={() => set({ strength: DEFAULT_TIMESTAMP_PREFS.strength })}
        />
        <ValueSlider
          label="Timestamp strength"
          value={p.strength}
          min={TIMESTAMP_STRENGTH_RANGE.min}
          max={TIMESTAMP_STRENGTH_RANGE.max}
          step={5}
          format={v => `${v}%`}
          onChange={strength => set({ strength })}
        />

        <SectionLabel>Highlight</SectionLabel>
        <ColorPalette
          options={HIGHLIGHT_COLORS}
          value={p.highlight}
          onChange={v => set({ highlight: v as HighlightChoice })}
          none
          custom={p.customHighlight}
          onCustomChange={customHighlight => set({ customHighlight })}
          accessibilityLabel="Highlight color"
        />
        {p.highlight !== 'none' ? (
          <>
            <SectionRow
              label="Highlight strength"
              action={p.highlightStrength !== DEFAULT_TIMESTAMP_PREFS.highlightStrength ? 'Reset' : undefined}
              onAction={() => set({ highlightStrength: DEFAULT_TIMESTAMP_PREFS.highlightStrength })}
            />
            <ValueSlider
              label="Highlight strength"
              value={p.highlightStrength}
              min={TIMESTAMP_STRENGTH_RANGE.min}
              max={TIMESTAMP_STRENGTH_RANGE.max}
              step={5}
              format={v => `${v}%`}
              onChange={highlightStrength => set({ highlightStrength })}
            />
          </>
        ) : null}

        <View style={[styles.switchRow, { backgroundColor: colors.card }]}>
          <Text style={[Type.body, styles.flex, { color: colors.text }]} maxFontSizeMultiplier={1.5}>
            Border
          </Text>
          <AppSwitch value={p.border} onValueChange={border => set({ border })} accessibilityLabel="Border around the timestamp" />
        </View>
      </MoreOptions>

      <ToolNote>
        {onlyThisPage && multiPage
          ? 'Size is in points on an A4-wide page. The timestamp becomes part of the page, and you can undo it right after. To keep this document as it is, save a timestamped copy instead.'
          : 'Size is in points on an A4-wide page and scales with each page. The timestamp becomes part of every page, and you can undo it right after. To keep this document as it is, save a timestamped copy instead.'}
      </ToolNote>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  previewWrap: { marginTop: Spacing.lg },
  // Pinned while scrolling: an opaque band the full width of the screen (out
  // over the body's gutters) so the options pass cleanly under it.
  closeUpWrap: {
    marginHorizontal: -Spacing.gutter,
    paddingHorizontal: Spacing.gutter,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xs,
  },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: Spacing.xs },
  pageBtn: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  pagerText: { minWidth: 110, textAlign: 'center' },
  pressed: { opacity: 0.5 },
  input: { borderRadius: Radius.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, marginTop: Spacing.sm },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.lg,
    minHeight: HIT + 8,
    marginTop: Spacing.xxl,
  },
});

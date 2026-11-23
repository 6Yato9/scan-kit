// app/tools/redact.tsx
// Redact: black out what must not be shared. Choose a document, then on each
// page draw boxes by dragging, or find text — a word, a name, a number, or
// every email address / phone number — and every match on every page gets a
// box (lib/redact.ts says how a match inside a line is placed). Each box can
// be moved, resized or removed.
//
// Redacting burns the boxes into the pages in solid black through the stamp
// pipeline (lib/page-stamp.ts with `redact`): into each page AND its
// unfiltered shadow, its kept source photo is removed (Crop › Full page would
// show it uncovered), and the document's recognised text is rebuilt from the
// redacted pages before this screen moves on. Then the pages are read again:
// anything searched for that is still readable under a box is reported and
// boxed again, wider. Undo is offered in the viewer only while its toast
// shows; "Save as a copy" leaves the original as it is.
//
// Round 16: the boxes' colour (black by default, or any palette colour —
// white for a clean look, gray, red…) and an optional "REDACTED" across each
// box, set in a Style sheet (the chip beside the find shortcuts) and
// remembered (lib/stamp-prefs.ts). Whatever the colour, a box is burned in
// fully opaque, so the pixels under it are replaced, never just covered; the
// word is drawn on top of the opaque box afterwards.
//
// Imported PDFs are listed with Convert (components/tool-doc.tsx): a PDF's
// text layer can't be redacted in place, so its pages become images first,
// and once they are redacted the PDF kept for undoing that conversion is
// deleted too (lib/redact-run.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { HeaderTextButton } from '@/components/screen-header';
import { AppSwitch } from '@/components/app-switch';
import { BottomSheet, SheetHeader } from '@/components/bottom-sheet';
import { ColorPalette } from '@/components/color-palette';
import {
  FooterActions,
  NoDocumentsScreen,
  ToolProgress,
  ToolScreen,
  useImageAspect,
  useToolDocuments,
} from '@/components/tool-ui';
import { ToolDocPicker, useConvertiblePdfs, useToolDoc, type PickerConvert } from '@/components/tool-doc';
import { FilterBaker } from '@/components/filter-baker';
import { reportStampFailure, usePageStamper, useStampFinish } from '@/components/page-stamper';
import { RedactEditor } from '@/components/redact-editor';
import { copyName, discardStampUndo, stampCopy, stampPages } from '@/lib/page-stamp';
import {
  addProposals,
  boxesSummary,
  findSummary,
  grow,
  MIN_TERM_LENGTH,
  normalizeTerm,
  type Finder,
  type RedactBox,
  type RedactRect,
  type RedactSource,
} from '@/lib/redact';
import { discardConvertStashes, findInDocument, findLeftovers, ocrAvailable } from '@/lib/redact-run';
import { OcrAbortedError } from '@/lib/ocr';
import { notifyError, notifySuccess, selection } from '@/lib/haptics';
import { REDACT_LABEL } from '@/lib/stamp';
import { INK_PALETTE, TOOL_INKS, contrastOn, inkHex, inkLabel, type InkChoice } from '@/lib/stamp-colors';
import { DEFAULT_REDACT_PREFS, loadRedactPrefs, saveRedactPrefs, type RedactPrefs } from '@/lib/stamp-prefs';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import type { Document } from '@/types/document';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

const PRESETS: { kind: 'email' | 'phone'; label: string; spoken: string; icon: IconName }[] = [
  { kind: 'email', label: 'Emails', spoken: 'email addresses', icon: 'mail-outline' },
  { kind: 'phone', label: 'Phone numbers', spoken: 'phone numbers', icon: 'call-outline' },
];

/** Box colours: the palette, in Redact's own pure black and mid gray. */
const BOX_COLORS = INK_PALETTE.map(p => ({ value: p.id, label: p.label, color: TOOL_INKS.redact[p.id] ?? p.hex }));

/** Boxes per page index. */
type PageBoxes = Record<number, RedactBox[]>;

const pagesWithBoxes = (all: PageBoxes, pageCount: number) =>
  Array.from({ length: pageCount }, (_, i) => i).filter(i => (all[i]?.length ?? 0) > 0);

const rects = (boxes: RedactBox[] | undefined): RedactRect[] => (boxes ?? []).map(({ x, y, w, h }) => ({ x, y, w, h }));

export default function RedactScreen() {
  const { colors, isDark } = useTheme();
  const { docs, loaded, reload } = useToolDocuments();
  const { pdfs, loaded: pdfsLoaded, reload: reloadPdfs } = useConvertiblePdfs();
  const { doc, docId, setDocId, fixed, fromViewer, routePage } = useToolDoc(docs);
  const stamper = usePageStamper();
  const finish = useStampFinish(fromViewer);

  const [boxes, setBoxes] = useState<PageBoxes>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const [finding, setFinding] = useState<{ done: number; total: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number; text?: boolean } | null>(null);
  const [area, setArea] = useState<{ width: number; height: number } | null>(null);
  // How the boxes are burned in, remembered; a choice made before the
  // remembered one arrives wins (a ref: it must never lag a render behind).
  const [look, setLook] = useState<RedactPrefs>(DEFAULT_REDACT_PREFS);
  const [styling, setStyling] = useState(false);
  const lookTouched = useRef(false);
  const setLookPatch = (patch: Partial<RedactPrefs>) => {
    lookTouched.current = true;
    setLook(prev => ({ ...prev, ...patch }));
  };
  useEffect(() => {
    let live = true;
    loadRedactPrefs().then(p => {
      if (live && !lookTouched.current) setLook(p);
    });
    return () => {
      live = false;
    };
  }, []);
  const fill = inkHex(look.color, look.customColor, TOOL_INKS.redact, 'black');
  const colorName = look.color === 'custom' ? 'your custom color' : `solid ${inkLabel(look.color).toLowerCase()}`;
  // What was searched for, to check after redacting that none of it is still readable.
  const finders = useRef<Finder[]>([]);
  const findAbort = useRef<AbortController | null>(null);
  useEffect(() => () => findAbort.current?.abort(), []);

  // From the Tools tab with a single document: there is nothing to choose.
  useEffect(() => {
    if (loaded && !fixed && !docId && docs.length === 1) setDocId(docs[0].id);
  }, [loaded, fixed, docId, docs, setDocId]);

  // A different document starts clean, on its first page — or, opened from
  // the viewer's Tools sheet, on the page it was showing.
  const boxesFor = useRef<string | null>(null);
  useEffect(() => {
    if (!doc || boxesFor.current === doc.id) return;
    boxesFor.current = doc.id;
    findAbort.current?.abort();
    setBoxes({});
    setPageIndex(routePage ?? 0);
    setSelectedId(null);
    setStatus(null);
    finders.current = [];
  }, [doc, routePage]);

  const pageCount = doc?.pages.length ?? 0;
  const page = Math.min(pageIndex, Math.max(0, pageCount - 1));
  const pageUri = doc ? doc.pages[page] : null;
  const aspect = useImageAspect(pageUri);
  const counts = useMemo(() => Array.from({ length: pageCount }, (_, i) => boxes[i]?.length ?? 0), [boxes, pageCount]);
  const total = counts.reduce((a, b) => a + b, 0);
  const targets = doc ? pagesWithBoxes(boxes, doc.pages.length) : [];
  const busy = !!progress;
  const canFind = ocrAvailable();

  const setPageBoxes = useCallback((list: RedactBox[]) => {
    setBoxes(prev => ({ ...prev, [page]: list }));
  }, [page]);

  const goTo = (i: number) => {
    if (!doc) return;
    const next = Math.min(Math.max(0, i), doc.pages.length - 1);
    if (next === page) return;
    setPageIndex(next);
    setSelectedId(null);
    selection();
  };

  const runFind = async (finder: Finder, source: RedactSource) => {
    if (!doc || finding || busy) return;
    if (finder.kind === 'term' && normalizeTerm(finder.term).length < MIN_TERM_LENGTH) {
      setStatus(`Type at least ${MIN_TERM_LENGTH} characters to search.`);
      return;
    }
    Keyboard.dismiss();
    findAbort.current?.abort();
    const controller = new AbortController();
    findAbort.current = controller;
    setFinding({ done: 0, total: doc.pages.length });
    try {
      const found = await findInDocument(doc.pages, finder, {
        signal: controller.signal,
        onPage: (done, n) => setFinding({ done, total: n }),
      });
      if (controller.signal.aborted) return;
      let added = 0;
      let covered = 0;
      let pagesHit = 0;
      let first = -1;
      const next: PageBoxes = { ...boxes };
      found.forEach((list, i) => {
        if (!list.length) return;
        const r = addProposals(next[i] ?? [], list, source);
        next[i] = r.boxes;
        added += r.added;
        covered += list.length - r.added;
        if (r.added) {
          pagesHit += 1;
          if (first < 0) first = i;
        }
      });
      setBoxes(next);
      const key = JSON.stringify(finder);
      if ((added || covered) && !finders.current.some(f => JSON.stringify(f) === key)) finders.current.push(finder);
      setStatus(findSummary(finder, added, pagesHit, covered));
      if (added) {
        notifySuccess();
        // Show where the matches are when this page has none of them.
        if (first >= 0 && !(found[page]?.length)) {
          setPageIndex(first);
          setSelectedId(null);
        }
      }
    } catch (err) {
      if (err instanceof OcrAbortedError || controller.signal.aborted) return;
      setStatus('Couldn’t read the pages. Try again.');
    } finally {
      if (findAbort.current === controller) {
        findAbort.current = null;
        setFinding(null);
      }
    }
  };

  const clearAll = () => {
    Alert.alert('Remove all boxes?', 'Boxes on every page are removed. Nothing has been redacted yet.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove all',
        style: 'destructive',
        onPress: () => {
          setBoxes({});
          setSelectedId(null);
          setStatus(null);
          finders.current = [];
        },
      },
    ]);
  };

  /**
   * After a redaction: anything searched for still readable under a box? Then
   * the box was too small — say so and box it again, wider, for another pass.
   */
  const checkLeftovers = async (target: Document, indices: number[], labelled: boolean): Promise<boolean> => {
    const applied = new Map(indices.map(i => [i, rects(boxes[i])] as const));
    const left = await findLeftovers(target.pages, applied, finders.current, labelled);
    if (left.size === 0) return false;
    const next: PageBoxes = {};
    for (const [i, list] of left) next[i] = addProposals([], list.map(r => grow(r, 0.25)), 'search').boxes;
    const listed = [...left.keys()].sort((a, b) => a - b);
    setBoxes(next);
    setPageIndex(listed[0]);
    setSelectedId(null);
    setStatus(boxesSummary(listed.map(i => next[i].length)));
    notifyError();
    Alert.alert(
      'Some text is still readable',
      `Part of what you searched for can still be read on ${listed.length === 1 ? `page ${listed[0] + 1}` : `${listed.length} pages`}. It’s boxed again, a little wider — check the boxes and redact again.`,
    );
    return true;
  };

  const apply = async (mode: 'in-place' | 'copy') => {
    if (!doc || busy || targets.length === 0) return;
    findAbort.current?.abort();
    const pages = [...targets];
    const specs = new Map(pages.map(i => [i, rects(boxes[i])] as const));
    saveRedactPrefs(look);
    const style = { fill, label: look.label };
    const render = (pageUri: string, origUri: string | null, index: number) =>
      stamper.stamp(pageUri, origUri, { kind: 'redact', boxes: specs.get(index) ?? [], ...style });
    const onProgress = (done: number, n: number) => setProgress({ current: done, total: n, text: done >= n });
    setSelectedId(null);
    setProgress({ current: 0, total: pages.length });
    try {
      if (mode === 'copy') {
        const copy = await stampCopy(doc, copyName(doc.name, 'redacted'), pages, render, onProgress, stamper.signal, { redact: true });
        reload();
        if (await checkLeftovers(copy, pages, style.label)) {
          setDocId(copy.id);
          boxesFor.current = copy.id;
          return;
        }
        notifySuccess();
        finish({ docId: copy.id, message: 'Redacted copy saved. The original is unchanged.', page: pages[0], openCopy: true });
      } else {
        const { doc: after, undo } = await stampPages(doc.id, pages, render, {
          onProgress,
          signal: stamper.signal,
          redact: true,
        });
        // The PDF this was converted from still holds the text: it goes.
        discardConvertStashes(doc.id);
        reload();
        if (await checkLeftovers(after, pages, style.label)) {
          // Still being redacted: the Undo copy (unredacted pixels) isn't kept around.
          discardStampUndo(undo);
          return;
        }
        notifySuccess();
        finish({
          docId: doc.id,
          message: pages.length > 1 ? `Redacted ${pages.length} pages` : doc.pages.length > 1 ? `Redacted page ${pages[0] + 1}` : 'Redacted',
          page: pages[0],
          undo,
          undoneMessage: 'Redaction undone',
        });
      }
    } catch (err) {
      reportStampFailure(err, 'Couldn’t redact the document', 'Redaction undone');
    } finally {
      setProgress(null);
    }
  };

  const confirmApply = () => {
    if (!doc || busy || targets.length === 0) return;
    const where = targets.length > 1 ? `${targets.length} pages` : doc.pages.length > 1 ? `page ${targets[0] + 1}` : 'the page';
    Alert.alert(
      `Redact ${where}?`,
      `The boxes are burned into the page in ${colorName}${look.label ? ', with “REDACTED” across them' : ''}, and the text under them is removed from the document. You can undo it only until the confirmation at the bottom of the screen goes away.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save as a copy', onPress: () => { void apply('copy'); } },
        { text: 'Redact', style: 'destructive', onPress: () => { void apply('in-place'); } },
      ],
    );
  };

  // Picking an imported PDF converts it to pages (with Undo), then chooses it.
  const convert: PickerConvert = {
    pdfs,
    verb: 'redact',
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
        toolTitle="Redact"
        icon="eye-off-outline"
        subtitle="Redact blacks out names, numbers and anything else on a page before you share it. Scan or import a document first."
      />
    );
  }

  // The page as large as the space left allows.
  // The editor's frame adds Spacing.sm on every side; the area has the gutters and a top gap.
  const pad = Spacing.sm * 2;
  const pageW = area
    ? Math.floor(Math.max(0, Math.min(area.width - Spacing.gutter * 2 - pad, (area.height - Spacing.sm - pad) / aspect)))
    : 0;
  const pageH = Math.floor(pageW * aspect);
  const sel = selectedId ? boxes[page]?.find(b => b.id === selectedId) : null;
  const hint = !doc
    ? 'Choose a document, then draw boxes over what to hide.'
    : finding
      ? `Reading page ${Math.min(finding.done + 1, finding.total)} of ${finding.total}…`
      : status ?? (sel ? 'Drag the box or its corners to adjust it. Pinch to zoom in.' : 'Drag on the page to draw a box. Pinch to zoom in.');

  const progressLabel = !progress
    ? ''
    : progress.text
      ? 'Removing the hidden text from the document…'
      : progress.total > 1
        ? `Redacting page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…`
        : 'Redacting…';

  return (
    <ToolScreen
      title="Redact"
      scroll={false}
      footerHidesForKeyboard
      busy={busy}
      confirmBack={total > 0 ? {
        title: 'Discard your redactions?',
        message: total === 1 ? 'The box you drew won’t be applied.' : `The ${total} boxes you drew won’t be applied.`,
      } : null}
      right={total > 0 && !busy ? <HeaderTextButton title="Clear" onPress={clearAll} /> : undefined}
      footer={
        <>
          {progress ? <ToolProgress label={progressLabel} current={progress.current} total={progress.total} /> : null}
          <FooterActions
            secondary={
              <PrimaryButton title="Save as a copy" variant="secondary" onPress={() => { void apply('copy'); }} disabled={!doc || total === 0 || busy || !!finding} />
            }
            primary={
              <PrimaryButton
                title={total > 0 ? `Redact ${boxesSummary([total])}` : 'Redact'}
                onPress={confirmApply}
                disabled={!doc || total === 0 || !!finding}
                loading={busy}
              />
            }
          />
        </>
      }
    >
      {fromViewer ? <FilterBaker /> : null}
      {stamper.host}
      <ScrollView
        style={styles.top}
        contentContainerStyle={styles.topBody}
        scrollEnabled={false}
        keyboardShouldPersistTaps="handled"
      >
        <ToolDocPicker
          docs={docs}
          doc={doc}
          fixed={fixed}
          disabled={busy || !!finding}
          onPick={(d: Document) => setDocId(d.id)}
          autoOpen={loaded && !fromViewer}
          convert={convert}
        />

        {/* Find text: a term, or every email address / phone number. */}
        <View style={[styles.search, { backgroundColor: colors.card }, (!doc || !canFind) && styles.dim]}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            style={[Type.body, styles.searchInput, { color: colors.text }]}
            value={term}
            onChangeText={setTerm}
            placeholder={canFind ? 'Find text to redact' : 'Text search isn’t available'}
            placeholderTextColor={colors.muted}
            editable={!!doc && canFind && !busy && !finding}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            keyboardAppearance={isDark ? 'dark' : 'light'}
            onSubmitEditing={() => { void runFind({ kind: 'term', term }, 'search'); }}
            accessibilityLabel="Find text to redact"
          />
          {finding ? (
            <ActivityIndicator color={colors.muted} />
          ) : term.trim() ? (
            <Pressable
              onPress={() => { void runFind({ kind: 'term', term }, 'search'); }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Find"
              style={({ pressed }) => [styles.findBtn, { backgroundColor: colors.accentFill }, pressed && { opacity: 0.7 }]}
            >
              <Text style={[Type.subhead, { color: colors.onAccent, fontWeight: '600' }]}>Find</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.chips}>
          {PRESETS.map(p => (
            <Pressable
              key={p.kind}
              onPress={() => { void runFind({ kind: p.kind }, p.kind); }}
              disabled={!doc || !canFind || busy || !!finding}
              hitSlop={CHIP_SLOP}
              accessibilityRole="button"
              accessibilityLabel={`Find all ${p.spoken}`}
              style={({ pressed }) => [
                styles.chip,
                { backgroundColor: colors.accentLight },
                (!doc || !canFind) && styles.dim,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Ionicons name={p.icon} size={15} color={colors.accent} />
              <Text style={[Type.footnote, styles.chipText, { color: colors.accent }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>
                {p.label}
              </Text>
            </Pressable>
          ))}
          {/* How the boxes look: a swatch of their colour, and the sheet to change it. */}
          <Pressable
            onPress={() => setStyling(true)}
            disabled={busy}
            hitSlop={CHIP_SLOP}
            accessibilityRole="button"
            accessibilityLabel="Box style"
            accessibilityValue={{ text: `${inkLabel(look.color)}${look.label ? ', labeled' : ''}` }}
            style={({ pressed }) => [styles.chip, styles.styleChip, { backgroundColor: colors.card, borderColor: colors.border }, pressed && { opacity: 0.6 }]}
          >
            <View style={[styles.styleDot, { backgroundColor: fill, borderColor: colors.ring }]} />
            <Text style={[Type.footnote, styles.chipText, { color: colors.text }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>
              Style
            </Text>
          </Pressable>
        </View>
        <Text style={[Type.footnote, styles.hint, { color: colors.muted }]} numberOfLines={2} accessibilityLiveRegion="polite">
          {hint}
        </Text>
      </ScrollView>

      {/* The page, as large as the space left allows. */}
      <View
        style={styles.pageArea}
        onLayout={e => {
          const { width, height } = e.nativeEvent.layout;
          if (!area || Math.abs(area.width - width) > 1 || Math.abs(area.height - height) > 1) setArea({ width, height });
        }}
      >
        {doc && pageUri && pageW > 0 ? (
          <RedactEditor
            key={`${doc.id}-${page}`}
            uri={`${pageUri}?v=${doc.updatedAt}`}
            width={pageW}
            height={pageH}
            boxes={boxes[page] ?? []}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChange={setPageBoxes}
            fill={fill}
            label={look.label ? { text: REDACT_LABEL, color: contrastOn(fill) } : null}
          />
        ) : (
          <View style={[styles.placeholder, { borderColor: colors.border, width: pageW + pad, height: pageH + pad }]}>
            <Ionicons name="eye-off-outline" size={28} color={colors.faint} />
          </View>
        )}
      </View>

      {/* Pages: back / forward, and how many boxes this page has. */}
      <View style={styles.pager}>
        <Pressable
          onPress={() => goTo(page - 1)}
          disabled={!doc || page === 0}
          accessibilityRole="button"
          accessibilityLabel="Previous page"
          style={({ pressed }) => [styles.pageBtn, pressed && { opacity: 0.5 }]}
        >
          <Ionicons name="chevron-back" size={22} color={!doc || page === 0 ? colors.faint : colors.accent} />
        </Pressable>
        <View style={styles.pagerText} accessible accessibilityLiveRegion="polite">
          <Text style={[Type.subhead, { color: colors.text }]}>
            {doc ? `Page ${page + 1} of ${pageCount}` : ' '}
          </Text>
          <Text style={[Type.caption, { color: colors.muted }]}>
            {doc ? (counts[page] ? `${boxesSummary([counts[page]])} on this page` : 'No boxes on this page') : ' '}
          </Text>
        </View>
        <Pressable
          onPress={() => goTo(page + 1)}
          disabled={!doc || page >= pageCount - 1}
          accessibilityRole="button"
          accessibilityLabel="Next page"
          style={({ pressed }) => [styles.pageBtn, pressed && { opacity: 0.5 }]}
        >
          <Ionicons name="chevron-forward" size={22} color={!doc || page >= pageCount - 1 ? colors.faint : colors.accent} />
        </Pressable>
      </View>

      <BottomSheet visible={styling} onClose={() => setStyling(false)} variant="grouped">
        <SheetHeader title="Box style" subtitle="Boxes are burned in solid, so what’s under them is gone." />
        <View style={styles.sheetBody}>
          <ColorPalette
            options={BOX_COLORS}
            value={look.color}
            onChange={v => setLookPatch({ color: v as InkChoice })}
            custom={look.customColor}
            onCustomChange={customColor => setLookPatch({ customColor })}
            accessibilityLabel="Box color"
          />
          <View style={[styles.switchRow, { backgroundColor: colors.card }]}>
            <Text style={[Type.body, styles.flex, { color: colors.text }]} maxFontSizeMultiplier={1.5}>
              Show “REDACTED” on boxes
            </Text>
            <AppSwitch value={look.label} onValueChange={label => setLookPatch({ label })} accessibilityLabel="Show REDACTED on boxes" />
          </View>
          <PrimaryButton title="Done" onPress={() => setStyling(false)} />
        </View>
      </BottomSheet>
    </ToolScreen>
  );
}

/** The chips are 34 pt tall: the slop makes their touch area 44 pt. */
const CHIP_SLOP = { top: 5, bottom: 5 };

const styles = StyleSheet.create({
  top: { flexGrow: 0 },
  topBody: { paddingHorizontal: Spacing.gutter },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderRadius: Radius.md,
    paddingLeft: Spacing.md,
    paddingRight: Spacing.xs + 2,
    minHeight: HIT,
    marginTop: Spacing.md,
  },
  searchInput: { flex: 1, paddingVertical: Spacing.sm + 2 },
  findBtn: { borderRadius: Radius.sm, paddingHorizontal: Spacing.md, paddingVertical: 6 },
  dim: { opacity: 0.5 },
  chips: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    minHeight: 34,
  },
  chipText: { fontWeight: '600' },
  // A setting, not a search: card-coloured, outlined so it still reads as a pill.
  styleChip: { marginLeft: 'auto', borderWidth: StyleSheet.hairlineWidth },
  styleDot: { width: 14, height: 14, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth },
  flex: { flex: 1 },
  sheetBody: { gap: Spacing.md, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.lg,
    minHeight: HIT + 8,
  },
  hint: { marginTop: Spacing.sm, marginHorizontal: Spacing.xs, lineHeight: 18, minHeight: 18 },
  pageArea: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.gutter, paddingTop: Spacing.sm },
  placeholder: {
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pager: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs },
  pageBtn: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  pagerText: { flex: 1, alignItems: 'center' },
});

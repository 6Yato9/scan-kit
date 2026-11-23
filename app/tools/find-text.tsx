// app/tools/find-text.tsx
// Find text: search a document for a word or phrase and see every match
// highlighted in yellow, page by page — like a highlighter, without changing
// anything (nothing is saved). Works on scans and on imported PDFs, whose
// pages are rendered to be read (lib/doc-read.ts). The pages are read with
// the same on-device OCR and matching as Redact (lib/redact-run.ts
// findInDocument), with boxes that hug the words (MATCH_PAD_TIGHT) instead of
// Redact's wide margin.
//
// Opened from the viewer's Tools sheet it starts on that document and page.
//
// Once a document is chosen the page gets the room (the document row goes;
// the header's documents button changes it). The page can be pinched and
// double-tapped to zoom (components/zoom-frame.tsx), highlights included. The
// arrows by the search field step through the matches one by one — the
// current one in orange, zoomed to — and the pager below turns pages.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/contexts/theme-context';
import { NoDocumentsScreen, ToolScreen, useImageAspect, useToolDocuments } from '@/components/tool-ui';
import { DocChooserSheet, ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import { HeaderIconButton } from '@/components/screen-header';
import { ZoomFrame, type ZoomFocus } from '@/components/zoom-frame';
import { notifySuccess, selection } from '@/lib/haptics';
import { OcrAbortedError } from '@/lib/ocr';
import { findInDocument, ocrAvailable } from '@/lib/redact-run';
import { MATCH_PAD_TIGHT, MIN_TERM_LENGTH, normalizeTerm, type RedactRect } from '@/lib/redact';
import { documentReadPages, docReadErrorText } from '@/lib/doc-read';
import { Highlight, HIT, Radius, Spacing, Type } from '@/lib/theme';
import { foundSummary } from '@/lib/find-text';
import type { Document } from '@/types/document';

type Found = { docId: string; term: string; pages: RedactRect[][] };

/** The match being looked at: a stronger highlighter colour than the rest. */
const CURRENT_MARK = '#ffb02e';
const NOTE = 'Scanned documents and imported PDFs.';

const anyDoc = (d: Document) => d.pages.length > 0 || !!d.pdfUri;

export default function FindTextScreen() {
  const { colors, isDark } = useTheme();
  const { docs, loaded } = useToolDocuments(anyDoc);
  const { doc, docId, setDocId, fixed, fromViewer, routePage } = useToolDoc(docs);
  const canFind = ocrAvailable();

  const [term, setTerm] = useState('');
  const [pages, setPages] = useState<{ docId: string; uris: string[] } | null>(null);
  const [pagesError, setPagesError] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [finding, setFinding] = useState<{ done: number; total: number } | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [area, setArea] = useState<{ width: number; height: number } | null>(null);
  /** Index into `matches` of the match being looked at. */
  const [current, setCurrent] = useState(0);
  /** Where the page should zoom to (a match); null shows the whole page. */
  const [focus, setFocus] = useState<ZoomFocus | null>(null);
  const [choosing, setChoosing] = useState(false);
  const findAbort = useRef<AbortController | null>(null);
  useEffect(() => () => findAbort.current?.abort(), []);

  // From the Tools tab with a single document: there is nothing to choose.
  useEffect(() => {
    if (loaded && !fixed && !docId && docs.length === 1) setDocId(docs[0].id);
  }, [loaded, fixed, docId, docs, setDocId]);

  // A different document starts clean, on its first page (or the viewer's
  // page), with its pages ready to read: a PDF's are rendered first.
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (!doc || shownFor.current === doc.id) return;
    shownFor.current = doc.id;
    findAbort.current?.abort();
    setFound(null);
    setStatus(null);
    setFocus(null);
    setCurrent(0);
    setPagesError(null);
    setPageIndex(routePage ?? 0);
    setPages(doc.pdfUri ? null : { docId: doc.id, uris: doc.pages.map(p => `${p.split('?')[0]}?v=${doc.updatedAt}`) });
    if (!doc.pdfUri) return;
    let live = true;
    documentReadPages(doc)
      .then(uris => { if (live) setPages({ docId: doc.id, uris }); })
      .catch(err => { if (live) setPagesError(docReadErrorText(err)[1]); });
    return () => { live = false; };
  }, [doc, routePage]);

  const ready = !!doc && pages?.docId === doc.id;
  const pageUris = ready ? pages.uris : [];
  const pageCount = pageUris.length;
  const page = Math.min(pageIndex, Math.max(0, pageCount - 1));
  const pageUri = pageUris[page] ?? null;
  const aspect = useImageAspect(pageUri);
  const results = found && doc && found.docId === doc.id ? found : null;
  const boxes = results?.pages[page] ?? [];
  /** Every match in the document, in page order. */
  const matches = useMemo(
    () => (results ? results.pages.flatMap((p, pi) => p.map((box, i) => ({ page: pi, i, box }))) : []),
    [results],
  );
  const currentMatch = matches[current] ?? null;
  const onCurrentPage = currentMatch && currentMatch.page === page ? currentMatch.i : -1;

  /** `typed`: the field's text as submitted (the state can lag a keystroke behind). */
  const runFind = async (typed?: string) => {
    if (!doc || !ready || finding) return;
    const t = typed ?? term;
    if (normalizeTerm(t).length < MIN_TERM_LENGTH) {
      setStatus(`Type at least ${MIN_TERM_LENGTH} characters to search.`);
      return;
    }
    Keyboard.dismiss();
    findAbort.current?.abort();
    const controller = new AbortController();
    findAbort.current = controller;
    setFinding({ done: 0, total: pageUris.length });
    try {
      const hits = await findInDocument(pageUris, { kind: 'term', term: t }, {
        signal: controller.signal,
        onPage: (done, n) => setFinding({ done, total: n }),
        pad: MATCH_PAD_TIGHT,
      });
      if (controller.signal.aborted) return;
      setFound({ docId: doc.id, term: t, pages: hits });
      const counts = hits.map(h => h.length);
      setStatus(foundSummary(t, counts));
      setFocus(null);
      const first = counts.findIndex(c => c > 0);
      if (first >= 0) {
        notifySuccess();
        // Start on this page's first match, or show where the matches are
        // when this page has none of them.
        const startPage = counts[page] ? page : first;
        setPageIndex(startPage);
        setCurrent(counts.slice(0, startPage).reduce((a, b) => a + b, 0));
      } else {
        setCurrent(0);
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

  /** Turns to page `i`, showing the whole page; its first match becomes the current one. */
  const goTo = (i: number) => {
    const next = Math.min(Math.max(0, i), pageCount - 1);
    if (next === page) return;
    setPageIndex(next);
    setFocus(null);
    const first = matches.findIndex(m => m.page === next);
    if (first >= 0) setCurrent(first);
    selection();
  };
  /** The next (dir 1) or previous (-1) match, wrapping round, zoomed to. */
  const stepMatch = (dir: 1 | -1) => {
    if (!matches.length) return;
    // Away from the current match's page, start from this page instead.
    let next: number;
    if (currentMatch && currentMatch.page === page) {
      next = (current + dir + matches.length) % matches.length;
    } else {
      const ahead = matches.findIndex(m => m.page >= page);
      next = dir === 1
        ? (ahead >= 0 ? ahead : 0)
        : ((ahead >= 0 ? ahead : matches.length) - 1 + matches.length) % matches.length;
    }
    const m = matches[next];
    setCurrent(next);
    setPageIndex(m.page);
    setFocus(f => ({ key: (f?.key ?? 0) + 1, ...m.box }));
    selection();
  };
  const showingResults = !!results && normalizeTerm(term) === normalizeTerm(results.term) && !finding;

  if (loaded && docs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Find text"
        icon="search-outline"
        subtitle="Find text highlights a word wherever it appears in a document. Scan or import a document first."
      />
    );
  }

  // The page as large as the space left allows (the frame adds Spacing.sm a side).
  const pad = Spacing.sm * 2;
  const pageW = area
    ? Math.floor(Math.max(0, Math.min(area.width - Spacing.gutter * 2 - pad, (area.height - Spacing.sm - pad) / aspect)))
    : 0;
  const pageH = Math.floor(pageW * aspect);
  const hint = !doc
    ? 'Choose a document, then type what to look for.'
    : !canFind
      ? 'Text search isn’t available on this device.'
      : pagesError
        ? pagesError
        : !ready
          ? 'Getting the pages ready…'
          : finding
            ? `Reading page ${Math.min(finding.done + 1, finding.total)} of ${finding.total}…`
            : status ?? 'Every match is highlighted in yellow. Pinch or double-tap the page to zoom.';

  return (
    <ToolScreen
      title="Find text"
      scroll={false}
      right={
        doc && !fixed && docs.length > 1 ? (
          <HeaderIconButton icon="documents-outline" label="Choose another document" disabled={!!finding} onPress={() => setChoosing(true)} />
        ) : undefined
      }
    >
      <View style={styles.top}>
        {/* Once chosen, the page gets this room: the header button changes it. */}
        {!doc ? (
          <ToolDocPicker
            docs={docs}
            doc={doc}
            fixed={fixed}
            disabled={!!finding}
            onPick={d => setDocId(d.id)}
            autoOpen={loaded && !fromViewer}
            note={NOTE}
          />
        ) : null}

        <View style={[styles.search, !doc && styles.searchBelowPicker, { backgroundColor: colors.card }, (!ready || !canFind) && styles.dim]}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            style={[Type.body, styles.searchInput, { color: colors.text }]}
            value={term}
            onChangeText={setTerm}
            placeholder={canFind ? 'Word or phrase' : 'Text search isn’t available'}
            placeholderTextColor={colors.muted}
            editable={ready && canFind && !finding}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            keyboardAppearance={isDark ? 'dark' : 'light'}
            onSubmitEditing={e => { void runFind(e.nativeEvent.text); }}
            accessibilityLabel="Text to find"
          />
          {finding ? (
            <ActivityIndicator color={colors.muted} />
          ) : showingResults && matches.length > 0 ? (
            <View style={styles.stepper}>
              <Text style={[Type.footnote, styles.count, { color: colors.muted }]} maxFontSizeMultiplier={1.4} accessibilityLabel={`Match ${current + 1} of ${matches.length}`}>
                {`${current + 1}/${matches.length}`}
              </Text>
              <Pressable
                onPress={() => stepMatch(-1)}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel="Previous match"
                style={({ pressed }) => [styles.stepBtn, pressed && { opacity: 0.5 }]}
              >
                <Ionicons name="chevron-up" size={22} color={colors.accent} />
              </Pressable>
              <Pressable
                onPress={() => stepMatch(1)}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel="Next match"
                style={({ pressed }) => [styles.stepBtn, pressed && { opacity: 0.5 }]}
              >
                <Ionicons name="chevron-down" size={22} color={colors.accent} />
              </Pressable>
            </View>
          ) : term.trim() && !showingResults ? (
            <Pressable
              onPress={() => { void runFind(); }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Find"
              style={({ pressed }) => [styles.findBtn, { backgroundColor: colors.accentFill }, pressed && { opacity: 0.7 }]}
            >
              <Text style={[Type.subhead, { color: colors.onAccent, fontWeight: '600' }]}>Find</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={[Type.footnote, styles.hint, { color: colors.muted }]} numberOfLines={2} accessibilityLiveRegion="polite">
          {hint}
        </Text>
      </View>

      {/* The page, as large as the space left allows, with its matches highlighted. */}
      <View
        style={styles.pageArea}
        onLayout={e => {
          const { width, height } = e.nativeEvent.layout;
          if (!area || Math.abs(area.width - width) > 1 || Math.abs(area.height - height) > 1) setArea({ width, height });
        }}
      >
        {pageUri && pageW > 0 ? (
          <View style={[styles.frame, { backgroundColor: colors.input }]}>
            <ZoomFrame width={pageW} height={pageH} focus={focus} resetKey={`${doc?.id}:${page}`}>
              <Image
                source={{ uri: pageUri }}
                style={StyleSheet.absoluteFill}
                contentFit="fill"
                transition={0}
                // Zoomed in, the page is drawn from the full picture, not a screen-sized copy.
                allowDownscaling={false}
                accessibilityLabel={`Page ${page + 1} of ${pageCount}${boxes.length ? `, ${boxes.length} ${boxes.length === 1 ? 'match' : 'matches'}` : ''}`}
              />
              <View style={[StyleSheet.absoluteFill, styles.edge, { borderColor: colors.thumbBorder }]} pointerEvents="none" />
              {boxes.map((b, i) => (
                <View
                  key={i}
                  pointerEvents="none"
                  style={[
                    styles.mark,
                    {
                      left: b.x * pageW,
                      top: b.y * pageH,
                      width: Math.max(4, b.w * pageW),
                      height: Math.max(4, b.h * pageH),
                      backgroundColor: i === onCurrentPage && boxes.length > 0 && matches.length > 1 ? CURRENT_MARK : Highlight.yellow,
                    },
                  ]}
                />
              ))}
            </ZoomFrame>
          </View>
        ) : (
          <View style={[styles.placeholder, { borderColor: colors.border, width: pageW + pad, height: pageH + pad }]}>
            {doc && !ready && !pagesError ? (
              <ActivityIndicator color={colors.muted} />
            ) : (
              <Ionicons name="search-outline" size={28} color={colors.faint} />
            )}
          </View>
        )}
      </View>

      {/* Pages: back / forward, and how many matches this page has. */}
      <View style={styles.pager}>
        <Pressable
          onPress={() => goTo(page - 1)}
          disabled={!ready || page === 0}
          accessibilityRole="button"
          accessibilityLabel="Previous page"
          style={({ pressed }) => [styles.pageBtn, pressed && { opacity: 0.5 }]}
        >
          <Ionicons name="chevron-back" size={22} color={!ready || page === 0 ? colors.faint : colors.accent} />
        </Pressable>
        <View style={styles.pagerText} accessible accessibilityLiveRegion="polite">
          <Text style={[Type.subhead, { color: colors.text }]} maxFontSizeMultiplier={1.4}>
            {ready ? `Page ${page + 1} of ${pageCount}` : ' '}
          </Text>
          <Text style={[Type.caption, { color: colors.muted }]} maxFontSizeMultiplier={1.4}>
            {ready && results ? (boxes.length ? `${boxes.length} ${boxes.length === 1 ? 'match' : 'matches'} on this page` : 'No matches on this page') : ' '}
          </Text>
        </View>
        <Pressable
          onPress={() => goTo(page + 1)}
          disabled={!ready || page >= pageCount - 1}
          accessibilityRole="button"
          accessibilityLabel="Next page"
          style={({ pressed }) => [styles.pageBtn, pressed && { opacity: 0.5 }]}
        >
          <Ionicons name="chevron-forward" size={22} color={!ready || page >= pageCount - 1 ? colors.faint : colors.accent} />
        </Pressable>
      </View>
      <DocChooserSheet
        visible={choosing}
        docs={docs}
        note={NOTE}
        selectedId={doc?.id}
        onPick={d => setDocId(d.id)}
        onClose={() => setChoosing(false)}
      />
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  top: { paddingHorizontal: Spacing.gutter },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderRadius: Radius.md,
    paddingLeft: Spacing.md,
    paddingRight: Spacing.xs + 2,
    minHeight: HIT,
  },
  searchBelowPicker: { marginTop: Spacing.md },
  stepper: { flexDirection: 'row', alignItems: 'center' },
  count: { marginRight: Spacing.xs, fontVariant: ['tabular-nums'] },
  stepBtn: { width: 36, height: HIT, alignItems: 'center', justifyContent: 'center' },
  searchInput: { flex: 1, paddingVertical: Spacing.sm + 2 },
  findBtn: { borderRadius: Radius.sm, paddingHorizontal: Spacing.md, paddingVertical: 6 },
  dim: { opacity: 0.5 },
  hint: { marginTop: Spacing.sm, marginHorizontal: Spacing.xs, lineHeight: 18 },
  pageArea: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.gutter, paddingTop: Spacing.sm },
  frame: { padding: Spacing.sm, borderRadius: Radius.md },
  edge: { borderWidth: StyleSheet.hairlineWidth },
  // A highlighter stroke: multiplied onto the page, so the print shows through
  // dark and crisp instead of washed out under a translucent layer.
  mark: { position: 'absolute', borderRadius: 2, mixBlendMode: 'multiply' },
  placeholder: {
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pager: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.gutter, paddingVertical: Spacing.xs },
  pageBtn: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  pagerText: { flex: 1, alignItems: 'center' },
});

// app/pdf-fill.tsx
// Fill & sign an imported PDF in place — no “Convert to pages”, so its text
// stays text. Tap a form field to fill it in (text, checkboxes, radio buttons,
// lists; Next / Previous walk the text fields); choose a tool and tap the page
// to add text, today’s date, a check mark, a cross, your signature or
// initials; drag to move, drag a corner (or pinch on it) to resize
// (components/fill-page.tsx). Pinch or double-tap the page to zoom.
// A signature or initials drawn once are reused for the rest of the session
// (and remembered after saving, like Sign); initials can be put on every page
// in one go. Done writes everything into the PDF through the same crash-safe
// swap as every PDF edit, and the viewer offers Undo (lib/pdf-fill.ts,
// lib/pdf-edit.ts).
//
// Route params: docId, page (zero-based, to open at), from=viewer when the
// viewer is underneath (Done goes back to it; otherwise it opens it).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Keyboard,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { DarkThemeScope, useTheme } from '@/contexts/theme-context';
import { HeaderTextButton, ScreenHeader } from '@/components/screen-header';
import { EmptyState } from '@/components/empty-state';
import { AppIcon, type AppIconName } from '@/components/app-icon';
import { FillPage, MAX_FONT, MIN_FONT, type FieldView } from '@/components/fill-page';
import { SignatureSheet } from '@/components/signature-pad';
import { getDocument } from '@/lib/storage';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { postViewerNotice } from '@/lib/viewer-notice';
import { notifyError, notifySuccess, selection, tapLight } from '@/lib/haptics';
import { formatStamp, SIGNATURE_INK, type Signature } from '@/lib/stamp';
import { rememberSignature, type SignatureKind } from '@/lib/saved-signatures';
import { discardPdfEditUndo, filePrint, holdPdfEditUndo, PdfEditError, samePrint, type FilePrint } from '@/lib/pdf-edit';
import { noteFilledPdf } from '@/lib/fill-access';
import {
  isSessionPath,
  isSessionUnlocked,
  PdfSessionError,
  PROTECTED_EDIT_REFUSALS,
  protectedEditRefusal,
  readablePdfUri,
  sessionEditBlock,
  subscribePdfSessions,
  unlockForSession,
} from '@/lib/pdf-session';
import { fittedView, revealRect, type PageView } from '@/lib/placement';
import {
  coveredField,
  copyToPages,
  fieldOrder,
  isPlaceholderChoice,
  keyboardForField,
  placeInkMark,
  pushRecent,
} from '@/lib/fill-session';
import {
  DEFAULT_FONT_SIZE,
  canFillPdf,
  clearFillPreviews,
  displaySize,
  fieldLabel,
  fieldValue,
  fillMessage,
  fillNotice,
  fillStoredPdf,
  firstChangedPage,
  isEmptyMark,
  isInkKind,
  isTextKind,
  markText,
  openFillSession,
  pageGeometry,
  pageRectToDisplay,
  planFieldValues,
  renderFillPage,
  setFieldText,
  stepFontSize,
  toggleButton,
  undoPdfFill,
  type FieldEdits,
  type FillInk,
  type FillMark,
  type FillMarkKind,
  type FillSession,
} from '@/lib/pdf-fill';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import { showTextPrompt } from '@/components/text-prompt';
import { ActionSheet } from '@/components/action-sheet';
import type { Document } from '@/types/document';
import type { NativeFillField } from '@/modules/vision-ocr/src';
import { isAndroid } from '@/lib/platform-support';

type Status = 'loading' | 'ready' | 'missing' | 'locked' | 'restricted' | 'xfa' | 'unreadable' | 'unavailable' | 'owner-password';
type Armed = { kind: FillMarkKind; signature?: Signature };
type Editing = { type: 'mark'; id: string } | { type: 'field'; id: string };
type Snapshot = { marks: FillMark[]; edits: FieldEdits };

const TOOLS: { kind: FillMarkKind; icon: AppIconName; label: string; hint: string }[] = [
  { kind: 'text', icon: 'text-outline', label: 'Text', hint: 'Tap where the text goes' },
  { kind: 'date', icon: 'calendar-outline', label: 'Date', hint: 'Tap where the date goes' },
  { kind: 'check', icon: 'checkmark', label: 'Check', hint: 'Tap each place for a check mark' },
  { kind: 'cross', icon: 'close', label: 'Cross', hint: 'Tap each place for a cross' },
  { kind: 'signature', icon: 'signature', label: 'Sign', hint: 'Tap where you sign' },
  // Not create-outline: that is "Edit text" in the selection bar.
  { kind: 'initials', icon: 'initials', label: 'Initials', hint: 'Tap where your initials go' },
];

/** Long edge of a page preview, in pixels: sharp on a 3x screen, bounded for a phone’s memory. */
const MAX_PREVIEW_PX = 2400;
/** Room kept around the page (fitted, and the most a zoomed page pulls in from an edge). */
const PAGE_MARGIN = { w: Spacing.gutter, h: Spacing.lg };
const EDIT_BAR_H = 64;
const NOTICE_MS = 4000;
/**
 * How far the header and the hint pills grow with Dynamic Type: like a UIKit
 * navigation bar, so “Cancel  Fill & sign  Done” always fits (the system's
 * large-content viewer is for anything bigger). The page itself never scales.
 */
const HEADER_TEXT_SCALE = 1.35;
const MAX_HISTORY = 50;

let markSeq = 0;
const newId = () => `mark-${Date.now().toString(36)}-${++markSeq}`;

export default function PdfFillScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowH } = useWindowDimensions();
  const params = useLocalSearchParams<{ docId?: string; page?: string; from?: string }>();
  const docId = typeof params.docId === 'string' ? params.docId : '';
  const fromViewer = params.from === 'viewer';

  const [status, setStatus] = useState<Status>('loading');
  const [doc, setDoc] = useState<Document | null>(null);
  /** The file Fill & sign reads: the stored PDF, or the session copy of a protected one (lib/pdf-session.ts). */
  const [source, setSource] = useState<string | null>(null);
  // The session of a protected PDF ended while filling it in (App Lock, a long
  // absence): the page is covered until its password is entered again; what
  // was filled in and added stays (lib/pdf-session.ts).
  const [relocked, setRelocked] = useState(false);
  const [resuming, setResuming] = useState(false);
  /** The stored PDF's bytes when the screen opened it: resuming refuses if they changed. */
  const storedPrintRef = useRef<FilePrint | null>(null);
  const [session, setSession] = useState<FillSession | null>(null);
  const [pageIndex, setPageIndex] = useState(() => (params.page === 'last' ? Number.MAX_SAFE_INTEGER : Math.max(0, Number(params.page) || 0)));
  const [preview, setPreview] = useState<{ uri: string; page: number } | null>(null);
  const [renderFailed, setRenderFailed] = useState(false);
  const [marks, setMarks] = useState<FillMark[]>([]);
  const [edits, setEdits] = useState<FieldEdits>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [armed, setArmed] = useState<Armed | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [ink, setInk] = useState<FillInk>('black');
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [sheet, setSheet] = useState<SignatureKind | null>(null);
  const [saving, setSaving] = useState(false);
  const [area, setArea] = useState<{ w: number; h: number } | null>(null);
  const [kbHeight, setKbHeight] = useState(0);
  const [placing, setPlacing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [historyLength, setHistoryLength] = useState(0);
  /** Signatures and initials used in this session, newest first: drawn once, placed many times. */
  const [recent, setRecent] = useState<Record<SignatureKind, Signature[]>>({ signature: [], initials: [] });
  const [viewState, setViewState] = useState<{ key: string; v: PageView } | null>(null);
  const areaRef = useRef<View>(null);
  const areaTop = useRef(0);
  const pickedSig = useRef<{ kind: SignatureKind; sig: Signature } | null>(null);
  /** A signature field the sheet was opened from: the signature goes in it. */
  const sigField = useRef<NativeFillField | null>(null);
  const usedSignatures = useRef(new Map<string, { kind: SignatureKind; sig: Signature }>());
  /** Set the moment Done is tapped (state would let a second tap in the same frame through). */
  const savingRef = useRef(false);
  // The user agreed that saving invalidates the PDF's digital signature.
  const signatureOk = useRef(false);
  const history = useRef<Snapshot[]>([]);
  const current = useRef<Snapshot>({ marks, edits });
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      clearFillPreviews();
    };
  }, []);
  useEffect(() => {
    current.current = { marks, edits };
  }, [marks, edits]);

  const say = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  /** Keeps what is there now, for the Undo button. */
  const remember = useCallback(() => {
    history.current = [...history.current, current.current].slice(-MAX_HISTORY);
    setHistoryLength(history.current.length);
  }, []);

  // ── Loading ────────────────────────────────────────────────────────────────

  useEffect(() => {
    let live = true;
    (async () => {
      if (!canFillPdf()) {
        setStatus('unavailable');
        return;
      }
      const d = await getDocument(docId).catch(() => null);
      if (!live) return;
      if (!d || !d.pdfUri || d.trashedAt) {
        setStatus('missing');
        return;
      }
      setDoc(d);
      try {
        // A protected PDF unlocked this session is read (and saved, still
        // protected) through its decrypted copy (lib/pdf-session.ts).
        const src = await readablePdfUri(d).catch(() => d.pdfUri as string);
        if (!live) return;
        // Opened with its owner password: it can't be saved back protected.
        if (isSessionPath(src) && sessionEditBlock(d.id)) {
          setStatus('owner-password');
          return;
        }
        storedPrintRef.current = filePrint(d.pdfUri);
        setSource(src);
        const s = await openFillSession(src);
        if (!live) return;
        if (!s.info.canAnnotate && !s.info.canFillForms) {
          setStatus('restricted');
          return;
        }
        // An XFA form with no AcroForm fields: nothing here can fill it (F1, round 13b).
        const notice = fillNotice(s.info);
        if (notice?.level === 'blocked') {
          setStatus('xfa');
          return;
        }
        setSession(s);
        setPageIndex(p => Math.min(p, s.info.pageCount - 1));
        setStatus('ready');
        if (notice?.level === 'note') Alert.alert(notice.title, notice.body);
      } catch (err) {
        if (!live) return;
        const kind = err instanceof PdfEditError ? err.kind : 'failed';
        setStatus(kind === 'locked' ? 'locked' : kind === 'unavailable' ? 'unavailable' : 'unreadable');
      }
    })();
    return () => { live = false; };
  }, [docId]);

  // The session ended (App Lock, a long absence) while filling in a protected
  // PDF: its copy is going away, so the page is covered and the password asked
  // for again. Fields and marks stay in memory.
  useEffect(() => {
    if (!source || !isSessionPath(source)) return;
    return subscribePdfSessions(id => {
      if (id !== docId || isSessionUnlocked(docId)) return;
      setPreview(null);
      setRelocked(true);
    });
  }, [source, docId]);

  /** Enter the password again: the same work continues on a new session copy. */
  const resume = (again = false) => {
    const d = doc;
    if (!d?.pdfUri || resumingRef.current) return;
    // Alert.prompt on iOS; Scan Kit's own prompt on Android (Alert.prompt is iOS-only).
    showTextPrompt(
      {
        title: again ? 'Enter the password again' : 'Enter the PDF’s password',
        message: `“${d.name}” is protected. What you filled in is kept.`,
        secure: true,
        confirmLabel: 'Unlock',
      },
      value => {
        resumingRef.current = true;
        setResuming(true);
        (async () => {
          try {
            await unlockForSession(d, value);
            const fresh = await getDocument(d.id);
            if (!fresh?.pdfUri || !storedPrintRef.current || !samePrint(filePrint(fresh.pdfUri), storedPrintRef.current)) {
              Alert.alert('The PDF changed', 'It was changed while you were away. Close Fill & sign and open it again.');
              return;
            }
            const src = await readablePdfUri(fresh);
            const s2 = await openFillSession(src);
            const before = session?.info;
            const same = !!before && s2.info.pageCount === before.pageCount
              && s2.info.fields.map(f => f.id).join() === before.fields.map(f => f.id).join();
            if (!same) {
              Alert.alert('The PDF changed', 'It was changed while you were away. Close Fill & sign and open it again.');
              return;
            }
            setSource(src);
            setSession(s2);
            setRelocked(false);
          } catch (err) {
            if (err instanceof PdfSessionError && err.kind === 'wrong-password') {
              Alert.alert('That password isn’t right', 'Check it and try again. Passwords are case-sensitive.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Try again', onPress: () => resume(true) },
              ]);
            } else {
              Alert.alert('Couldn’t open the PDF', 'Try again.');
            }
          } finally {
            resumingRef.current = false;
            setResuming(false);
          }
        })();
      },
    );
  };
  const resumingRef = useRef(false);

  const info = session?.info ?? null;
  const pageCount = info?.pageCount ?? 0;
  const geometry = useMemo(() => (info ? pageGeometry(info.pages[pageIndex]) : null), [info, pageIndex]);
  const shown = geometry ? displaySize(geometry) : { width: 1, height: 1 };
  const pageFields: FieldView[] = useMemo(() => {
    if (!info || !geometry) return [];
    return info.fields.filter(f => f.page === pageIndex).map(field => ({ field, rect: pageRectToDisplay(field.rect, geometry) }));
  }, [info, geometry, pageIndex]);
  const fieldsEnabled = !!info?.canFillForms;
  const canAnnotate = !!info?.canAnnotate;
  /** Every page’s fields as shown, for Next / Previous and for marks dropped on a field. */
  const allFieldViews: FieldView[] = useMemo(() => {
    if (!info) return [];
    return info.fields.map(field => ({ field, rect: pageRectToDisplay(field.rect, pageGeometry(info.pages[field.page])) }));
  }, [info]);
  const textFields = useMemo(() => (fieldsEnabled ? fieldOrder(allFieldViews) : []), [allFieldViews, fieldsEnabled]);

  // The page fitted into the space between the header and the bars.
  const fit = useMemo(() => {
    if (!area) return null;
    const aspect = shown.width > 0 ? shown.height / shown.width : 1.3;
    const maxW = Math.max(100, area.w - PAGE_MARGIN.w * 2);
    const maxH = Math.max(100, area.h - PAGE_MARGIN.h * 2);
    const w = Math.floor(Math.min(maxW, maxH / aspect));
    return { w, h: Math.floor(w * aspect) };
  }, [area, shown.width, shown.height]);

  // Zoom and position: fitted for each new page (and whenever the space changes).
  const viewKey = fit && area ? `${pageIndex}:${fit.w}x${fit.h}:${area.w}x${area.h}` : '';
  const view: PageView | null = fit && area ? (viewState?.key === viewKey ? viewState.v : fittedView(fit, area)) : null;
  const setView = useCallback((v: PageView) => setViewState({ key: viewKey, v }), [viewKey]);
  const zoom = view?.z ?? 1;

  // Render the page on screen (and only it: a phone has little memory to spare),
  // sharper as it is zoomed in.
  const previewPx = fit ? Math.min(MAX_PREVIEW_PX, Math.round(Math.max(fit.w, fit.h) * zoom * PixelRatio.get())) : 0;
  const renderKey = fit ? `${pageIndex}-${Math.round(previewPx / 300)}` : null;
  useEffect(() => {
    if (status !== 'ready' || !source || !fit || !info) return;
    let live = true;
    setRenderFailed(false);
    const hideFields = info.canFillForms && info.fields.some(f => f.page === pageIndex);
    renderFillPage(source, pageIndex, previewPx, hideFields)
      .then(r => { if (live) setPreview({ uri: r.uri, page: pageIndex }); })
      .catch(() => { if (live) setRenderFailed(true); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, source, renderKey]);

  // ── Keyboard: the edit bar sits on it, the page lifts so the edited box shows ─

  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', e => setKbHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKbHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  const lift = useRef(new Animated.Value(0)).current;
  const editRect = useMemo(() => {
    if (!editing) return null;
    if (editing.type === 'mark') {
      const m = marks.find(x => x.id === editing.id);
      return m ? { x: m.x, y: m.y, w: m.w, h: m.h } : null;
    }
    const f = pageFields.find(v => v.field.id === editing.id);
    return f ? f.rect : null;
  }, [editing, marks, pageFields]);
  useEffect(() => {
    let to = 0;
    if (editRect && kbHeight > 0 && fit && view) {
      const H = fit.h * view.z;
      const pageTop = areaTop.current + view.y;
      const visibleBottom = windowH - kbHeight - EDIT_BAR_H - Spacing.md;
      const top = pageTop + editRect.y * H;
      const bottom = top + editRect.h * H;
      // Up just enough, never so far that the box’s top leaves the screen.
      to = Math.min(Math.max(0, bottom - visibleBottom), Math.max(0, top - insets.top - Spacing.xl));
    }
    Animated.timing(lift, { toValue: -to, duration: 220, useNativeDriver: true }).start();
  }, [editRect, kbHeight, fit, view, windowH, insets.top, lift]);

  /** A zoomed page moves (not zooms) so `rect` on it shows. */
  const reveal = useCallback((rect: { x: number; y: number; w: number; h: number }) => {
    if (!view || !fit || !area || view.z <= 1.01) return;
    const next = revealRect(view, fit, area, rect, { top: 0, bottom: area.h }, 24, PAGE_MARGIN);
    if (Math.abs(next.x - view.x) > 0.5 || Math.abs(next.y - view.y) > 0.5) setView(next);
  }, [view, fit, area, setView]);

  // ── Changes ────────────────────────────────────────────────────────────────

  const fieldChanges = useMemo(() => (info ? planFieldValues(info.fields, edits) : []), [info, edits]);
  const liveMarks = marks.filter(m => !isEmptyMark(m) || (editing?.type === 'mark' && editing.id === m.id));
  const dirty = fieldChanges.length > 0 || marks.some(m => !isEmptyMark(m));

  const updateMark = useCallback((next: FillMark) => {
    setMarks(list => list.map(m => (m.id === next.id ? clampMark(next) : m)));
    if (isTextKind(next.kind) && next.fontSize) setFontSize(next.fontSize);
  }, []);

  /**
   * Text dropped mostly on an empty text field goes INTO the field: a PDF
   * draws its form above anything added, so on top it would be hidden in the
   * saved file. On a field that already has a value it can’t stay.
   * Returns true when the mark was dealt with (moved in or refused).
   */
  const settleOverField = useCallback((m: FillMark, before: FillMark | null): boolean => {
    const covered = coveredField(m, allFieldViews.filter(v => v.field.page === m.page));
    if (!covered) return false;
    const f = covered.field;
    const value = fieldValue(f, current.current.edits).value ?? '';
    if (isTextKind(m.kind) && fieldsEnabled && f.kind === 'text' && !f.readOnly && value.trim() === '' && markText(m)) {
      const text = f.maxLength && f.maxLength > 0 ? markText(m).slice(0, f.maxLength) : markText(m);
      setMarks(list => list.filter(x => x.id !== m.id));
      setEdits(e => setFieldText(e, f, f.multiline ? text : text.replace(/\s*\n\s*/g, ' ')));
      setSelectedId(null);
      selection();
      say(`Put in the “${fieldLabel(f)}” field`);
      return true;
    }
    if (before) {
      // Back where it was.
      setMarks(list => list.map(x => (x.id === m.id ? before : x)));
    }
    notifyError();
    say('A form field would hide it in the saved PDF. Place it beside the field.');
    return !!before;
  }, [allFieldViews, fieldsEnabled, say]);

  /** A mark moved or resized by hand. */
  const onMarkMoved = useCallback((next: FillMark) => {
    const before = current.current.marks.find(m => m.id === next.id) ?? null;
    remember();
    if (settleOverField(clampMark(next), before)) return;
    updateMark(next);
  }, [remember, settleOverField, updateMark]);

  const measureMark = useCallback((id: string, w: number, h: number) => {
    setMarks(list => list.map(m => {
      if (m.id !== id) return m;
      // Too wide for the page: smaller text (native never wraps a line).
      if (w > 1 && (m.fontSize ?? DEFAULT_FONT_SIZE) > MIN_FONT) {
        return { ...m, fontSize: Math.max(MIN_FONT, (m.fontSize ?? DEFAULT_FONT_SIZE) / w * 0.98) };
      }
      return clampMark({ ...m, w, h });
    }));
  }, []);

  const finishEditing = useCallback((dismiss = true) => {
    const cur = editing;
    setEditing(null);
    if (cur?.type === 'mark') {
      const m = current.current.marks.find(x => x.id === cur.id);
      if (!m || isEmptyMark(m)) {
        // Text left empty goes.
        setMarks(list => list.filter(x => x.id !== cur.id));
        setSelectedId(sel => (sel === cur.id ? null : sel));
      } else {
        settleOverField(m, null);
      }
    }
    if (dismiss) Keyboard.dismiss();
  }, [editing, settleOverField]);

  const startEditing = useCallback((next: Editing) => {
    remember();
    setEditing(next);
  }, [remember]);

  const select = useCallback((id: string | null) => {
    if (editing) finishEditing();
    setSelectedId(id);
    if (id) {
      setArmed(null);
      const m = marks.find(x => x.id === id);
      if (m) setInk(m.ink);
    }
  }, [editing, finishEditing, marks]);

  /** Places the armed tool at the tapped point: text from there, marks centred, ink sitting on it. */
  const place = useCallback((fx: number, fy: number, into?: NativeFillField) => {
    const tool = armed;
    if (!tool || !geometry || !info) return;
    const W = shown.width;
    const H = shown.height;
    const id = newId();
    let m: FillMark;
    if (isTextKind(tool.kind)) {
      const size = fontSize;
      const lineH = (size * 1.15) / H;
      const text = tool.kind === 'date' ? formatStamp(Date.now(), 'date') : '';
      m = { id, page: pageIndex, kind: tool.kind, x: fx, y: fy - lineH / 2, w: (size * 4) / W, h: lineH, ink, text, fontSize: size };
    } else if (tool.kind === 'check' || tool.kind === 'cross') {
      // About 6 mm on paper: big enough to read and to grab.
      const s = Math.max(18, fontSize * 1.5);
      m = { id, page: pageIndex, kind: tool.kind, x: fx - s / W / 2, y: fy - s / H / 2, w: s / W, h: s / H, ink };
    } else {
      const sig = tool.signature;
      if (!sig) return;
      const r = into ? pageRectToDisplay(into.rect, geometry) : null;
      m = { id, page: pageIndex, kind: tool.kind, ink, signature: sig, ...placeInkMark(tool.kind, sig, { width: W, height: H }, { x: fx, y: fy }, r) };
      const kind: SignatureKind = tool.kind === 'initials' ? 'initials' : 'signature';
      usedSignatures.current.set(sig.dataUri, { kind, sig });
      setRecent(rc => ({ ...rc, [kind]: pushRecent(rc[kind], sig) }));
    }
    remember();
    const placed = clampMark(m);
    setMarks(list => [...list, placed]);
    selection();
    if (tool.kind === 'check' || tool.kind === 'cross') {
      // Stays armed for the next box: forms have many. Tap a mark (or the tool) to stop.
      return;
    }
    setSelectedId(id);
    setArmed(null);
    if (tool.kind === 'text') setEditing({ type: 'mark', id });
    else if (tool.kind !== 'date') settleOverField(placed, null);
  }, [armed, geometry, info, shown.width, shown.height, fontSize, pageIndex, ink, remember, settleOverField]);

  const onTapPage = useCallback((fx: number, fy: number) => {
    if (editing) {
      finishEditing();
      return;
    }
    if (armed) place(fx, fy);
    else setSelectedId(null);
  }, [editing, armed, place, finishEditing]);

  const onTapOutside = useCallback(() => {
    if (editing) finishEditing();
    else setSelectedId(null);
  }, [editing, finishEditing]);

  const openSignatureSheet = useCallback((kind: SignatureKind, field: NativeFillField | null) => {
    if (editing) finishEditing();
    setSelectedId(null);
    setArmed(null);
    sigField.current = field;
    setSheet(kind);
  }, [editing, finishEditing]);

  const editField = useCallback((f: NativeFillField) => {
    setSelectedId(null);
    setArmed(null);
    if (f.page !== pageIndex) setPageIndex(f.page);
    startEditing({ type: 'field', id: f.id });
  }, [pageIndex, startEditing]);

  const onFieldPress = useCallback((f: NativeFillField, at?: { x: number; y: number }) => {
    if (!info) return;
    const tool = armed;
    // A signature (or initials) armed and a signature field: it goes in the field.
    if (f.kind === 'signature') {
      if (!canAnnotate) return;
      if (editing) finishEditing();
      setSelectedId(null);
      if (tool?.signature) {
        place(0, 0, f);
        return;
      }
      if (tool && at) {
        place(at.x, at.y);
        return;
      }
      const last = recent.signature[0];
      if (last) {
        // Already drawn this session: straight in (the tool’s Change picks another).
        setArmed({ kind: 'signature', signature: last });
        sigField.current = f;
        return;
      }
      openSignatureSheet('signature', f);
      return;
    }
    if (f.readOnly) return;
    // Straight from one text field to the next: the keyboard stays up.
    const typing = f.kind === 'text';
    if (editing) finishEditing(!typing);
    setSelectedId(null);
    if (f.kind === 'checkbox' || f.kind === 'radio') {
      // A check or cross armed checks the box itself (stays armed for the next one).
      remember();
      if (tool && (tool.kind === 'check' || tool.kind === 'cross')) {
        if (!fieldValue(f, edits).on) setEdits(e => toggleButton(f, info.fields, e));
      } else {
        setArmed(null);
        setEdits(e => toggleButton(f, info.fields, e));
      }
      selection();
      return;
    }
    if (tool && (isInkKind(tool.kind) || tool.kind === 'check' || tool.kind === 'cross') && at) {
      // Over a text field these would be hidden in the saved PDF: place() warns.
      place(at.x, at.y);
      return;
    }
    setArmed(null);
    if (f.kind === 'choice') {
      const options = f.options ?? [];
      if (!options.length) return;
      const now = fieldValue(f, edits).value ?? '';
      const show = (i: number) => {
        if (i < 0 || i >= options.length) return;
        remember();
        setEdits(e => setFieldText(e, f, options[i]));
      };
      const message = now && options.includes(now) && !isPlaceholderChoice(now) ? `Selected: ${now}` : undefined;
      // ActionSheetIOS on iOS; on Android the app's bottom sheet, which lists
      // every option (Android's dialog kept only three buttons).
      ActionSheet.showActionSheetWithOptions(
        { title: fieldLabel(f), message, options: [...options, 'Cancel'], cancelButtonIndex: options.length, userInterfaceStyle: 'dark' },
        show,
      );
      return;
    }
    // A text field. The Date tool puts today’s date in an empty one.
    if (tool?.kind === 'date' && !(fieldValue(f, edits).value ?? '').trim()) {
      remember();
      setEdits(e => setFieldText(e, f, formatStamp(Date.now(), 'date')));
      selection();
      return;
    }
    editField(f);
  }, [info, armed, canAnnotate, editing, finishEditing, place, recent.signature, openSignatureSheet, remember, edits, editField]);

  const pickTool = useCallback((kind: FillMarkKind, change = false) => {
    if (!canAnnotate) return;
    if (editing) finishEditing();
    setSelectedId(null);
    if (armed?.kind === kind && !change) {
      setArmed(null);
      return;
    }
    tapLight();
    if (isInkKind(kind)) {
      const sk: SignatureKind = kind === 'initials' ? 'initials' : 'signature';
      const last = recent[sk][0];
      if (last && !change) {
        // Drawn once already: ready to place again (Change picks another).
        sigField.current = null;
        setArmed({ kind, signature: last });
        return;
      }
      openSignatureSheet(sk, null);
      return;
    }
    setArmed({ kind });
  }, [canAnnotate, editing, finishEditing, armed, recent, openSignatureSheet]);

  // After the signature sheet has fully closed: arm it, or put it in the field.
  const onSheetDismissed = useCallback(() => {
    const picked = pickedSig.current;
    pickedSig.current = null;
    if (!picked) {
      sigField.current = null;
      return;
    }
    setRecent(rc => ({ ...rc, [picked.kind]: pushRecent(rc[picked.kind], picked.sig) }));
    setArmed({ kind: picked.kind, signature: picked.sig });
  }, []);
  // A signature for a signature field is placed as soon as it is armed.
  useEffect(() => {
    const f = sigField.current;
    if (!armed?.signature || !f) return;
    sigField.current = null;
    place(0, 0, f);
  }, [armed, place]);

  const selected = marks.find(m => m.id === selectedId) ?? null;

  const deleteSelected = () => {
    if (!selected) return;
    remember();
    setMarks(list => list.filter(m => m.id !== selected.id));
    setSelectedId(null);
    if (editing) finishEditing();
    tapLight();
  };
  const setSelectedInk = (next: FillInk) => {
    setInk(next);
    if (selected && selected.ink !== next) {
      remember();
      updateMark({ ...selected, ink: next });
    }
  };
  const resizeText = (dir: 1 | -1) => {
    if (!selected || !isTextKind(selected.kind)) return;
    const size = Math.min(MAX_FONT, Math.max(MIN_FONT, stepFontSize(selected.fontSize ?? DEFAULT_FONT_SIZE, dir)));
    remember();
    updateMark({ ...selected, fontSize: size });
    selection();
  };
  /** The selected initials on every other page, same size and spot (each can be moved after). */
  const initialEveryPage = () => {
    if (!selected || !info || selected.kind !== 'initials') return;
    const sizes = info.pages.map(p => displaySize(pageGeometry(p)));
    const added = copyToPages(selected, marks, sizes, newId);
    if (!added.length) {
      say('Every page already has your initials.');
      return;
    }
    remember();
    setMarks(list => [...list, ...added.map(clampMark)]);
    notifySuccess();
    say(added.length === 1 ? 'Initials added to 1 more page' : `Initials added to ${added.length} more pages`);
  };

  const undo = () => {
    const prev = history.current.pop();
    setHistoryLength(history.current.length);
    if (!prev) return;
    if (editing) {
      setEditing(null);
      Keyboard.dismiss();
    }
    setMarks(prev.marks);
    setEdits(prev.edits);
    setSelectedId(null);
    tapLight();
  };

  const goPage = (next: number) => {
    if (next < 0 || next >= pageCount || next === pageIndex) return;
    if (editing) finishEditing();
    setSelectedId(null);
    setPageIndex(next);
  };

  // Next / Previous text field (reading order, across pages).
  const fieldStep = (dir: 1 | -1): NativeFillField | null => {
    if (editing?.type !== 'field' || !textFields.length) return null;
    const i = textFields.findIndex(v => v.field.id === editing.id);
    const j = i + dir;
    return j >= 0 && j < textFields.length ? textFields[j].field : null;
  };
  const goField = (dir: 1 | -1) => {
    const f = fieldStep(dir);
    if (!f) return;
    tapLight();
    editField(f);
  };
  // The field being typed in shows on a zoomed page.
  const editingId = editing?.type === 'field' ? editing.id : null;
  useEffect(() => {
    if (!editingId) return;
    const v = pageFields.find(x => x.field.id === editingId);
    if (v) reveal(v.rect);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, pageFields]);

  // ── Leaving ────────────────────────────────────────────────────────────────

  const close = () => {
    if (savingRef.current) return;
    if (!dirty) {
      router.back();
      return;
    }
    Alert.alert('Discard your changes?', 'What you added and filled in on this PDF won’t be saved.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => router.back() },
    ]);
  };

  const save = async () => {
    if (savingRef.current || relocked || !doc?.pdfUri || !source || !session || !info) return;
    savingRef.current = true;
    if (editing) finishEditing();
    const kept = current.current.marks.filter(m => !isEmptyMark(m));
    const changes = planFieldValues(info.fields, current.current.edits);
    if (kept.length === 0 && changes.length === 0) {
      router.back();
      return;
    }
    // A digitally signed PDF: saving rewrites it, which breaks the signature (F1, round 13b).
    const notice = fillNotice(info);
    if (notice?.level === 'confirm' && !signatureOk.current) {
      savingRef.current = false;
      Alert.alert(notice.title, notice.body, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save anyway', style: 'destructive', onPress: () => { signatureOk.current = true; save(); } },
      ]);
      return;
    }
    setSaving(true);
    const showPage = firstChangedPage(kept, changes, info.fields, pageIndex);
    const message = fillMessage(kept, changes.length);
    try {
      const { undo: undoEdit } = await fillStoredPdf(doc.id, source, session, kept, current.current.edits, showPage);
      // Signatures and initials used are remembered for next time, like Sign.
      for (const m of kept) {
        const used = m.signature ? usedSignatures.current.get(m.signature.dataUri) : null;
        if (used) await rememberSignature(used.sig, Date.now(), used.kind).catch(() => {});
      }
      noteFilledPdf(doc.id);
      notifySuccess();
      // The viewer offers Undo (in its toast and its "…" menu) until it is used
      // or expires; the stash is kept until then.
      const held = undoEdit ? holdPdfEditUndo(doc.id) ?? undoEdit : null;
      const id = doc.id;
      postViewerNotice({
        docId: id,
        message,
        action: held
          ? {
              label: 'Undo',
              onPress: () => {
                undoPdfFill(held, showPage)
                  .then(() => {
                    notifySuccess();
                    postViewerNotice({ docId: id, message: message === 'Signed' ? 'Signature removed' : 'Fill & sign undone' });
                  })
                  .catch(err => {
                    notifyError();
                    const changed = err instanceof PdfEditError && err.kind === 'changed';
                    Alert.alert('Couldn’t undo', changed ? 'The PDF has changed since.' : 'Your PDF is unchanged. Try again.');
                  });
              },
            }
          : undefined,
        onExpire: held ? () => discardPdfEditUndo(held) : undefined,
      });
      if (!mounted.current) return;
      navigateWhenUnlocked(() => {
        if (!mounted.current) return;
        if (fromViewer) router.back();
        else router.replace({ pathname: '/viewer', params: { id } });
      });
    } catch (err) {
      savingRef.current = false;
      setSaving(false);
      notifyError();
      const kind = err instanceof PdfEditError ? err.kind : 'failed';
      if (kind === 'partial') {
        Alert.alert('Your PDF was changed', 'Scan Kit couldn’t finish saving the change, so it can’t be undone. It’s finished the next time Scan Kit opens. Check that there’s free space.');
      } else if (protectedEditRefusal(err)) {
        const r = protectedEditRefusal(err)!;
        Alert.alert(r.title, r.body);
      } else if (kind === 'restricted') {
        Alert.alert('This PDF can’t be changed', 'Its author doesn’t allow filling it in or adding to it. You can still view, share and print it.');
      } else if (kind === 'changed') {
        Alert.alert('The PDF changed', 'It was changed while you were filling it in. Close Fill & sign and open it again.');
      } else if (kind === 'missing') {
        Alert.alert('This document isn’t available', 'It may have been deleted.');
      } else if (kind === 'locked') {
        Alert.alert('This PDF is password protected', 'Open it and enter its password, then fill it in.');
      } else {
        console.error('Fill & sign failed', err);
        Alert.alert('Couldn’t save', 'Your PDF is unchanged. Check that there’s free space, then try again.');
      }
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (status === 'ready' && relocked && doc) {
    // Covered until the password is entered again; the work is kept underneath.
    return (
      <View style={[styles.container, { backgroundColor: colors.chrome }]}>
        <ScreenHeader
          dark
          title="Fill & sign"
          maxTitleScale={HEADER_TEXT_SCALE}
          left={<HeaderTextButton title="Cancel" color={colors.chromeText} onPress={close} maxFontSizeMultiplier={HEADER_TEXT_SCALE} />}
        />
        <View style={styles.centered}>
          <EmptyState
            chrome
            placement="center"
            icon="lock-closed-outline"
            title="Enter the password to continue"
            subtitle="Scan Kit doesn’t save the password, so it’s needed again after you leave Scan Kit. What you filled in is kept."
            actionLabel="Enter password"
            actionIcon="key-outline"
            actionLoading={resuming}
            onAction={() => resume()}
          />
        </View>
      </View>
    );
  }

  if (status !== 'ready' || !info || !doc) {
    const empty: Record<Exclude<Status, 'ready' | 'loading'>, { icon: AppIconName; title: string; subtitle: string }> = {
      missing: { icon: 'document-outline', title: 'This document isn’t available', subtitle: 'It may have been deleted.' },
      locked: {
        icon: 'lock-closed-outline',
        title: 'This PDF is password protected',
        subtitle: 'Open it and enter its password first. Then you can fill it in and sign it.',
      },
      restricted: {
        icon: 'lock-closed-outline',
        title: 'This PDF can’t be changed',
        subtitle: 'Its author doesn’t allow filling it in or signing it. You can still view, share and print it.',
      },
      xfa: {
        icon: 'document-text-outline',
        title: 'This form needs Adobe Acrobat',
        subtitle: 'It’s an XFA form, made for Adobe Acrobat Reader. You can still share and print it.',
      },
      'owner-password': { icon: 'lock-open-outline', title: PROTECTED_EDIT_REFUSALS['owner-password'].title, subtitle: PROTECTED_EDIT_REFUSALS['owner-password'].body },
      unreadable: { icon: 'document-text-outline', title: 'Couldn’t open this PDF', subtitle: 'The file may be damaged. You can still share it, or try importing it again.' },
      unavailable: isAndroid()
        ? { icon: 'document-text-outline', title: 'Fill & sign isn’t available on Android yet', subtitle: 'It’s coming in a later version of Scan Kit for Android. You can still share and print the PDF.' }
        : { icon: 'document-text-outline', title: 'Fill & sign isn’t available', subtitle: 'This version of Scan Kit can’t fill in PDFs. Update Scan Kit, then try again.' },
    };
    const e = status === 'loading' || status === 'ready' ? null : empty[status];
    const openPdf = (status === 'locked' || status === 'restricted' || status === 'xfa' || status === 'unreadable') && doc && !fromViewer;
    return (
      <View style={[styles.container, { backgroundColor: colors.chrome }]}>
        <ScreenHeader
          dark
          title="Fill & sign"
          maxTitleScale={HEADER_TEXT_SCALE}
          // Nothing is in progress here: Close, not Cancel.
          left={<HeaderTextButton title={e ? 'Close' : 'Cancel'} color={colors.chromeText} onPress={() => router.back()} maxFontSizeMultiplier={HEADER_TEXT_SCALE} />}
        />
        {e ? (
          <View style={styles.centered}>
            <EmptyState
              chrome
              placement="center"
              icon={e.icon}
              title={e.title}
              subtitle={e.subtitle}
              {...(status === 'owner-password' && doc
                ? {
                    actionLabel: 'Unlock PDF',
                    actionIcon: 'lock-open-outline' as const,
                    onAction: () => router.replace({ pathname: '/tools/unrestrict', params: { docId: doc.id } } as never),
                  }
                : openPdf
                ? {
                    actionLabel: 'Open PDF',
                    actionIcon: status === 'locked' ? ('key-outline' as const) : ('document-text-outline' as const),
                    onAction: () => router.replace({ pathname: '/viewer', params: { id: doc.id } }),
                  }
                : {})}
            />
          </View>
        ) : (
          <View style={styles.centered}><ActivityIndicator color={colors.chromeText} /></View>
        )}
      </View>
    );
  }

  const armedTool = armed ? TOOLS.find(t => t.kind === armed.kind) : null;
  const pagePreview = preview && preview.page === pageIndex ? preview.uri : null;
  const editingMark = editing?.type === 'mark' ? marks.find(m => m.id === editing.id) ?? null : null;
  const editingField = editing?.type === 'field' ? info.fields.find(f => f.id === editing.id) ?? null : null;
  const hasFields = info.fields.some(f => f.kind !== 'signature');
  const formOnly = !canAnnotate;
  const nextField = fieldStep(1);
  const prevField = fieldStep(-1);
  const note =
    selected
      ? isTextKind(selected.kind)
        ? 'Drag to move. Drag a corner to resize the text.'
        : 'Drag to move. Drag a corner, or pinch on it, to resize.'
      : formOnly
        ? 'Its author allows filling in the form fields only.'
        : hasFields && !fieldsEnabled
          ? 'Its author has locked the form. You can still add text and sign.'
          : marks.length === 0 && fieldChanges.length === 0 && !armed
            ? hasFields && fieldsEnabled
              ? 'Tap a field to fill it in, or choose a tool below.'
              : 'Choose a tool below, then tap the page where it goes.'
            : zoom > 1.01
              ? 'Double-tap the page to zoom out.'
              : null;

  // The selection bar floats over the page, below the selection (or above it near the bottom).
  const selBox = selected && fit && view ? {
    top: view.y + selected.y * fit.h * view.z,
    bottom: view.y + (selected.y + selected.h) * fit.h * view.z,
  } : null;
  const selBarAtTop = !!(selBox && area && selBox.bottom > area.h - (HIT + Spacing.xl + Spacing.md));

  return (
    <View style={[styles.container, { backgroundColor: colors.chrome }]}>
      <ScreenHeader
        dark
        title="Fill & sign"
        maxTitleScale={HEADER_TEXT_SCALE}
        left={<HeaderTextButton title="Cancel" color={colors.chromeText} onPress={close} disabled={saving} maxFontSizeMultiplier={HEADER_TEXT_SCALE} />}
        right={
          saving ? (
            <View style={styles.headerBusy}><ActivityIndicator color={colors.chromeText} /></View>
          ) : (
            <HeaderTextButton title="Done" emphasis color={colors.chromeAccent} onPress={() => { save(); }} maxFontSizeMultiplier={HEADER_TEXT_SCALE} />
          )
        }
      />
      <View
        ref={areaRef}
        style={styles.area}
        onLayout={e => {
          const { width, height } = e.nativeEvent.layout;
          setArea(a => (a && Math.abs(a.w - width) < 1 && Math.abs(a.h - height) < 1 ? a : { w: width, h: height }));
          areaRef.current?.measureInWindow((_x, y) => { if (Number.isFinite(y)) areaTop.current = y; });
        }}
      >
        {fit && area && view ? (
          <Animated.View style={{ transform: [{ translateY: lift }] }}>
            <FillPage
              uri={pagePreview}
              fit={fit}
              viewport={area}
              margin={PAGE_MARGIN}
              view={view}
              onViewChange={setView}
              pageWidth={shown.width}
              fields={pageFields}
              fieldsEnabled={fieldsEnabled}
              edits={edits}
              activeFieldId={editingField?.id ?? null}
              marks={liveMarks.filter(m => m.page === pageIndex)}
              selectedId={selectedId}
              armed={!!armed}
              onTapPage={onTapPage}
              onTapOutside={onTapOutside}
              onFieldPress={onFieldPress}
              onSelect={select}
              onMarkChange={onMarkMoved}
              onMeasure={measureMark}
              onInteracting={setPlacing}
              overlay={
                !pagePreview ? (
                  <View style={[StyleSheet.absoluteFill, styles.centered]} pointerEvents="none">
                    {renderFailed ? (
                      <Text style={[Type.footnote, { color: colors.chromeMuted }]}>Couldn’t show this page.</Text>
                    ) : (
                      <ActivityIndicator color={colors.chromeMuted} />
                    )}
                  </View>
                ) : null
              }
            />
          </Animated.View>
        ) : null}
        {/* What just happened (moved into a field, added to every page…): over the page, so nothing shifts. */}
        {notice ? (
          <View
            style={[styles.hint, styles.notice, { backgroundColor: colors.chromeRaised, borderColor: colors.chromeBorder, shadowColor: colors.shadow }]}
            pointerEvents="none"
          >
            <Text style={[Type.subhead, styles.noticeText, { color: colors.chromeText }]} accessibilityLiveRegion="polite" maxFontSizeMultiplier={HEADER_TEXT_SCALE}>
              {notice}
            </Text>
          </View>
        ) : null}
        {armedTool ? (
          <View style={[styles.hint, notice ? { top: Spacing.sm + 52 } : null, { backgroundColor: colors.chromeRaised, borderColor: colors.chromeBorder }]} pointerEvents="box-none">
            <Text style={[Type.subhead, styles.hintText, { color: colors.chromeText }]} accessibilityLiveRegion="polite" numberOfLines={2} maxFontSizeMultiplier={HEADER_TEXT_SCALE}>
              {armedTool.hint}
            </Text>
            {armed && isInkKind(armed.kind) ? (
              <Pressable
                onPress={() => pickTool(armed.kind, true)}
                hitSlop={{ top: 6, bottom: 6 }}
                accessibilityRole="button"
                accessibilityLabel={armed.kind === 'initials' ? 'Change initials' : 'Change signature'}
                style={({ pressed }) => [styles.hintAction, pressed && { opacity: 0.6 }]}
              >
                <Text style={[Type.subhead, styles.hintText, { color: colors.chromeAccent }]} maxFontSizeMultiplier={HEADER_TEXT_SCALE}>Change</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => setArmed(null)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Stop adding ${armedTool.label.toLowerCase()}`}
              style={({ pressed }) => [styles.hintClose, pressed && { opacity: 0.6 }]}
            >
              <Ionicons name="close" size={18} color={colors.chromeMuted} />
            </Pressable>
          </View>
        ) : null}

        {/* What can be done with the selected addition, floating over the page. */}
        {selected ? (
          <View
            style={[
              styles.selBar,
              selBarAtTop ? { top: Spacing.sm } : { bottom: Spacing.sm },
              { backgroundColor: colors.chromeRaised, borderColor: colors.chromeBorder, shadowColor: colors.shadow },
            ]}
          >
            <View style={styles.inks} accessibilityRole="radiogroup" accessibilityLabel="Ink">
              {(['black', 'blue'] as const).map(k => {
                const on = selected.ink === k;
                return (
                  <Pressable
                    key={k}
                    onPress={() => setSelectedInk(k)}
                    hitSlop={5}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on, checked: on }}
                    accessibilityLabel={k === 'black' ? 'Black ink' : 'Blue ink'}
                    style={[styles.swatchRing, { borderColor: on ? colors.chromeAccent : 'transparent' }]}
                  >
                    <View style={[styles.swatch, { backgroundColor: SIGNATURE_INK[k], borderColor: colors.chromeMuted }]} />
                  </Pressable>
                );
              })}
            </View>
            <View style={[styles.selRule, { backgroundColor: colors.chromeBorder }]} />
            {isTextKind(selected.kind) ? (
              <>
                <SelButton icon="remove" label="Smaller text" onPress={() => resizeText(-1)} disabled={(selected.fontSize ?? DEFAULT_FONT_SIZE) <= MIN_FONT} />
                <SelButton icon="add" label="Larger text" onPress={() => resizeText(1)} disabled={(selected.fontSize ?? DEFAULT_FONT_SIZE) >= MAX_FONT} />
                {selected.kind === 'text' ? (
                  <SelButton icon="create-outline" label="Edit text" onPress={() => startEditing({ type: 'mark', id: selected.id })} />
                ) : null}
              </>
            ) : null}
            {selected.kind === 'initials' && pageCount > 1 ? (
              <SelButton icon="documents-outline" label="Initial every page" onPress={initialEveryPage} />
            ) : null}
            <SelButton icon="trash-outline" label="Delete" onPress={deleteSelected} />
          </View>
        ) : null}
      </View>

      {/* Undo, the page, and a line of help (or what just happened) above the tools. */}
      <View style={styles.pagerRow}>
        <View style={styles.pagerLine}>
          <Pressable
            onPress={undo}
            disabled={historyLength === 0 || placing}
            accessibilityRole="button"
            accessibilityLabel="Undo"
            accessibilityState={{ disabled: historyLength === 0 }}
            style={({ pressed }) => [styles.undoBtn, (pressed || historyLength === 0) && { opacity: historyLength === 0 ? 0.3 : 0.6 }]}
          >
            <Ionicons name="arrow-undo-outline" size={22} color={colors.chromeText} />
          </Pressable>
          {pageCount > 1 ? (
            <View style={styles.pager}>
              <Pressable
                onPress={() => goPage(pageIndex - 1)}
                disabled={pageIndex === 0 || placing}
                accessibilityRole="button"
                accessibilityLabel="Previous page"
                style={({ pressed }) => [styles.pagerBtn, (pressed || pageIndex === 0) && { opacity: pageIndex === 0 ? 0.3 : 0.6 }]}
              >
                <Ionicons name="chevron-back" size={20} color={colors.chromeText} />
              </Pressable>
              <Text
                style={[Type.footnote, styles.pagerText, { color: colors.chromeText }]}
                accessibilityLiveRegion="polite"
                maxFontSizeMultiplier={1.4}
              >
                {`Page ${pageIndex + 1} of ${pageCount}`}
              </Text>
              <Pressable
                onPress={() => goPage(pageIndex + 1)}
                disabled={pageIndex >= pageCount - 1 || placing}
                accessibilityRole="button"
                accessibilityLabel="Next page"
                style={({ pressed }) => [styles.pagerBtn, (pressed || pageIndex >= pageCount - 1) && { opacity: pageIndex >= pageCount - 1 ? 0.3 : 0.6 }]}
              >
                <Ionicons name="chevron-forward" size={20} color={colors.chromeText} />
              </Pressable>
            </View>
          ) : (
            <View style={styles.pager} />
          )}
          {/* Balances Undo, so the pager stays centred. */}
          <View style={styles.undoBtn} />
        </View>
        {/* Always laid out (a blank line when there is nothing to say), so the page never shifts. */}
        <Text
          style={[Type.footnote, styles.note, { color: colors.chromeMuted }]}
          // One line, always: the page above never moves when it changes.
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.8}
          maxFontSizeMultiplier={1.4}
        >
          {note ?? ' '}
        </Text>
      </View>

      {/* The tools; a PDF that allows filling its form only has none. */}
      {formOnly ? (
        <View style={{ paddingBottom: Math.max(insets.bottom, Spacing.sm) }} />
      ) : (
        <View style={[styles.bar, { backgroundColor: colors.chromeRaised, borderTopColor: colors.chromeBorder, paddingBottom: Math.max(insets.bottom, Spacing.sm) }]}>
          <View style={styles.barRow}>
            {TOOLS.map(t => {
              const on = armed?.kind === t.kind;
              const ready = isInkKind(t.kind) && recent[t.kind === 'initials' ? 'initials' : 'signature'].length > 0;
              return (
                <Pressable
                  key={t.kind}
                  onPress={() => pickTool(t.kind)}
                  onLongPress={isInkKind(t.kind) ? () => pickTool(t.kind, true) : undefined}
                  accessibilityRole="button"
                  accessibilityLabel={t.kind === 'signature' ? 'Signature' : t.label}
                  accessibilityHint={ready ? 'Touch and hold to choose another' : undefined}
                  accessibilityActions={ready ? [{ name: 'longpress', label: t.kind === 'initials' ? 'Change initials' : 'Change signature' }] : undefined}
                  onAccessibilityAction={e => { if (e.nativeEvent.actionName === 'longpress') pickTool(t.kind, true); }}
                  accessibilityState={{ selected: on }}
                  style={({ pressed }) => [styles.tool, pressed && { opacity: 0.55 }]}
                >
                  <View style={[styles.toolIcon, on && { backgroundColor: colors.chromeAccent }]}>
                    <AppIcon name={t.icon} size={22} color={on ? colors.chrome : colors.chromeText} />
                  </View>
                  <Text
                    style={[Type.caption, styles.toolLabel, { color: on ? colors.chromeAccent : colors.chromeText }]}
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.3}
                  >
                    {t.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {/* Typing: a bar on the keyboard; the text shows on the page as it is typed. */}
      {editing && (editingMark || editingField) ? (
        <View
          style={[
            styles.editBar,
            { bottom: kbHeight, backgroundColor: colors.chromeRaised, borderTopColor: colors.chromeBorder },
            kbHeight === 0 && { paddingBottom: Math.max(insets.bottom, Spacing.sm) },
          ]}
        >
          {editingField && textFields.length > 1 ? (
            <View style={styles.fieldNav}>
              <EditBarButton icon="chevron-up" label="Previous field" onPress={() => goField(-1)} disabled={!prevField} />
              <EditBarButton icon="chevron-down" label="Next field" onPress={() => goField(1)} disabled={!nextField} />
            </View>
          ) : null}
          <TextInput
            key={editing.id}
            autoFocus
            value={editingMark ? editingMark.text ?? '' : fieldValue(editingField!, edits).value ?? ''}
            onChangeText={t => {
              if (editingMark) setMarks(list => list.map(m => (m.id === editingMark.id ? { ...m, text: t } : m)));
              else if (editingField) setEdits(e => setFieldText(e, editingField, t));
            }}
            placeholder={editingField ? fieldLabel(editingField) : 'Type text'}
            placeholderTextColor={colors.chromeMuted}
            multiline={editingMark ? true : !!editingField?.multiline}
            maxLength={editingField?.maxLength && editingField.maxLength > 0 ? editingField.maxLength : undefined}
            keyboardAppearance="dark"
            {...(editingField ? keyboardForField(editingField) : {})}
            returnKeyType={editingField && !editingField.multiline ? (nextField ? 'next' : 'done') : 'default'}
            onSubmitEditing={editingField && !editingField.multiline ? () => (nextField ? goField(1) : finishEditing()) : undefined}
            submitBehavior={editingField && !editingField.multiline ? (nextField ? 'submit' : 'blurAndSubmit') : undefined}
            style={[Type.body, styles.editInput, { color: colors.chromeText, backgroundColor: colors.chrome, borderColor: colors.chromeBorder }]}
            accessibilityLabel={editingField ? fieldLabel(editingField) : 'Text'}
          />
          {/* Not a second “Done”: Done in the header saves the PDF; this only puts the keyboard away. */}
          <EditBarButton icon="checkmark-circle-outline" label="Finish typing" hint="Hides the keyboard" onPress={() => finishEditing()} accent />
        </View>
      ) : null}

      <DarkThemeScope>
        <SignatureSheet
          visible={sheet !== null}
          kind={sheet ?? 'signature'}
          recent={recent[sheet ?? 'signature']}
          onPick={sig => {
            pickedSig.current = { kind: sheet ?? 'signature', sig };
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
          onDismissed={onSheetDismissed}
        />
      </DarkThemeScope>

      {saving ? (
        <View style={[styles.overlay, { backgroundColor: colors.chromeScrim }]} pointerEvents="auto" accessibilityViewIsModal>
          <View style={[styles.busyCard, { backgroundColor: colors.chromeRaised, borderColor: colors.chromeBorder }]}>
            <ActivityIndicator color={colors.chromeText} />
            <Text style={[Type.subhead, { color: colors.chromeText }]} accessibilityLiveRegion="polite">Saving…</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** Kept on the page: moved in from any edge it crosses, never resized. */
function clampMark(m: FillMark): FillMark {
  const w = Math.min(m.w, 1);
  const h = Math.min(m.h, 1);
  return { ...m, w, h, x: Math.min(Math.max(0, m.x), 1 - w), y: Math.min(Math.max(0, m.y), 1 - h) };
}

/** An icon button in the selection bar (44 pt, labelled for VoiceOver). */
function SelButton({ icon, label, onPress, disabled }: { icon: AppIconName; label: string; onPress: () => void; disabled?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.selBtn, (pressed || disabled) && { opacity: disabled ? 0.35 : 0.55 }]}
    >
      <AppIcon name={icon} size={22} color={colors.chromeText} />
    </Pressable>
  );
}

/** An icon button on the keyboard’s bar (44 pt). */
function EditBarButton({ icon, label, hint, onPress, disabled, accent }: { icon: AppIconName; label: string; hint?: string; onPress: () => void; disabled?: boolean; accent?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.editBtn, (pressed || disabled) && { opacity: disabled ? 0.3 : 0.55 }]}
    >
      <AppIcon name={icon} size={accent ? 26 : 22} color={accent ? colors.chromeAccent : colors.chromeText} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerBusy: { minWidth: HIT, minHeight: HIT, alignItems: 'center', justifyContent: 'center' },
  area: { flex: 1, overflow: 'hidden' },
  hint: {
    position: 'absolute',
    top: Spacing.sm,
    alignSelf: 'center',
    maxWidth: '92%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingLeft: Spacing.md,
    paddingRight: Spacing.xs,
    minHeight: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
  },
  hintText: { fontWeight: '600', flexShrink: 1 },
  notice: { paddingRight: Spacing.md, paddingVertical: Spacing.sm, borderRadius: Radius.lg, shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 3 } },
  noticeText: { textAlign: 'center', flexShrink: 1 },
  hintAction: { minHeight: 32, justifyContent: 'center', paddingHorizontal: Spacing.xs },
  hintClose: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  // The pager and one line of help, always the same height.
  pagerRow: { alignItems: 'stretch', justifyContent: 'center', paddingHorizontal: Spacing.sm, paddingBottom: Spacing.sm, gap: 0 },
  pagerLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pager: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, flexShrink: 1 },
  pagerBtn: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  pagerText: { fontWeight: '600', minWidth: 96, textAlign: 'center', flexShrink: 1 },
  undoBtn: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  note: { textAlign: 'center', paddingHorizontal: Spacing.sm },
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: Spacing.sm, paddingHorizontal: Spacing.xs },
  barRow: { flexDirection: 'row', alignItems: 'center' },
  tool: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: HIT + 12, gap: 3 },
  toolIcon: { width: 40, height: 28, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center' },
  toolLabel: { fontWeight: '500' },
  selBar: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: HIT + 4,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
  selRule: { width: StyleSheet.hairlineWidth, height: 24, marginHorizontal: Spacing.xs },
  selBtn: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  inks: { flexDirection: 'row', gap: Spacing.xs, alignItems: 'center', paddingHorizontal: Spacing.xs },
  swatchRing: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  swatch: { width: 22, height: 22, borderRadius: 11, borderWidth: 1 },
  editBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingLeft: Spacing.sm,
    paddingRight: Spacing.xs,
    paddingVertical: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  fieldNav: { flexDirection: 'row', alignItems: 'center' },
  editBtn: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  editInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.md,
    paddingTop: 9,
    paddingBottom: 9,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  busyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm + 2,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});

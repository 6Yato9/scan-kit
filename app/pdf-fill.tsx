// app/pdf-fill.tsx
// Fill & sign an imported PDF in place — no "Convert to pages", so its text
// stays text. Tap a form field to fill it in (text, checkboxes, radio buttons,
// lists); choose a tool and tap the page to add text, today's date, a check
// mark, a cross, your signature or initials; drag to move, drag a corner or
// pinch to resize (components/fill-page.tsx). Done writes everything into the
// PDF through the same crash-safe swap as every PDF edit, and the viewer
// offers Undo (lib/pdf-fill.ts, lib/pdf-edit.ts).
//
// Route params: docId, page (zero-based, to open at), from=viewer when the
// viewer is underneath (Done goes back to it; otherwise it opens it).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Animated,
  Keyboard,
  PixelRatio,
  Platform,
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
import { discardPdfEditUndo, holdPdfEditUndo, PdfEditError } from '@/lib/pdf-edit';
import {
  DEFAULT_FONT_SIZE,
  canFillPdf,
  clearFillPreviews,
  displaySize,
  fieldLabel,
  fieldValue,
  fillMessage,
  fillStoredPdf,
  firstChangedPage,
  isEmptyMark,
  isInkKind,
  isTextKind,
  openFillSession,
  pageGeometry,
  pageRectToDisplay,
  planFieldValues,
  renderFillPage,
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
import type { Document } from '@/types/document';
import type { NativeFillField } from '@/modules/vision-ocr/src';

type Status = 'loading' | 'ready' | 'missing' | 'locked' | 'restricted' | 'unreadable' | 'unavailable';
type Armed = { kind: FillMarkKind; signature?: Signature };
type Editing = { type: 'mark'; id: string } | { type: 'field'; id: string };

const TOOLS: { kind: FillMarkKind; icon: AppIconName; label: string; hint: string }[] = [
  { kind: 'text', icon: 'text-outline', label: 'Text', hint: 'Tap where the text goes' },
  { kind: 'date', icon: 'calendar-outline', label: 'Date', hint: 'Tap where the date goes' },
  { kind: 'check', icon: 'checkmark', label: 'Check', hint: 'Tap where the check mark goes' },
  { kind: 'cross', icon: 'close', label: 'Cross', hint: 'Tap where the cross goes' },
  { kind: 'signature', icon: 'signature', label: 'Sign', hint: 'Tap where you sign' },
  { kind: 'initials', icon: 'create-outline', label: 'Initials', hint: 'Tap where your initials go' },
];

/** Long edge of a page preview, in pixels: sharp on a 3x screen, bounded for a phone's memory. */
const MAX_PREVIEW_PX = 1800;

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
  const areaRef = useRef<View>(null);
  const areaTop = useRef(0);
  const pickedSig = useRef<{ kind: SignatureKind; sig: Signature } | null>(null);
  /** A signature field the sheet was opened from: the signature goes in it. */
  const sigField = useRef<NativeFillField | null>(null);
  const usedSignatures = useRef(new Map<string, { kind: SignatureKind; sig: Signature }>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearFillPreviews();
    };
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
        const s = await openFillSession(d.pdfUri);
        if (!live) return;
        if (!s.info.canAnnotate && !s.info.canFillForms) {
          setStatus('restricted');
          return;
        }
        setSession(s);
        setPageIndex(p => Math.min(p, s.info.pageCount - 1));
        setStatus('ready');
      } catch (err) {
        if (!live) return;
        const kind = err instanceof PdfEditError ? err.kind : 'failed';
        setStatus(kind === 'locked' ? 'locked' : kind === 'unavailable' ? 'unavailable' : 'unreadable');
      }
    })();
    return () => { live = false; };
  }, [docId]);

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

  // The page fitted into the space between the header and the bars.
  const fit = useMemo(() => {
    if (!area) return null;
    const aspect = shown.width > 0 ? shown.height / shown.width : 1.3;
    const maxW = Math.max(100, area.w - Spacing.gutter * 2);
    const maxH = Math.max(100, area.h - Spacing.lg * 2);
    const w = Math.floor(Math.min(maxW, maxH / aspect));
    return { w, h: Math.floor(w * aspect) };
  }, [area, shown.width, shown.height]);

  // Render the page on screen (and only it: a phone has little memory to spare).
  const renderKey = fit ? `${pageIndex}-${Math.round(Math.max(fit.w, fit.h) / 200)}` : null;
  useEffect(() => {
    if (status !== 'ready' || !doc?.pdfUri || !fit || !info) return;
    let live = true;
    setRenderFailed(false);
    const px = Math.min(MAX_PREVIEW_PX, Math.round(Math.max(fit.w, fit.h) * PixelRatio.get()));
    const hideFields = info.canFillForms && info.fields.some(f => f.page === pageIndex);
    renderFillPage(doc.pdfUri, pageIndex, px, hideFields)
      .then(r => { if (live) setPreview({ uri: r.uri, page: pageIndex }); })
      .catch(() => { if (live) setRenderFailed(true); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, doc?.pdfUri, renderKey]);

  // ── Keyboard: the edit bar sits on it, the page lifts so the edited box shows ─

  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', e => setKbHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKbHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  const lift = useRef(new Animated.Value(0)).current;
  const editBox = useMemo(() => {
    if (!editing || !fit) return null;
    if (editing.type === 'mark') {
      const m = marks.find(x => x.id === editing.id);
      return m ? { top: m.y * fit.h, bottom: (m.y + m.h) * fit.h } : null;
    }
    const f = pageFields.find(v => v.field.id === editing.id);
    return f ? { top: f.rect.y * fit.h, bottom: (f.rect.y + f.rect.h) * fit.h } : null;
  }, [editing, fit, marks, pageFields]);
  const EDIT_BAR_H = 64;
  useEffect(() => {
    let to = 0;
    if (editBox && kbHeight > 0 && fit && area) {
      const pageTop = areaTop.current + (area.h - fit.h) / 2;
      const visibleBottom = windowH - kbHeight - EDIT_BAR_H - Spacing.md;
      const bottom = pageTop + editBox.bottom;
      // Up just enough, never so far that the box's top leaves the screen.
      to = Math.min(Math.max(0, bottom - visibleBottom), Math.max(0, pageTop + editBox.top - insets.top - Spacing.xl));
    }
    Animated.timing(lift, { toValue: -to, duration: 220, useNativeDriver: true }).start();
  }, [editBox, kbHeight, fit, area, windowH, insets.top, lift]);

  // ── Changes ────────────────────────────────────────────────────────────────

  const fieldChanges = useMemo(() => (info ? planFieldValues(info.fields, edits) : []), [info, edits]);
  const liveMarks = marks.filter(m => !isEmptyMark(m) || (editing?.type === 'mark' && editing.id === m.id));
  const dirty = fieldChanges.length > 0 || marks.some(m => !isEmptyMark(m));

  const updateMark = useCallback((next: FillMark) => {
    setMarks(list => list.map(m => (m.id === next.id ? clampMark(next) : m)));
    if (isTextKind(next.kind) && next.fontSize) setFontSize(next.fontSize);
  }, []);

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
    setEditing(cur => {
      if (cur?.type === 'mark') {
        // Text left empty goes.
        setMarks(list => list.filter(m => m.id !== cur.id || !isEmptyMark(m)));
        setSelectedId(sel => (sel === cur.id ? null : sel));
      }
      return null;
    });
    if (dismiss) Keyboard.dismiss();
  }, []);

  const select = useCallback((id: string | null) => {
    if (editing) finishEditing();
    setSelectedId(id);
    if (id) {
      setArmed(null);
      const m = marks.find(x => x.id === id);
      if (m) setInk(m.ink);
    }
  }, [editing, finishEditing, marks]);

  /** Places the armed tool with its top-left (text) or centre (marks) at the tapped point. */
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
      const ratio = sig.height / sig.width;
      let wPts = W * (tool.kind === 'initials' ? 0.12 : 0.3);
      let cx = fx * W;
      let cy = fy * H;
      if (into) {
        // A signature field: fitted inside it.
        const r = pageRectToDisplay(into.rect, geometry);
        wPts = Math.min(r.w * W, (r.h * H) / ratio) * 0.95;
        cx = (r.x + r.w / 2) * W;
        cy = (r.y + r.h / 2) * H;
      }
      const hPts = wPts * ratio;
      m = { id, page: pageIndex, kind: tool.kind, x: (cx - wPts / 2) / W, y: (cy - hPts / 2) / H, w: wPts / W, h: hPts / H, ink, signature: sig };
      usedSignatures.current.set(sig.dataUri, { kind: tool.kind === 'initials' ? 'initials' : 'signature', sig });
    }
    setMarks(list => [...list, clampMark(m)]);
    setSelectedId(id);
    setArmed(null);
    selection();
    if (isTextKind(m.kind) && m.kind === 'text') setEditing({ type: 'mark', id });
  }, [armed, geometry, info, shown.width, shown.height, fontSize, pageIndex, ink]);

  const onTapPage = useCallback((fx: number, fy: number) => {
    if (editing) {
      finishEditing();
      return;
    }
    if (armed) place(fx, fy);
    else setSelectedId(null);
  }, [editing, armed, place, finishEditing]);

  const onFieldPress = useCallback((f: NativeFillField) => {
    if (!info) return;
    // Straight from one text field to the next: the keyboard stays up.
    const typing = (f.kind === 'text') && !f.readOnly;
    if (editing) finishEditing(!typing);
    setSelectedId(null);
    if (f.kind === 'signature') {
      if (!canAnnotate) return;
      sigField.current = f;
      setSheet('signature');
      return;
    }
    if (f.readOnly) return;
    setArmed(null);
    if (f.kind === 'checkbox' || f.kind === 'radio') {
      setEdits(e => toggleButton(f, info.fields, e));
      selection();
    } else if (f.kind === 'choice') {
      const options = f.options ?? [];
      if (!options.length) return;
      const current = fieldValue(f, edits).value;
      const show = (i: number) => {
        if (i >= 0 && i < options.length) setEdits(e => ({ ...e, [f.id]: { value: options[i] } }));
      };
      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            title: fieldLabel(f),
            message: current ? `Now: ${current}` : undefined,
            options: [...options, 'Cancel'],
            cancelButtonIndex: options.length,
            userInterfaceStyle: 'dark',
          },
          show,
        );
      } else {
        Alert.alert(fieldLabel(f), undefined, [
          ...options.map((o, i) => ({ text: o, onPress: () => show(i) })),
          { text: 'Cancel', style: 'cancel' as const },
        ]);
      }
    } else {
      setEditing({ type: 'field', id: f.id });
    }
  }, [info, editing, finishEditing, canAnnotate, edits]);

  const pickTool = useCallback((kind: FillMarkKind) => {
    if (!canAnnotate) return;
    if (editing) finishEditing();
    setSelectedId(null);
    if (armed?.kind === kind) {
      setArmed(null);
      return;
    }
    tapLight();
    if (isInkKind(kind)) {
      sigField.current = null;
      setArmed(null);
      setSheet(kind === 'initials' ? 'initials' : 'signature');
      return;
    }
    setArmed({ kind });
  }, [canAnnotate, editing, finishEditing, armed]);

  // After the signature sheet has fully closed: arm it, or put it in the field.
  const onSheetDismissed = useCallback(() => {
    const picked = pickedSig.current;
    pickedSig.current = null;
    if (!picked) {
      sigField.current = null;
      return;
    }
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
    setMarks(list => list.filter(m => m.id !== selected.id));
    setSelectedId(null);
    if (editing) finishEditing();
    tapLight();
  };
  const setSelectedInk = (next: FillInk) => {
    setInk(next);
    if (selected) updateMark({ ...selected, ink: next });
  };
  const resizeText = (dir: 1 | -1) => {
    if (!selected || !isTextKind(selected.kind)) return;
    const size = Math.min(MAX_FONT, Math.max(MIN_FONT, stepFontSize(selected.fontSize ?? DEFAULT_FONT_SIZE, dir)));
    updateMark({ ...selected, fontSize: size });
    selection();
  };

  const goPage = (next: number) => {
    if (next < 0 || next >= pageCount || next === pageIndex) return;
    if (editing) finishEditing();
    setSelectedId(null);
    setPageIndex(next);
  };

  // ── Leaving ────────────────────────────────────────────────────────────────

  const close = () => {
    if (saving) return;
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
    if (saving || !doc?.pdfUri || !session || !info) return;
    if (editing) finishEditing();
    const kept = marks.filter(m => !isEmptyMark(m));
    if (kept.length === 0 && fieldChanges.length === 0) {
      router.back();
      return;
    }
    setSaving(true);
    const showPage = firstChangedPage(kept, fieldChanges, info.fields, pageIndex);
    const message = fillMessage(kept, fieldChanges.length);
    try {
      const { undo } = await fillStoredPdf(doc.id, doc.pdfUri, session, kept, edits, showPage);
      // Signatures and initials used are remembered for next time, like Sign.
      for (const m of kept) {
        const used = m.signature ? usedSignatures.current.get(m.signature.dataUri) : null;
        if (used) await rememberSignature(used.sig, Date.now(), used.kind).catch(() => {});
      }
      notifySuccess();
      // The viewer offers Undo (in its toast and its "…" menu) until it is used
      // or expires; the stash is kept until then.
      const held = undo ? holdPdfEditUndo(doc.id) ?? undo : null;
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
                    postViewerNotice({ docId: id, message: message === 'Signed' ? 'Signature removed' : 'Change undone' });
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
      setSaving(false);
      notifyError();
      const kind = err instanceof PdfEditError ? err.kind : 'failed';
      if (kind === 'partial') {
        Alert.alert('Your PDF was changed', 'Scan Kit couldn’t finish saving the change, so it can’t be undone. It’s finished the next time Scan Kit opens. Check that there’s free space.');
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

  const header = (
    <ScreenHeader
      dark
      title="Fill & sign"
      left={<HeaderTextButton title="Cancel" color={colors.chromeText} onPress={close} disabled={saving} />}
      right={
        saving ? (
          <View style={styles.headerBusy}><ActivityIndicator color={colors.chromeText} /></View>
        ) : (
          <HeaderTextButton title="Done" emphasis color={colors.chromeAccent} onPress={() => { save(); }} disabled={status !== 'ready'} />
        )
      }
    />
  );

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
        title: 'This PDF can’t be filled in or signed',
        subtitle: 'Its author doesn’t allow changes to it. You can still view, share and print it.',
      },
      unreadable: { icon: 'document-text-outline', title: 'Couldn’t open this PDF', subtitle: 'The file may be damaged. You can still share it, or try importing it again.' },
      unavailable: { icon: 'document-text-outline', title: 'Fill & sign isn’t available', subtitle: 'This version of Scan Kit can’t fill in PDFs. Update Scan Kit, then try again.' },
    };
    const e = status === 'loading' || status === 'ready' ? null : empty[status];
    return (
      <View style={[styles.container, { backgroundColor: colors.chrome }]}>
        <ScreenHeader
          dark
          title="Fill & sign"
          left={<HeaderTextButton title="Cancel" color={colors.chromeText} onPress={() => router.back()} />}
        />
        {e ? (
          <View style={styles.centered}>
            <EmptyState
              chrome
              placement="center"
              icon={e.icon}
              title={e.title}
              subtitle={e.subtitle}
              {...(status === 'locked' && doc && !fromViewer
                ? { actionLabel: 'Open PDF', actionIcon: 'key-outline' as const, onAction: () => router.replace({ pathname: '/viewer', params: { id: doc.id } }) }
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
  const note = !canAnnotate
    ? 'The author of this PDF allows filling in its form only.'
    : hasFields && !fieldsEnabled
      ? 'The author of this PDF doesn’t allow filling in its form. You can still add text and sign it.'
      : marks.length === 0 && fieldChanges.length === 0 && !armed
        ? hasFields && fieldsEnabled
          ? 'Tap a field to fill it in, or choose a tool below.'
          : 'Choose a tool below, then tap the page where it goes.'
        : null;

  return (
    <View style={[styles.container, { backgroundColor: colors.chrome }]}>
      {header}
      <View
        ref={areaRef}
        style={styles.area}
        onLayout={e => {
          const { width, height } = e.nativeEvent.layout;
          setArea(a => (a && Math.abs(a.w - width) < 1 && Math.abs(a.h - height) < 1 ? a : { w: width, h: height }));
          areaRef.current?.measureInWindow((_x, y) => { if (Number.isFinite(y)) areaTop.current = y; });
        }}
      >
        {fit ? (
          <Animated.View style={{ transform: [{ translateY: lift }] }}>
            <FillPage
              uri={pagePreview}
              width={fit.w}
              height={fit.h}
              pageWidth={shown.width}
              fields={pageFields}
              fieldsEnabled={fieldsEnabled}
              edits={edits}
              activeFieldId={editingField?.id ?? null}
              marks={liveMarks.filter(m => m.page === pageIndex)}
              selectedId={selectedId}
              armed={!!armed}
              onTapPage={onTapPage}
              onFieldPress={onFieldPress}
              onSelect={select}
              onMarkChange={updateMark}
              onMeasure={measureMark}
              onInteracting={setPlacing}
            />
            {!pagePreview ? (
              <View style={[StyleSheet.absoluteFill, styles.centered]} pointerEvents="none">
                {renderFailed ? (
                  <Text style={[Type.footnote, { color: colors.chromeMuted }]}>Couldn’t show this page.</Text>
                ) : (
                  <ActivityIndicator color={colors.chromeMuted} />
                )}
              </View>
            ) : null}
          </Animated.View>
        ) : null}
        {armedTool ? (
          <View style={[styles.hint, { backgroundColor: colors.chromeRaised, borderColor: colors.chromeBorder }]} pointerEvents="box-none">
            <Text style={[Type.subhead, styles.hintText, { color: colors.chromeText }]} accessibilityLiveRegion="polite">
              {armedTool.hint}
            </Text>
            <Pressable
              onPress={() => setArmed(null)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              style={({ pressed }) => [styles.hintClose, pressed && { opacity: 0.6 }]}
            >
              <Ionicons name="close" size={18} color={colors.chromeMuted} />
            </Pressable>
          </View>
        ) : null}
      </View>

      {/* Page and a line of help above the tools — or, while an addition is
          selected, what can be done with it (the tools stay in reach). */}
      <View style={styles.pagerRow}>
        {selected ? (
          <View style={[styles.selBar, { backgroundColor: colors.chromeRaised, borderColor: colors.chromeBorder }]}>
            <View style={styles.inks} accessibilityRole="radiogroup" accessibilityLabel="Ink">
              {(['black', 'blue'] as const).map(k => {
                const on = selected.ink === k;
                return (
                  <Pressable
                    key={k}
                    onPress={() => setSelectedInk(k)}
                    hitSlop={6}
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
                <SelButton icon="create-outline" label="Edit text" onPress={() => setEditing({ type: 'mark', id: selected.id })} />
              </>
            ) : null}
            <SelButton icon="trash-outline" label="Delete" onPress={deleteSelected} />
          </View>
        ) : (
          <>
            {pageCount > 1 ? (
              <View style={styles.pager}>
                <Pressable
                  onPress={() => goPage(pageIndex - 1)}
                  disabled={pageIndex === 0 || placing}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Previous page"
                  style={({ pressed }) => [styles.pagerBtn, (pressed || pageIndex === 0) && { opacity: pageIndex === 0 ? 0.3 : 0.6 }]}
                >
                  <Ionicons name="chevron-back" size={20} color={colors.chromeText} />
                </Pressable>
                <Text style={[Type.footnote, styles.pagerText, { color: colors.chromeText }]} accessibilityLiveRegion="polite">
                  {`Page ${pageIndex + 1} of ${pageCount}`}
                </Text>
                <Pressable
                  onPress={() => goPage(pageIndex + 1)}
                  disabled={pageIndex >= pageCount - 1 || placing}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Next page"
                  style={({ pressed }) => [styles.pagerBtn, (pressed || pageIndex >= pageCount - 1) && { opacity: pageIndex >= pageCount - 1 ? 0.3 : 0.6 }]}
                >
                  <Ionicons name="chevron-forward" size={20} color={colors.chromeText} />
                </Pressable>
              </View>
            ) : null}
            {/* Always laid out (a blank line when there is nothing to say), so the page never shifts. */}
            <Text style={[Type.footnote, styles.note, { color: colors.chromeMuted }]} numberOfLines={2}>{note ?? ' '}</Text>
          </>
        )}
      </View>

      {/* The tools. */}
      <View style={[styles.bar, { backgroundColor: colors.chromeRaised, borderTopColor: colors.chromeBorder, paddingBottom: Math.max(insets.bottom, Spacing.sm) }]}>
          <View style={styles.barRow}>
            {TOOLS.map(t => {
              const on = armed?.kind === t.kind;
              return (
                <Pressable
                  key={t.kind}
                  onPress={() => pickTool(t.kind)}
                  disabled={!canAnnotate}
                  accessibilityRole="button"
                  accessibilityLabel={t.kind === 'signature' ? 'Signature' : t.label}
                  accessibilityState={{ selected: on, disabled: !canAnnotate }}
                  style={({ pressed }) => [styles.tool, (pressed || !canAnnotate) && { opacity: !canAnnotate ? 0.35 : 0.55 }]}
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

      {/* Typing: a bar on the keyboard; the text shows on the page as it is typed. */}
      {editing && (editingMark || editingField) ? (
        <View
          style={[
            styles.editBar,
            { bottom: kbHeight, backgroundColor: colors.chromeRaised, borderTopColor: colors.chromeBorder },
            kbHeight === 0 && { paddingBottom: Math.max(insets.bottom, Spacing.sm) },
          ]}
        >
          <TextInput
            key={editing.id}
            autoFocus
            value={editingMark ? editingMark.text ?? '' : fieldValue(editingField!, edits).value ?? ''}
            onChangeText={t => {
              if (editingMark) setMarks(list => list.map(m => (m.id === editingMark.id ? { ...m, text: t } : m)));
              else if (editingField) setEdits(e => ({ ...e, [editingField.id]: { value: t } }));
            }}
            placeholder={editingField ? fieldLabel(editingField) : 'Type text'}
            placeholderTextColor={colors.chromeMuted}
            multiline={editingMark ? true : !!editingField?.multiline}
            maxLength={editingField?.maxLength && editingField.maxLength > 0 ? editingField.maxLength : undefined}
            keyboardAppearance="dark"
            returnKeyType={editingField && !editingField.multiline ? 'done' : 'default'}
            onSubmitEditing={editingField && !editingField.multiline ? () => finishEditing() : undefined}
            blurOnSubmit={!!editingField && !editingField.multiline}
            style={[Type.body, styles.editInput, { color: colors.chromeText, backgroundColor: colors.chrome, borderColor: colors.chromeBorder }]}
            accessibilityLabel={editingField ? fieldLabel(editingField) : 'Text'}
          />
          <HeaderTextButton title="Done" emphasis color={colors.chromeAccent} onPress={() => finishEditing()} />
        </View>
      ) : null}

      <DarkThemeScope>
        <SignatureSheet
          visible={sheet !== null}
          kind={sheet ?? 'signature'}
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

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerBusy: { minWidth: HIT, minHeight: HIT, alignItems: 'center', justifyContent: 'center' },
  area: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  hint: {
    position: 'absolute',
    top: Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingLeft: Spacing.md,
    paddingRight: Spacing.xs,
    minHeight: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
  },
  hintText: { fontWeight: '600' },
  hintClose: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  // Tall enough for the selection bar or the pager and a line of help: switching never moves the page.
  pagerRow: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.sm, gap: Spacing.xs, minHeight: 64 },
  pager: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  pagerBtn: { width: HIT, height: 32, alignItems: 'center', justifyContent: 'center' },
  pagerText: { fontWeight: '600', minWidth: 96, textAlign: 'center' },
  note: { textAlign: 'center' },
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: Spacing.sm, paddingHorizontal: Spacing.xs },
  barRow: { flexDirection: 'row', alignItems: 'center' },
  tool: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: HIT + 12, gap: 3 },
  toolIcon: { width: 40, height: 28, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center' },
  toolLabel: { fontWeight: '500' },
  selBar: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: HIT + 4,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
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
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
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

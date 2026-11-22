// components/fill-page.tsx
// One page of Fill & sign (app/pdf-fill.tsx): the page as rendered by PDFKit,
// its form fields as tappable boxes showing their values, and what the user
// added (text, date, check marks, crosses, signatures, initials) on top —
// inside a viewport that zooms and pans like Preview.
//
// Zoom: pinch or double-tap the page to zoom (1–4×), drag with one finger to
// move a zoomed page. The page is laid out at its zoomed size (not scaled as
// a picture), so text and signatures stay sharp, corner handles keep their
// size and every position stays a fraction of the page: what is placed
// zoomed in lands where it shows. While a gesture runs the page is moved with
// a transform; when the fingers lift, that becomes the new layout.
//
// Additions are handled the way Sign places a signature
// (components/placement-frame.tsx, lib/placement.ts): drag one to move it,
// drag a corner of the selected one — or pinch ON it — to resize it (text
// changes its font size), tap to select. A pinch anywhere else zooms. A tap
// anywhere else goes to the screen (place the armed tool there, or deselect);
// a tap on a field fills it. Small targets (checkboxes, small marks) answer
// to taps within 22 pt of their centre, so every one is a 44-pt target.
//
// What is drawn here is what native draws into the PDF (PdfFiller.swift): the
// same Helvetica text from the top-left of its box, the same check-mark and
// cross strokes (as fractions of the box, with round caps), the signature
// tinted to its ink. Page content ignores the system text size
// (allowFontScaling={false}): the PDF doesn't grow with it.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Image, StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/contexts/theme-context';
import { selection } from '@/lib/haptics';
import {
  DOUBLE_TAP_ZOOM,
  HANDLES,
  MAX_ZOOM,
  MIN_ZOOM,
  clampView,
  fittedView,
  handleTargetOffset,
  hitSlopFor,
  liveTransform,
  moveBox,
  resizeBox,
  scaleBox,
  zoomViewAbout,
  type Box,
  type Handle,
  type PageView,
  type Size,
} from '@/lib/placement';
import { Highlight } from '@/lib/theme';
import { SIGNATURE_INK } from '@/lib/stamp';
import { fieldLabel, fieldValue, isFillable, isInkKind, isTextKind, markText, type DisplayRect, type FieldEdits, type FillMark } from '@/lib/pdf-fill';
import type { NativeFillField } from '@/modules/vision-ocr/src';

const DOT = 12;
const TARGET = 44;
const BODY_SLOP = 8;
const FIELD_SLOP = 4;
/** How far around the selected mark a pinch still resizes it (instead of zooming the page). */
const PINCH_MARK_SLOP = 24;
/** Font sizes text can be resized between, in PDF points. */
export const MIN_FONT = 6;
export const MAX_FONT = 72;
/** Smallest a check mark, cross or signature can be made, in preview points. */
const MIN_MARK_POINTS = 10;
const MIN_SIGNATURE_POINTS = 28;

export type FieldView = { field: NativeFillField; rect: DisplayRect };

type Props = {
  uri: string | null;
  /** The page fitted in the viewport (zoom 1), in points; its aspect is the page's as shown. */
  fit: Size;
  /** The space the page is shown in. */
  viewport: Size;
  /** Room kept around a zoomed page's edges (it never pulls further in). */
  margin: Size;
  /** Zoom and position (lib/placement PageView); the screen owns it. */
  view: PageView;
  onViewChange: (v: PageView) => void;
  /** The page's size as shown, in PDF points: text sizes scale by width / pageWidth. */
  pageWidth: number;
  fields: FieldView[];
  /** The form can be filled (permissions): fields are tappable and highlighted. */
  fieldsEnabled: boolean;
  edits: FieldEdits;
  activeFieldId: string | null;
  marks: FillMark[];
  selectedId: string | null;
  /** A tool is armed: taps on the page place it. */
  armed: boolean;
  /** A tap on the page, nowhere on a field or addition (fractions of the page). */
  onTapPage: (x: number, y: number) => void;
  /** A tap beside the page (a zoomed-out page's surroundings). */
  onTapOutside: () => void;
  /** A tap on (or within reach of) a field; `at`: where, in fractions of the page. */
  onFieldPress: (f: NativeFillField, at?: { x: number; y: number }) => void;
  onSelect: (id: string | null) => void;
  /** A mark moved or was resized by hand (when the finger lifts). */
  onMarkChange: (m: FillMark) => void;
  /** A text mark's measured size changed (fractions of the page). */
  onMeasure: (id: string, w: number, h: number) => void;
  onInteracting?: (active: boolean) => void;
  /** Drawn over the page (its loading state). */
  overlay?: ReactNode;
};

const toBox = (m: Pick<FillMark, 'x' | 'y' | 'w' | 'h'>, W: number, H: number): Box => ({ x: m.x * W, y: m.y * H, w: m.w * W, h: m.h * H });

/** The strokes of a check mark / cross, as fractions of their box (y down), like PdfFiller.swift. */
const CHECK: [number, number][][] = [[[0.16, 0.48], [0.40, 0.76], [0.86, 0.20]]];
const CROSS: [number, number][][] = [[[0.2, 0.2], [0.8, 0.8]], [[0.2, 0.8], [0.8, 0.2]]];

/** Round-capped strokes drawn with plain views (no SVG in this app). */
function Strokes({ paths, w, h, color }: { paths: [number, number][][]; w: number; h: number; color: string }) {
  const t = Math.max(1, Math.min(w, h) * 0.13);
  const segments: { left: number; top: number; len: number; angle: number }[] = [];
  for (const path of paths) {
    for (let i = 0; i + 1 < path.length; i++) {
      const [ax, ay] = [path[i][0] * w, path[i][1] * h];
      const [bx, by] = [path[i + 1][0] * w, path[i + 1][1] * h];
      const len = Math.hypot(bx - ax, by - ay) + t; // + the two round caps
      segments.push({ left: (ax + bx) / 2 - len / 2, top: (ay + by) / 2 - t / 2, len, angle: Math.atan2(by - ay, bx - ax) });
    }
  }
  return (
    <>
      {segments.map((s, i) => (
        <View
          key={i}
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: s.left,
            top: s.top,
            width: s.len,
            height: t,
            borderRadius: t / 2,
            backgroundColor: color,
            transform: [{ rotate: `${s.angle}rad` }],
          }}
        />
      ))}
    </>
  );
}

/** A radio button's own value as words ("yes" → "Yes"), or null when it is only a code ("0", "On"). */
function radioValueName(onValue: string | undefined): string | null {
  const v = (onValue ?? '').replace(/[_-]+/g, ' ').trim();
  if (!v || /^\d+$/.test(v) || /^on$/i.test(v)) return null;
  return v[0].toUpperCase() + v.slice(1);
}

/** What VoiceOver says a field is. */
function fieldA11y(f: NativeFillField, v: { value?: string; on?: boolean }, fillable: boolean) {
  const name = fieldLabel(f);
  switch (f.kind) {
    case 'checkbox':
      return { role: 'checkbox' as const, label: name, value: undefined, hint: undefined, checked: !!v.on };
    case 'radio':
      // "Pets, Yes" / "Pets, No": the group's buttons apart by their own values.
      return { role: 'radio' as const, label: radioValueName(f.onValue) ? `${name}, ${radioValueName(f.onValue)}` : name, value: undefined, hint: undefined, checked: !!v.on };
    case 'choice':
      return { role: 'button' as const, label: `${name}, pop-up list`, value: v.value || undefined, hint: fillable ? 'Double-tap to choose' : undefined, checked: undefined };
    case 'signature':
      return { role: 'button' as const, label: `${name}, signature field`, value: undefined, hint: 'Double-tap to sign here', checked: undefined };
    default:
      return { role: 'button' as const, label: `${name}, text field`, value: v.value || undefined, hint: fillable ? 'Double-tap to type' : undefined, checked: undefined };
  }
}

/** A field's box on the page, with its value. */
const FieldBox = memo(function FieldBox({
  view,
  W,
  H,
  scale,
  edits,
  active,
  enabled,
  onPress,
}: {
  view: FieldView;
  W: number;
  H: number;
  scale: number;
  edits: FieldEdits;
  active: boolean;
  enabled: boolean;
  onPress: (f: NativeFillField, at?: { x: number; y: number }) => void;
}) {
  const { colors } = useTheme();
  const { field: f, rect } = view;
  const box = toBox(rect, W, H);
  const fillable = enabled && isFillable(f);
  const v = fieldValue(f, edits);
  const ink = SIGNATURE_INK.black;
  // The PDF's own size when it names one; otherwise fitted to the box, like "auto".
  const auto = f.multiline ? 11 : Math.max(6, Math.min(12, (box.h / scale) * 0.62));
  const font = Math.max(5, (f.fontSize > 0 ? f.fontSize : auto) * scale);
  let content: React.ReactNode = null;
  if (f.kind === 'checkbox' || f.kind === 'radio') {
    if (v.on) {
      const s = Math.min(box.w, box.h);
      content = f.kind === 'radio' ? (
        <View style={[styles.radioDot, { width: s * 0.5, height: s * 0.5, borderRadius: s * 0.25, backgroundColor: ink }]} />
      ) : (
        <View style={{ width: s, height: s }}>
          <Strokes paths={CHECK} w={s} h={s} color={ink} />
        </View>
      );
    }
  } else if (f.kind === 'text' || f.kind === 'choice') {
    content = v.value ? (
      <Text
        // Page content: the PDF doesn't grow with the system text size.
        allowFontScaling={false}
        numberOfLines={f.multiline ? undefined : 1}
        style={[
          styles.fieldText,
          {
            fontSize: font,
            lineHeight: font * 1.15,
            color: ink,
            textAlign: f.align ?? 'left',
            paddingHorizontal: Math.max(1, 2 * scale),
            paddingTop: f.multiline ? Math.max(1, 2 * scale) : 0,
          },
        ]}
      >
        {v.value}
      </Text>
    ) : null;
  }
  const a11y = fieldA11y(f, v, fillable);
  const tappable = fillable || (enabled && f.kind === 'signature');
  return (
    <View
      // Touches go to the page's gestures (FillPage); VoiceOver activates it directly.
      accessible
      accessibilityRole={a11y.role}
      accessibilityLabel={a11y.label}
      accessibilityValue={a11y.value ? { text: a11y.value } : undefined}
      accessibilityHint={a11y.hint}
      accessibilityState={{ checked: a11y.checked, disabled: !tappable, selected: active }}
      onAccessibilityTap={tappable ? () => onPress(f) : undefined}
      style={[
        styles.field,
        f.kind === 'radio' && { borderRadius: Math.min(box.w, box.h) / 2 },
        {
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          justifyContent: f.multiline ? 'flex-start' : 'center',
          alignItems: f.kind === 'checkbox' || f.kind === 'radio' ? 'center' : 'stretch',
        },
        fillable && { backgroundColor: `${Highlight.blue}55`, borderColor: active ? colors.accentFill : `${Highlight.blue}` },
        active && styles.fieldActive,
      ]}
    >
      {content}
      {f.kind === 'choice' && fillable ? (
        <View style={[styles.choiceChevron, { right: 1 }]} pointerEvents="none">
          <Ionicons name="chevron-down" size={Math.max(8, Math.min(14, box.h * 0.6))} color={colors.accentFill} />
        </View>
      ) : null}
    </View>
  );
});

type Interacting = { begin: () => void; end: () => void };

/** One addition: drawn, draggable, and with corner handles while selected. */
const MarkView = memo(function MarkView({
  mark,
  W,
  H,
  scale,
  selected,
  onSelect,
  onChange,
  onMeasure,
  interacting,
  pinchBox,
}: {
  mark: FillMark;
  W: number;
  H: number;
  scale: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onChange: (m: FillMark) => void;
  onMeasure: (id: string, w: number, h: number) => void;
  interacting: Interacting;
  /** The box while the page is being pinched (selected mark only). */
  pinchBox: Box | null;
}) {
  const { colors } = useTheme();
  const committed = toBox(mark, W, H);
  const [live, setLive] = useState<Box | null>(null);
  const box = pinchBox ?? live ?? committed;
  const ink = SIGNATURE_INK[mark.ink] ?? SIGNATURE_INK.black;
  const text = isTextKind(mark.kind);
  const fontPt = mark.fontSize ?? 12;
  // Text, and any small mark: handles just outside it, never on it.
  const pad = text || Math.min(committed.w, committed.h) < 30 ? DOT / 2 + 2 : 0;
  // Text follows the box while it is being resized.
  const liveFont = text && committed.w > 0 ? Math.min(MAX_FONT, Math.max(MIN_FONT, fontPt * (box.w / committed.w))) : fontPt;
  // A small mark answers to a drag that starts up to 22 pt from its centre.
  const slopX = Math.round(hitSlopFor(committed.w, BODY_SLOP, TARGET));
  const slopY = Math.round(hitSlopFor(committed.h, BODY_SLOP, TARGET));
  const latest = useRef({ mark, W, H, onChange, onSelect, committed });
  useEffect(() => {
    latest.current = { mark, W, H, onChange, onSelect, committed };
  });
  /** This mark's drags in progress; one that is cut short by the mark going away still ends. */
  const active = useRef(0);
  useEffect(() => () => {
    while (active.current > 0) {
      active.current -= 1;
      interacting.end();
    }
  }, [interacting]);

  const gestures = useMemo(() => {
    const g = { from: null as Box | null, current: null as Box | null };
    const bounds = () => ({ width: latest.current.W, height: latest.current.H });
    const minW = (b: Box) => {
      const m = latest.current.mark;
      if (isTextKind(m.kind)) return b.w * (MIN_FONT / (m.fontSize ?? 12));
      return isInkKind(m.kind) ? MIN_SIGNATURE_POINTS : MIN_MARK_POINTS;
    };
    const commit = () => {
      const b = g.current;
      g.from = null;
      g.current = null;
      setLive(null);
      if (!b) return;
      const { mark: m, W: w, H: h, committed: c } = latest.current;
      const next: FillMark = { ...m, x: b.x / w, y: b.y / h, w: b.w / w, h: b.h / h };
      if (isTextKind(m.kind) && c.w > 0 && Math.abs(b.w - c.w) > 0.5) {
        next.fontSize = Math.round(Math.min(MAX_FONT, Math.max(MIN_FONT, (m.fontSize ?? 12) * (b.w / c.w))) * 2) / 2;
      }
      latest.current.onChange(next);
    };
    const body = Gesture.Pan()
      .runOnJS(true)
      .minDistance(2)
      .maxPointers(1)
      .hitSlop({ horizontal: slopX, vertical: slopY })
      // Counted from activation (a drag), not touch-down: a plain tap on the
      // mark goes to the page's tap and never ends this one.
      .onStart(() => {
        active.current += 1;
        interacting.begin();
        g.from = latest.current.committed;
        latest.current.onSelect(latest.current.mark.id);
      })
      .onUpdate(e => {
        if (!g.from) return;
        g.current = moveBox(g.from, e.translationX, e.translationY, bounds());
        setLive(g.current);
      })
      .onEnd(commit)
      .onFinalize(() => {
        if (active.current > 0) {
          active.current -= 1;
          interacting.end();
        }
        if (g.from) commit();
      });
    const corners = {} as Record<Handle, ReturnType<typeof Gesture.Pan>>;
    for (const hd of HANDLES) {
      corners[hd] = Gesture.Pan()
        .runOnJS(true)
        .minDistance(0)
        .onStart(() => {
          active.current += 1;
          interacting.begin();
          g.from = latest.current.committed;
        })
        .onUpdate(e => {
          if (!g.from) return;
          g.current = resizeBox(g.from, hd, e.translationX, e.translationY, bounds(), minW(g.from));
          setLive(g.current);
        })
        .onEnd(commit)
        .onFinalize(() => {
          if (active.current > 0) {
            active.current -= 1;
            interacting.end();
          }
          if (g.from) commit();
        });
    }
    return { body, corners };
  }, [interacting, slopX, slopY]);

  // VoiceOver: actions to move and resize.
  const onA11y = (e: AccessibilityActionEvent) => {
    const b = committed;
    const bounds = { width: W, height: H };
    let next: Box | null = null;
    switch (e.nativeEvent.actionName) {
      case 'increment': next = scaleBox(b, 1.15, bounds, 1); break;
      case 'decrement': next = scaleBox(b, 1 / 1.15, bounds, 1); break;
      case 'moveLeft': next = moveBox(b, -W * 0.05, 0, bounds); break;
      case 'moveRight': next = moveBox(b, W * 0.05, 0, bounds); break;
      case 'moveUp': next = moveBox(b, 0, -H * 0.05, bounds); break;
      case 'moveDown': next = moveBox(b, 0, H * 0.05, bounds); break;
    }
    if (!next) return;
    const m: FillMark = { ...mark, x: next.x / W, y: next.y / H, w: next.w / W, h: next.h / H };
    if (text && b.w > 0) m.fontSize = Math.min(MAX_FONT, Math.max(MIN_FONT, fontPt * (next.w / b.w)));
    onChange(m);
  };

  const label =
    mark.kind === 'text' ? `Text: ${markText(mark) || 'empty'}`
    : mark.kind === 'date' ? `Date: ${markText(mark)}`
    : mark.kind === 'check' ? 'Check mark'
    : mark.kind === 'cross' ? 'Cross'
    : mark.kind === 'initials' ? 'Initials' : 'Signature';

  return (
    <>
      {text ? (
        // Laid out on a wide strip so the text never wraps (native draws its
        // lines as typed); its measured size is the mark's box.
        <View pointerEvents="none" style={[styles.textStrip, { left: box.x, top: box.y }]}>
          <Text
            // Page content: the PDF doesn't grow with the system text size.
            allowFontScaling={false}
            onLayout={e => {
              const { width: w, height: h } = e.nativeEvent.layout;
              if (pinchBox || live) return;
              const fw = w / W;
              const fh = h / H;
              if (Math.abs(fw - mark.w) > 0.002 || Math.abs(fh - mark.h) > 0.002) onMeasure(mark.id, fw, fh);
            }}
            style={[styles.markText, { fontSize: liveFont * scale, lineHeight: undefined, color: ink }]}
          >
            {markText(mark) || ' '}
          </Text>
        </View>
      ) : null}
      <GestureDetector gesture={gestures.body}>
        <View
          collapsable={false}
          style={[styles.markBody, { left: box.x, top: box.y, width: Math.max(box.w, 1), height: Math.max(box.h, 1) }]}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={label}
          accessibilityHint={selected ? 'Drag to move it. Drag a corner, or pinch on it, to resize it.' : 'Double-tap to select it.'}
          accessibilityState={{ selected }}
          accessibilityActions={[
            { name: 'increment', label: 'Larger' },
            { name: 'decrement', label: 'Smaller' },
            { name: 'moveLeft', label: 'Move left' },
            { name: 'moveRight', label: 'Move right' },
            { name: 'moveUp', label: 'Move up' },
            { name: 'moveDown', label: 'Move down' },
            { name: 'activate', label: 'Select' },
          ]}
          onAccessibilityAction={e => {
            if (e.nativeEvent.actionName === 'activate') onSelect(mark.id);
            else onA11y(e);
          }}
        >
          {mark.kind === 'check' ? <Strokes paths={CHECK} w={box.w} h={box.h} color={ink} /> : null}
          {mark.kind === 'cross' ? <Strokes paths={CROSS} w={box.w} h={box.h} color={ink} /> : null}
          {isInkKind(mark.kind) && mark.signature ? (
            <Image
              key={ink}
              source={{ uri: mark.signature.dataUri }}
              style={[StyleSheet.absoluteFill, { tintColor: ink }]}
              resizeMode="stretch"
            />
          ) : null}
          {selected ? (
            <View pointerEvents="none" style={[styles.outline, { borderColor: colors.accentFill, margin: -3 - pad }]} />
          ) : null}
        </View>
      </GestureDetector>
      {selected
        ? HANDLES.map(hd => {
            const cx = hd === 'tl' || hd === 'bl' ? box.x - pad : box.x + box.w + pad;
            const cy = hd === 'tl' || hd === 'tr' ? box.y - pad : box.y + box.h + pad;
            const off = handleTargetOffset(hd, box.w + pad * 2, box.h + pad * 2, TARGET);
            return (
              <GestureDetector key={hd} gesture={gestures.corners[hd]}>
                <View
                  collapsable={false}
                  style={[styles.target, { left: cx + off.left, top: cy + off.top }]}
                  accessible={false}
                  importantForAccessibility="no-hide-descendants"
                >
                  <View
                    pointerEvents="none"
                    style={[
                      styles.dot,
                      {
                        left: -off.left - DOT / 2,
                        top: -off.top - DOT / 2,
                        backgroundColor: colors.accentFill,
                        borderColor: colors.onAccent,
                        shadowColor: colors.shadow,
                      },
                    ]}
                  />
                </View>
              </GestureDetector>
            );
          })
        : null}
    </>
  );
});

/**
 * The page picture. A new render (another zoom level) is drawn over the old
 * one once it has loaded, so zooming never flashes an empty page.
 */
function PagePicture({ uri, width, height }: { uri: string | null; width: number; height: number }) {
  const { colors } = useTheme();
  const [base, setBase] = useState<string | null>(uri);
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => {
    if (!uri) {
      setBase(null);
      setNext(null);
    } else if (!base) {
      setBase(uri);
    } else if (uri !== base) {
      setNext(uri);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);
  const size = { width, height };
  return (
    <View style={[size, { backgroundColor: base ? undefined : colors.placeholder }]} pointerEvents="none">
      {base ? <Image source={{ uri: base }} style={size} resizeMode="stretch" /> : null}
      {next ? (
        <Image
          key={next}
          source={{ uri: next }}
          style={[StyleSheet.absoluteFill, size]}
          resizeMode="stretch"
          onLoad={() => {
            setBase(next);
            setNext(null);
          }}
          onError={() => setNext(null)}
        />
      ) : null}
    </View>
  );
}

/** True when (x, y) is within `sx`/`sy` points of box `b`; also how far off it is. */
function near(b: Box, x: number, y: number, sx: number, sy: number): { hit: boolean; inside: boolean; dist: number } {
  const dx = x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0;
  const dy = y < b.y ? b.y - y : y > b.y + b.h ? y - (b.y + b.h) : 0;
  return { hit: dx <= sx && dy <= sy, inside: dx === 0 && dy === 0, dist: Math.hypot(dx, dy) };
}

/** The mark under (x, y) in page points: the selected one first, then the top-most. */
function markAt(marks: FillMark[], selectedId: string | null, x: number, y: number, W: number, H: number, extra = 0): FillMark | null {
  const order = [...marks].reverse().sort((a, b) => (a.id === selectedId ? -1 : b.id === selectedId ? 1 : 0));
  return order.find(m => {
    const b = toBox(m, W, H);
    const more = m.id === selectedId ? extra : 0;
    return near(b, x, y, hitSlopFor(b.w, BODY_SLOP) + more, hitSlopFor(b.h, BODY_SLOP) + more).hit;
  }) ?? null;
}

/**
 * The field under (x, y) in page points: one the point is inside (the
 * smallest: a checkbox inside a table cell), else the nearest within reach.
 * Checkboxes and radio buttons reach 22 pt from their centre (44-pt targets);
 * a thin text field reaches up to 12 pt above and below.
 */
export function fieldAt(fields: FieldView[], x: number, y: number, W: number, H: number): FieldView | null {
  let best: { v: FieldView; inside: boolean; dist: number; area: number } | null = null;
  for (const v of fields) {
    if (!isFillable(v.field) && v.field.kind !== 'signature') continue;
    const b = toBox(v.rect, W, H);
    const button = v.field.kind === 'checkbox' || v.field.kind === 'radio';
    const sx = button ? hitSlopFor(b.w, FIELD_SLOP) : FIELD_SLOP;
    const sy = button ? hitSlopFor(b.h, FIELD_SLOP) : Math.min(12, hitSlopFor(b.h, FIELD_SLOP));
    const n = near(b, x, y, sx, sy);
    if (!n.hit) continue;
    const c = { v, inside: n.inside, dist: n.dist, area: b.w * b.h };
    if (
      !best ||
      (c.inside && !best.inside) ||
      (c.inside === best.inside && (c.inside ? c.area < best.area : c.dist < best.dist))
    ) {
      best = c;
    }
  }
  return best?.v ?? null;
}

export function FillPage({
  uri,
  fit,
  viewport,
  margin,
  view,
  onViewChange,
  pageWidth,
  fields,
  fieldsEnabled,
  edits,
  activeFieldId,
  marks,
  selectedId,
  armed,
  onTapPage,
  onTapOutside,
  onFieldPress,
  onSelect,
  onMarkChange,
  onMeasure,
  onInteracting,
  overlay,
}: Props) {
  const { colors } = useTheme();
  const W = fit.w * view.z;
  const H = fit.h * view.z;
  const scale = pageWidth > 0 ? W / pageWidth : 1;
  /** Bigger than the viewport (it can be moved around). */
  const zoomed = W + margin.w * 2 > viewport.w + 0.5 || H + margin.h * 2 > viewport.h + 0.5;
  const [pinch, setPinch] = useState<Box | null>(null);
  /** The page's transform while a zoom or pan gesture (or its animation) runs. */
  const [live, setLive] = useState<{ tx: number; ty: number; s: number } | null>(null);

  // Counts gestures in progress, so the screen can hold still while any is.
  const count = useRef(0);
  const cb = useRef(onInteracting);
  useEffect(() => {
    cb.current = onInteracting;
  });
  const interacting = useMemo<Interacting>(() => ({
    begin() {
      count.current += 1;
      if (count.current === 1) cb.current?.(true);
    },
    end() {
      if (count.current === 0) return;
      count.current -= 1;
      if (count.current === 0) cb.current?.(false);
    },
  }), []);
  useEffect(() => () => {
    while (count.current > 0) interacting.end();
  }, [interacting]);

  const latest = useRef({ W, H, view, fit, viewport, margin, marks, fields, selectedId, fieldsEnabled, armed, onTapPage, onTapOutside, onFieldPress, onSelect, onMarkChange, onViewChange });
  useEffect(() => {
    latest.current = { W, H, view, fit, viewport, margin, marks, fields, selectedId, fieldsEnabled, armed, onTapPage, onTapOutside, onFieldPress, onSelect, onMarkChange, onViewChange };
  });

  const anim = useRef<number | null>(null);
  useEffect(() => () => {
    if (anim.current != null) cancelAnimationFrame(anim.current);
  }, []);

  const gestures = useMemo(() => {
    const g = {
      mode: null as 'mark' | 'zoom' | null,
      from: null as Box | null,
      current: null as Box | null,
      mark: null as FillMark | null,
      // Page zoom: the focal point where it began and the scale and travel now.
      focal: { x: 0, y: 0 },
      s: 1,
      d: { x: 0, y: 0 },
      pinchAt: 0,
      // One-finger pan of a zoomed page.
      panning: false,
      panBase: { x: 0, y: 0 },
      rebase: false,
    };
    const stopAnim = () => {
      if (anim.current != null) cancelAnimationFrame(anim.current);
      anim.current = null;
    };
    /**
     * Eases the page from its transform now (`from`, relative to the laid-out
     * view) to view `to`, then lays it out there.
     */
    const animateTo = (to: PageView, from = { tx: 0, ty: 0, s: 1 }) => {
      stopAnim();
      const { view: v, fit: f } = latest.current;
      const w = f.w * v.z;
      const h = f.h * v.z;
      const se = to.z / v.z;
      // RN scales about the view's centre: this transform puts the page at `to`.
      const end = { tx: to.x - v.x + ((se - 1) * w) / 2, ty: to.y - v.y + ((se - 1) * h) / 2, s: se };
      const t0 = Date.now();
      const step = () => {
        const t = Math.min(1, (Date.now() - t0) / 220);
        if (t >= 1) {
          anim.current = null;
          setLive(null);
          latest.current.onViewChange(to);
          return;
        }
        const e = 1 - Math.pow(1 - t, 3);
        setLive({ tx: from.tx + (end.tx - from.tx) * e, ty: from.ty + (end.ty - from.ty) * e, s: from.s + (end.s - from.s) * e });
        anim.current = requestAnimationFrame(step);
      };
      step();
    };
    /** The fingers lifted after zooming: settle within 1–4× and inside the edges. */
    const commitZoom = () => {
      const { view: v, fit: f, viewport: vp, margin: m } = latest.current;
      const now = liveTransform(v, { w: f.w * v.z, h: f.h * v.z }, g.s, g.focal.x, g.focal.y, g.d.x, g.d.y);
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z * g.s));
      const next = clampView(zoomViewAbout(v, z / v.z, g.focal.x, g.focal.y, g.d.x, g.d.y), f, vp, m);
      g.s = 1;
      g.d = { x: 0, y: 0 };
      // Back to (about) its fitted size: fitted exactly.
      animateTo(next.z < 1.04 ? fittedView(f, vp) : next, now);
    };

    // A tap: an addition, then a field, then the page (or beside it).
    const tap = Gesture.Tap()
      .runOnJS(true)
      .maxDuration(400)
      .maxDistance(10)
      .onEnd((e, success) => {
        if (!success || e.numberOfPointers > 1 || Date.now() - g.pinchAt < 350) return;
        const { W: w, H: h, view: v, marks: ms, fields: fs, selectedId: sel, fieldsEnabled: fe } = latest.current;
        const x = e.x - v.x;
        const y = e.y - v.y;
        if (x < 0 || y < 0 || x > w || y > h) {
          latest.current.onTapOutside();
          return;
        }
        // An addition (even with a tool armed: tapping one picks it instead).
        const hit = markAt(ms, sel, x, y, w, h);
        if (hit) {
          latest.current.onSelect(hit.id);
          return;
        }
        // …then a field…
        if (fe) {
          const f = fieldAt(fs, x, y, w, h);
          if (f) {
            latest.current.onFieldPress(f.field, { x: x / w, y: y / h });
            return;
          }
        }
        // …else the page.
        latest.current.onTapPage(x / w, y / h);
      });

    // Double tap on the page (not on a field or an addition): zoom in there, or back out.
    const doubleTap = Gesture.Tap()
      .runOnJS(true)
      .numberOfTaps(2)
      .maxDistance(24)
      .onEnd((e, success) => {
        if (!success) return;
        const { W: w, H: h, view: v, fit: f, viewport: vp, margin: m, marks: ms, fields: fs, selectedId: sel, fieldsEnabled: fe, armed: arm } = latest.current;
        if (arm) return;
        const x = e.x - v.x;
        const y = e.y - v.y;
        const onPage = x >= 0 && y >= 0 && x <= w && y <= h;
        if (onPage && (markAt(ms, sel, x, y, w, h) || (fe && fieldAt(fs, x, y, w, h)))) return;
        if (v.z > 1.05) {
          animateTo(fittedView(f, vp));
        } else if (onPage) {
          animateTo(clampView(zoomViewAbout(v, DOUBLE_TAP_ZOOM / v.z, e.x, e.y), f, vp, m));
        }
        selection();
      });

    const pinchG = Gesture.Pinch()
      .runOnJS(true)
      .onStart(e => {
        stopAnim();
        g.pinchAt = Date.now();
        const { marks: ms, selectedId: sel, W: w, H: h, view: v } = latest.current;
        const m = ms.find(x => x.id === sel) ?? null;
        const b = m ? toBox(m, w, h) : null;
        // On the selected addition: resize it. Anywhere else: zoom the page.
        if (m && b && near(b, e.focalX - v.x, e.focalY - v.y, PINCH_MARK_SLOP, PINCH_MARK_SLOP).hit) {
          g.mode = 'mark';
          g.mark = m;
          g.from = b;
        } else {
          g.mode = 'zoom';
          g.focal = { x: e.focalX, y: e.focalY };
          g.s = 1;
          g.d = { x: 0, y: 0 };
        }
        interacting.begin();
      })
      .onUpdate(e => {
        g.pinchAt = Date.now();
        if (g.mode === 'mark' && g.from && g.mark) {
          const { W: w, H: h } = latest.current;
          const min = isTextKind(g.mark.kind) ? g.from.w * (MIN_FONT / (g.mark.fontSize ?? 12)) : isInkKind(g.mark.kind) ? MIN_SIGNATURE_POINTS : MIN_MARK_POINTS;
          g.current = scaleBox(g.from, e.scale, { width: w, height: h }, min);
          setPinch(g.current);
        } else if (g.mode === 'zoom') {
          const { view: v, fit: f } = latest.current;
          // A little give past either end, settled when the fingers lift.
          g.s = Math.min((MAX_ZOOM * 1.15) / v.z, Math.max((MIN_ZOOM * 0.85) / v.z, e.scale));
          g.d = { x: e.focalX - g.focal.x, y: e.focalY - g.focal.y };
          setLive(liveTransform(v, { w: f.w * v.z, h: f.h * v.z }, g.s, g.focal.x, g.focal.y, g.d.x, g.d.y));
        }
      })
      .onFinalize(() => {
        const mode = g.mode;
        g.mode = null;
        if (mode === null) return;
        g.pinchAt = Date.now();
        g.rebase = true;
        interacting.end();
        if (mode === 'zoom') {
          commitZoom();
          return;
        }
        const { W: w, H: h } = latest.current;
        const m = g.mark;
        const b = g.current;
        const from = g.from;
        g.mark = null;
        g.from = null;
        g.current = null;
        setPinch(null);
        if (!m || !b || !from) return;
        const next: FillMark = { ...m, x: b.x / w, y: b.y / h, w: b.w / w, h: b.h / h };
        if (isTextKind(m.kind) && from.w > 0) {
          next.fontSize = Math.round(Math.min(MAX_FONT, Math.max(MIN_FONT, (m.fontSize ?? 12) * (b.w / from.w))) * 2) / 2;
        }
        selection();
        latest.current.onMarkChange(next);
      });

    // One finger moves a zoomed page. Starting on an addition drags that
    // instead: its own pan begins sooner (2 pt), and UIKit then lets only it run.
    const pan = Gesture.Pan()
      .runOnJS(true)
      .enabled(zoomed)
      .minDistance(8)
      .maxPointers(2)
      .onStart(e => {
        stopAnim();
        g.panning = true;
        g.panBase = { x: e.translationX, y: e.translationY };
        g.rebase = false;
        interacting.begin();
      })
      .onUpdate(e => {
        if (g.mode === 'zoom') return; // the pinch moves the page meanwhile
        if (g.rebase) {
          g.rebase = false;
          g.panBase = { x: e.translationX, y: e.translationY };
        }
        const { view: v, fit: f, viewport: vp, margin: m } = latest.current;
        // Moved, held inside the edges.
        const to = clampView({ z: v.z, x: v.x + e.translationX - g.panBase.x, y: v.y + e.translationY - g.panBase.y }, f, vp, m);
        setLive({ tx: to.x - v.x, ty: to.y - v.y, s: 1 });
      })
      .onEnd(e => {
        if (!g.panning || g.mode === 'zoom') return;
        const { view: v, fit: f, viewport: vp, margin: m } = latest.current;
        const at = clampView({ z: v.z, x: v.x + e.translationX - g.panBase.x, y: v.y + e.translationY - g.panBase.y }, f, vp, m);
        // Glides on a little, like a scroll view.
        const glide = clampView({ z: v.z, x: at.x + e.velocityX * 0.12, y: at.y + e.velocityY * 0.12 }, f, vp, m);
        animateTo(glide, { tx: at.x - v.x, ty: at.y - v.y, s: 1 });
      })
      .onFinalize(() => {
        if (!g.panning) return;
        g.panning = false;
        interacting.end();
      });

    return Gesture.Race(Gesture.Simultaneous(pinchG, pan), Gesture.Simultaneous(tap, doubleTap));
  }, [interacting, zoomed]);

  const active = fields.find(f => f.field.id === activeFieldId)?.field.id ?? null;
  const transform = live ? [{ translateX: live.tx }, { translateY: live.ty }, { scale: live.s }] : undefined;

  return (
    <GestureDetector gesture={gestures}>
      <View style={[styles.viewport, { width: viewport.w, height: viewport.h }]} collapsable={false}>
        <View
          style={[
            styles.frame,
            { left: view.x, top: view.y, width: W, height: H, shadowColor: colors.shadow },
            transform ? { transform } : null,
          ]}
        >
          <PagePicture uri={uri} width={W} height={H} />
          <View style={StyleSheet.absoluteFill}>
            {fields.map(v => (
              <FieldBox
                key={v.field.id}
                view={v}
                W={W}
                H={H}
                scale={scale}
                edits={edits}
                active={v.field.id === active}
                enabled={fieldsEnabled}
                onPress={onFieldPress}
              />
            ))}
            {marks.map(m => (
              <MarkView
                key={m.id}
                mark={m}
                W={W}
                H={H}
                scale={scale}
                selected={m.id === selectedId}
                onSelect={onSelect}
                onChange={onMarkChange}
                onMeasure={onMeasure}
                interacting={interacting}
                pinchBox={m.id === selectedId ? pinch : null}
              />
            ))}
          </View>
          {overlay}
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  viewport: { overflow: 'hidden' },
  frame: {
    position: 'absolute',
    overflow: 'visible',
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  field: { position: 'absolute', borderWidth: 1, borderColor: 'transparent', overflow: 'hidden' },
  fieldActive: { borderWidth: 2 },
  fieldText: { fontFamily: 'Helvetica', includeFontPadding: false },
  radioDot: {},
  choiceChevron: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center' },
  textStrip: { position: 'absolute', width: 4000, flexDirection: 'row', alignItems: 'flex-start' },
  markText: { fontFamily: 'Helvetica', includeFontPadding: false },
  markBody: { position: 'absolute' },
  outline: { ...StyleSheet.absoluteFillObject, borderWidth: 1.5 },
  target: { position: 'absolute', width: TARGET, height: TARGET },
  dot: {
    position: 'absolute',
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    borderWidth: 2,
    shadowOpacity: 0.25,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
});

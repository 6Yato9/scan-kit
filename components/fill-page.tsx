// components/fill-page.tsx
// One page of Fill & sign (app/pdf-fill.tsx): the page as rendered by PDFKit,
// its form fields as tappable boxes showing their values, and what the user
// added (text, date, check marks, crosses, signatures, initials) on top.
//
// Additions are handled the way Sign places a signature
// (components/placement-frame.tsx, lib/placement.ts): drag one to move it,
// drag a corner of the selected one or pinch anywhere on the page to resize it
// (text changes its font size), tap to select. A tap anywhere else goes to the
// screen (place the armed tool there, or deselect), a tap on a field fills it.
//
// What is drawn here is what native draws into the PDF (PdfFiller.swift): the
// same Helvetica text from the top-left of its box, the same check-mark and
// cross strokes (as fractions of the box, with round caps), the signature
// tinted to its ink. Positions are fractions of the page as shown.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { selection } from '@/lib/haptics';
import { HANDLES, handleTargetOffset, moveBox, resizeBox, scaleBox, type Box, type Handle } from '@/lib/placement';
import { Highlight } from '@/lib/theme';
import { SIGNATURE_INK } from '@/lib/stamp';
import { fieldValue, isFillable, isInkKind, isTextKind, markText, type DisplayRect, type FieldEdits, type FillMark } from '@/lib/pdf-fill';
import type { NativeFillField } from '@/modules/vision-ocr/src';

const DOT = 12;
const TARGET = 44;
const BODY_SLOP = 8;
const FIELD_SLOP = 4;
/** Font sizes text can be resized between, in PDF points. */
export const MIN_FONT = 6;
export const MAX_FONT = 72;
/** Smallest a check mark, cross or signature can be made, in preview points. */
const MIN_MARK_POINTS = 10;
const MIN_SIGNATURE_POINTS = 28;

export type FieldView = { field: NativeFillField; rect: DisplayRect };

type Props = {
  uri: string | null;
  /** The page's size on screen (points); its aspect is the page's as shown. */
  width: number;
  height: number;
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
  onTapPage: (x: number, y: number) => void;
  onFieldPress: (f: NativeFillField) => void;
  onSelect: (id: string | null) => void;
  /** A mark moved or was resized (when the finger lifts). */
  onMarkChange: (m: FillMark) => void;
  /** A text mark's measured size changed (fractions of the page). */
  onMeasure: (id: string, w: number, h: number) => void;
  onInteracting?: (active: boolean) => void;
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

/** A field's box on the page, with its value. */
const FieldBox = memo(function FieldBox({
  view,
  W,
  H,
  scale,
  edits,
  active,
  enabled,
}: {
  view: FieldView;
  W: number;
  H: number;
  scale: number;
  edits: FieldEdits;
  active: boolean;
  enabled: boolean;
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
  return (
    <View
      pointerEvents="none"
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
        <View style={[styles.choiceChevron, { right: 1 }]}>
          <Ionicons name="chevron-down" size={Math.max(8, Math.min(14, box.h * 0.6))} color={colors.accentFill} />
        </View>
      ) : null}
    </View>
  );
});

/** One addition: drawn, draggable, and with corner handles while selected. */
function MarkView({
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
  interacting: { begin: () => void; end: () => void };
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
  const latest = useRef({ mark, W, H, onChange, onSelect, committed });
  latest.current = { mark, W, H, onChange, onSelect, committed };

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
      .hitSlop(BODY_SLOP)
      .onBegin(() => interacting.begin())
      .onStart(() => {
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
        interacting.end();
        if (g.from) commit();
      });
    const corners = {} as Record<Handle, ReturnType<typeof Gesture.Pan>>;
    for (const hd of HANDLES) {
      corners[hd] = Gesture.Pan()
        .runOnJS(true)
        .minDistance(0)
        .onBegin(() => interacting.begin())
        .onStart(() => {
          g.from = latest.current.committed;
        })
        .onUpdate(e => {
          if (!g.from) return;
          g.current = resizeBox(g.from, hd, e.translationX, e.translationY, bounds(), minW(g.from));
          setLive(g.current);
        })
        .onEnd(commit)
        .onFinalize(() => {
          interacting.end();
          if (g.from) commit();
        });
    }
    return { body, corners };
  }, [interacting]);

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
          accessibilityHint="Drag to move it. Drag a corner or pinch to resize it."
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
}

export function FillPage({
  uri,
  width: W,
  height: H,
  pageWidth,
  fields,
  fieldsEnabled,
  edits,
  activeFieldId,
  marks,
  selectedId,
  armed,
  onTapPage,
  onFieldPress,
  onSelect,
  onMarkChange,
  onMeasure,
  onInteracting,
}: Props) {
  const { colors } = useTheme();
  const scale = pageWidth > 0 ? W / pageWidth : 1;
  const [pinch, setPinch] = useState<Box | null>(null);

  // Counts gestures in progress, so the screen can hold still while any is.
  const count = useRef(0);
  const cb = useRef(onInteracting);
  cb.current = onInteracting;
  const interacting = useMemo(() => ({
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

  const latest = useRef({ W, H, marks, fields, selectedId, fieldsEnabled, armed, onTapPage, onFieldPress, onSelect, onMarkChange });
  latest.current = { W, H, marks, fields, selectedId, fieldsEnabled, armed, onTapPage, onFieldPress, onSelect, onMarkChange };

  const page = useMemo(() => {
    const g = { from: null as Box | null, current: null as Box | null, mark: null as FillMark | null };
    const tap = Gesture.Tap()
      .runOnJS(true)
      .maxDuration(400)
      .onEnd((e, success) => {
        if (!success) return;
        const { W: w, H: h, marks: ms, fields: fs, selectedId: sel, fieldsEnabled: fe, armed: arm } = latest.current;
        const inside = (b: Box, slop: number) => e.x >= b.x - slop && e.x <= b.x + b.w + slop && e.y >= b.y - slop && e.y <= b.y + b.h + slop;
        // An addition (the selected one first, then the top-most)…
        if (!arm) {
          const order = [...ms].reverse().sort((a, b) => (a.id === sel ? -1 : b.id === sel ? 1 : 0));
          const hit = order.find(m => inside(toBox(m, w, h), BODY_SLOP));
          if (hit) {
            latest.current.onSelect(hit.id);
            return;
          }
        }
        // …then a field (the smallest that was hit: a checkbox inside a table cell)…
        if (fe) {
          const hits = fs.filter(f => isFillable(f.field) || f.field.kind === 'signature').filter(f => inside(toBox(f.rect, w, h), FIELD_SLOP));
          hits.sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h);
          if (hits[0] && !(arm && hits[0].field.kind === 'signature')) {
            latest.current.onFieldPress(hits[0].field);
            return;
          }
        }
        // …else the page.
        latest.current.onTapPage(e.x / w, e.y / h);
      });
    const pinchG = Gesture.Pinch()
      .runOnJS(true)
      .onStart(() => {
        const { marks: ms, selectedId: sel, W: w, H: h } = latest.current;
        const m = ms.find(x => x.id === sel) ?? null;
        g.mark = m;
        g.from = m ? toBox(m, w, h) : null;
        if (m) interacting.begin();
      })
      .onUpdate(e => {
        if (!g.from || !g.mark) return;
        const { W: w, H: h } = latest.current;
        const min = isTextKind(g.mark.kind) ? g.from.w * (MIN_FONT / (g.mark.fontSize ?? 12)) : isInkKind(g.mark.kind) ? MIN_SIGNATURE_POINTS : MIN_MARK_POINTS;
        g.current = scaleBox(g.from, e.scale, { width: w, height: h }, min);
        setPinch(g.current);
      })
      .onFinalize(() => {
        const { W: w, H: h } = latest.current;
        const m = g.mark;
        const b = g.current;
        const from = g.from;
        g.mark = null;
        g.from = null;
        g.current = null;
        setPinch(null);
        if (!m) return;
        interacting.end();
        if (!b || !from) return;
        const next: FillMark = { ...m, x: b.x / w, y: b.y / h, w: b.w / w, h: b.h / h };
        if (isTextKind(m.kind) && from.w > 0) {
          next.fontSize = Math.round(Math.min(MAX_FONT, Math.max(MIN_FONT, (m.fontSize ?? 12) * (b.w / from.w))) * 2) / 2;
        }
        selection();
        latest.current.onMarkChange(next);
      });
    return Gesture.Simultaneous(pinchG, tap);
  }, [interacting]);

  const active = fields.find(f => f.field.id === activeFieldId)?.field.id ?? null;

  return (
    <View style={[styles.frame, { width: W, height: H, shadowColor: colors.shadow }]}>
      {uri ? <Image source={{ uri }} style={{ width: W, height: H }} resizeMode="stretch" /> : <View style={{ width: W, height: H, backgroundColor: colors.placeholder }} />}
      <GestureDetector gesture={page}>
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          {fields.map(v => (
            <FieldBox key={v.field.id} view={v} W={W} H={H} scale={scale} edits={edits} active={v.field.id === active} enabled={fieldsEnabled} />
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
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
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

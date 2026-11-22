// components/redact-editor.tsx
// The page in Redact (app/tools/redact.tsx), with its black boxes:
// - drag on the page to draw a box;
// - tap a box to select it; drag a selected (or any) box to move it; drag a
//   selected box's corner to resize it, to any shape;
// - the selected box has a remove button just above it.
// Boxes show slightly see-through, so the user can check what they cover;
// they are burned in solid black — or, from round 16, in the colour chosen in
// Redact's style sheet (`fill`), with "REDACTED" across them when asked
// (`label`, sized exactly as lib/stamp.ts burns it).
//
// One pan gesture covers the whole page and decides at touch-down what the
// drag does (resize a corner, move a box, or draw a new one), so there are no
// competing recognisers; the box maths is lib/redact.ts (unit-tested). The
// screen around it doesn't scroll, so a drag on the page is always a drag.
//
// Two fingers zoom (up to MAX_ZOOM) and move the zoomed page, so a box can be
// drawn exactly round a line of small print. Boxes are kept in page points
// (the page at its fitted size); only what is drawn is scaled.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/contexts/theme-context';
import { Ink, Radius, Spacing } from '@/lib/theme';
import { selection, tapLight } from '@/lib/haptics';
import { HANDLES, moveBox, type Box, type Handle } from '@/lib/placement';
import { redactLabelSize } from '@/lib/stamp';
import { isLight } from '@/lib/stamp-colors';
import {
  MIN_REDACT_POINTS,
  boxAt,
  boxFromPoints,
  cornerAt,
  newBoxId,
  resizeFreeBox,
  toFractions,
  toPoints,
  type RedactBox,
} from '@/lib/redact';

/** Reach of a corner handle around its dot, in points. */
const HANDLE_REACH = 22;
const DOT = 14;
/** Extra reach around a box's body for grabbing it. */
const BODY_SLOP = 6;
/** The remove button: its visible circle and its touch target. */
const REMOVE = 26;
const REMOVE_HIT = 44;
/** How see-through boxes are on the preview (burned in fully opaque). */
const BOX_OPACITY = 0.78;
const MAX_ZOOM = 4;

/** The zoomed page: scale k, the page's top-left at (x, y) in the frame. */
type View2 = { k: number; x: number; y: number };
const FIT: View2 = { k: 1, x: 0, y: 0 };

/** Keeps the zoomed page covering the frame (never pulled inside it). */
function clampView(v: View2, width: number, height: number): View2 {
  const k = Math.min(MAX_ZOOM, Math.max(1, v.k));
  if (k <= 1.0001) return FIT;
  return {
    k,
    x: Math.min(0, Math.max(width - width * k, v.x)),
    y: Math.min(0, Math.max(height - height * k, v.y)),
  };
}

type Mode =
  | { kind: 'none' }
  | { kind: 'draw'; x: number; y: number }
  | { kind: 'move'; id: string; from: Box }
  | { kind: 'resize'; id: string; handle: Handle; from: Box };

export function RedactEditor({
  uri,
  width,
  height,
  boxes,
  selectedId,
  onSelect,
  onChange,
  fill = Ink.black,
  label = null,
}: {
  /** The page image (file URI). */
  uri: string;
  /** Size the page is shown at, in points (its aspect is the page's). */
  width: number;
  height: number;
  boxes: RedactBox[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** The page's boxes after a draw, move, resize or removal. */
  onChange: (boxes: RedactBox[]) => void;
  /** The colour the boxes will be burned in (default black). */
  fill?: string;
  /** The word printed across each box, and its colour; null for none. */
  label?: { text: string; color: string } | null;
}) {
  const { colors } = useTheme();
  const bounds = useMemo(() => ({ width, height }), [width, height]);
  // While a finger is down, the box being changed lives here (points).
  const [live, setLive] = useState<{ id: string; box: Box } | null>(null);
  const [view, setView] = useState<View2>(FIT);
  const latest = useRef({ boxes, selectedId, bounds, onChange, onSelect, view });
  latest.current = { boxes, selectedId, bounds, onChange, onSelect, view };

  // A page switch or a resize mid-gesture: drop the half-made box, and the zoom.
  useEffect(() => {
    setLive(null);
    setView(FIT);
  }, [uri, width, height]);

  const gesture = useMemo(() => {
    // Shared between the gesture callbacks by reference (see placement-frame).
    const g: {
      mode: Mode;
      moved: boolean;
      box: Box | null;
      /** A second finger came down during this drag: it was a zoom, not a box. */
      pinched: boolean;
      pinch: { from: View2; fx: number; fy: number } | null;
    } = { mode: { kind: 'none' }, moved: false, box: null, pinched: false, pinch: null };
    /** A point in the frame -> page points. */
    const toPage = (fx: number, fy: number) => {
      const v = latest.current.view;
      return { x: (fx - v.x) / v.k, y: (fy - v.y) / v.k };
    };
    const show = (id: string, box: Box) => {
      g.box = box;
      setLive({ id, box });
    };
    const points = () => latest.current.boxes.map(b => toPoints(b, latest.current.bounds));

    const pan = Gesture.Pan()
      .runOnJS(true)
      .minDistance(3)
      .onBegin(e => {
        const { boxes: bs, selectedId: sel, view: v } = latest.current;
        const pts = points();
        const p = toPage(e.x, e.y);
        g.moved = false;
        g.box = null;
        g.pinched = false;
        // A corner of the selected box first, then any box, else a new one.
        // Reaches are in screen points, so they shrink on the page as it zooms.
        const si = sel ? bs.findIndex(b => b.id === sel) : -1;
        if (si >= 0) {
          const h = cornerAt(pts[si], p.x, p.y, HANDLE_REACH / v.k);
          if (h) {
            g.mode = { kind: 'resize', id: bs[si].id, handle: h, from: pts[si] };
            return;
          }
        }
        const hit = boxAt(pts, p.x, p.y, BODY_SLOP / v.k);
        g.mode = hit >= 0 ? { kind: 'move', id: bs[hit].id, from: pts[hit] } : { kind: 'draw', x: p.x, y: p.y };
      })
      .onUpdate(e => {
        if (g.pinched) return;
        const m = g.mode;
        const bd = latest.current.bounds;
        const k = latest.current.view.k;
        const dx = e.translationX / k;
        const dy = e.translationY / k;
        g.moved = true;
        if (m.kind === 'draw') {
          show('new', boxFromPoints(m.x, m.y, m.x + dx, m.y + dy, bd));
        } else if (m.kind === 'move') {
          show(m.id, moveBox(m.from, dx, dy, bd));
        } else if (m.kind === 'resize') {
          show(m.id, resizeFreeBox(m.from, m.handle, dx, dy, bd));
        }
      })
      .onFinalize(() => {
        const m = g.mode;
        const box = g.box;
        g.mode = { kind: 'none' };
        g.box = null;
        setLive(null);
        if (g.pinched || !g.moved || !box) return;
        const { boxes: bs, bounds: bd, onChange: change, onSelect: select } = latest.current;
        if (m.kind === 'draw') {
          // A short stroke is a slip, not a box.
          if (box.w < MIN_REDACT_POINTS || box.h < MIN_REDACT_POINTS * 0.6) return;
          const id = newBoxId();
          change([...bs, { ...toFractions(box, bd), id, source: 'drawn' }]);
          select(id);
          tapLight();
        } else if (m.kind === 'move' || m.kind === 'resize') {
          change(bs.map(b => (b.id === m.id ? { ...b, ...toFractions(box, bd) } : b)));
          select(m.id);
        }
      });

    const tap = Gesture.Tap()
      .runOnJS(true)
      .onEnd((e, success) => {
        if (!success) return;
        const p = toPage(e.x, e.y);
        const hit = boxAt(points(), p.x, p.y, BODY_SLOP / latest.current.view.k);
        const { boxes: bs, selectedId: sel, onSelect: select } = latest.current;
        const id = hit >= 0 ? bs[hit].id : null;
        if (id !== sel) {
          select(id);
          if (id) selection();
        }
      });

    // Two fingers: zoom around them, and move the zoomed page as they move.
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onStart(e => {
        g.pinched = true;
        g.box = null;
        setLive(null);
        g.pinch = { from: latest.current.view, fx: e.focalX, fy: e.focalY };
      })
      .onUpdate(e => {
        const start = g.pinch;
        if (!start) return;
        const { width: w, height: h } = latest.current.bounds;
        const k = Math.min(MAX_ZOOM, Math.max(1, start.from.k * e.scale));
        const px = (start.fx - start.from.x) / start.from.k;
        const py = (start.fy - start.from.y) / start.from.k;
        setView(clampView({ k, x: e.focalX - px * k, y: e.focalY - py * k }, w, h));
      })
      .onFinalize(() => {
        g.pinch = null;
      });

    return Gesture.Simultaneous(pinch, Gesture.Race(pan, tap));
  }, [latest]);

  /** A box in page points -> where it is drawn in the (zoomed) frame. */
  const onScreen = (b: Box): Box => ({ x: b.x * view.k + view.x, y: b.y * view.k + view.y, w: b.w * view.k, h: b.h * view.k });

  const shown = boxes.map(b => ({
    id: b.id,
    source: b.source,
    box: onScreen(live && live.id === b.id ? live.box : toPoints(b, bounds)),
  }));
  const drawing = live && live.id === 'new' ? onScreen(live.box) : null;
  const sel = shown.find(b => b.id === selectedId) ?? null;

  const remove = (id: string) => {
    onChange(boxes.filter(b => b.id !== id));
    onSelect(null);
    tapLight();
  };

  // VoiceOver: each box is an element with Remove and move / size actions.
  const onA11y = (id: string) => (e: AccessibilityActionEvent) => {
    const b = boxes.find(x => x.id === id);
    if (!b) return;
    const p = toPoints(b, bounds);
    const sx = width * 0.03;
    const sy = height * 0.03;
    let next: Box | null = null;
    switch (e.nativeEvent.actionName) {
      case 'remove': remove(id); return;
      case 'activate': onSelect(id); return;
      case 'moveLeft': next = moveBox(p, -sx, 0, bounds); break;
      case 'moveRight': next = moveBox(p, sx, 0, bounds); break;
      case 'moveUp': next = moveBox(p, 0, -sy, bounds); break;
      case 'moveDown': next = moveBox(p, 0, sy, bounds); break;
      case 'increment': next = resizeFreeBox(p, 'br', sx, sy, bounds); break;
      case 'decrement': next = resizeFreeBox(p, 'br', -sx, -sy, bounds); break;
    }
    if (next) onChange(boxes.map(x => (x.id === id ? { ...x, ...toFractions(next!, bounds) } : x)));
  };

  // The remove button sits centred just above the selected box, clear of its
  // corner handles (below it when the box is at the top of the page), kept on
  // the page.
  const removeAt = sel
    ? {
        left: Math.min(Math.max(0, sel.box.x + sel.box.w / 2 - REMOVE_HIT / 2), width - REMOVE_HIT),
        top:
          sel.box.y >= REMOVE_HIT + 2
            ? sel.box.y - REMOVE_HIT - 2
            : Math.min(sel.box.y + sel.box.h + 2, height - REMOVE_HIT),
      }
    : null;

  return (
    <View style={[styles.frame, { backgroundColor: colors.input }]}>
      <View style={[styles.clip, { width, height }]}>
        <Image
          source={{ uri }}
          style={{ position: 'absolute', left: view.x, top: view.y, width: width * view.k, height: height * view.k }}
          resizeMode="stretch"
          accessibilityIgnoresInvertColors
        />
        <View style={[StyleSheet.absoluteFill, styles.edge, { borderColor: colors.thumbBorder }]} pointerEvents="none" />
        <GestureDetector gesture={gesture}>
          <View
            style={StyleSheet.absoluteFill}
            collapsable={false}
            accessible={boxes.length === 0}
            accessibilityLabel={boxes.length === 0 ? 'Page' : undefined}
            accessibilityHint={boxes.length === 0 ? 'Drag on the page to draw a box to redact.' : undefined}
          >
            {shown.map(({ id, source, box }, i) => {
              const on = id === selectedId;
              return (
                <View
                  key={id}
                  style={[styles.box, { left: box.x, top: box.y, width: box.w, height: box.h }]}
                  accessible
                  accessibilityRole="adjustable"
                  accessibilityLabel={`Redaction box ${i + 1}${source === 'drawn' ? '' : source === 'search' ? ', from search' : source === 'email' ? ', email address' : ', phone number'}`}
                  accessibilityState={{ selected: on }}
                  accessibilityActions={[
                    { name: 'activate', label: 'Select' },
                    { name: 'remove', label: 'Remove' },
                    { name: 'increment', label: 'Larger' },
                    { name: 'decrement', label: 'Smaller' },
                    { name: 'moveLeft', label: 'Move left' },
                    { name: 'moveRight', label: 'Move right' },
                    { name: 'moveUp', label: 'Move up' },
                    { name: 'moveDown', label: 'Move down' },
                  ]}
                  onAccessibilityAction={onA11y(id)}
                >
                  <View
                    style={[
                      StyleSheet.absoluteFill,
                      { backgroundColor: fill, opacity: BOX_OPACITY },
                      // A white box on white paper still shows where it is.
                      isLight(fill) ? [styles.lightEdge, { borderColor: colors.ring }] : null,
                    ]}
                  />
                  {label && redactLabelSize(box.w, box.h, 0.5) > 0 ? (
                    <View style={styles.labelWrap} pointerEvents="none">
                      <Text
                        style={[styles.label, { color: label.color, fontSize: redactLabelSize(box.w, box.h, 0.5) }]}
                        numberOfLines={1}
                        allowFontScaling={false}
                      >
                        {label.text}
                      </Text>
                    </View>
                  ) : null}
                  {on ? <View style={[StyleSheet.absoluteFill, styles.outline, { borderColor: colors.accentFill }]} /> : null}
                </View>
              );
            })}
            {drawing ? (
              <View
                pointerEvents="none"
                style={[
                  styles.box,
                  styles.outline,
                  { left: drawing.x, top: drawing.y, width: drawing.w, height: drawing.h, borderColor: colors.accentFill },
                ]}
              >
                <View style={[StyleSheet.absoluteFill, { backgroundColor: fill, opacity: BOX_OPACITY * 0.8 }]} />
              </View>
            ) : null}
            {sel && !live
              ? HANDLES.map(h => {
                  const cx = h === 'tl' || h === 'bl' ? sel.box.x : sel.box.x + sel.box.w;
                  const cy = h === 'tl' || h === 'tr' ? sel.box.y : sel.box.y + sel.box.h;
                  return (
                    <View
                      key={h}
                      pointerEvents="none"
                      style={[
                        styles.dot,
                        {
                          left: cx - DOT / 2,
                          top: cy - DOT / 2,
                          backgroundColor: colors.accentFill,
                          borderColor: colors.onAccent,
                          shadowColor: colors.shadow,
                        },
                      ]}
                    />
                  );
                })
              : null}
          </View>
        </GestureDetector>
        {/* A sibling of the gesture area, so a tap on it is only a tap on it. */}
        {sel && removeAt && !live ? (
          <Pressable
            onPress={() => remove(sel.id)}
            accessibilityRole="button"
            accessibilityLabel="Remove box"
            style={[styles.removeHit, removeAt]}
          >
            {({ pressed }) => (
              <View
                style={[
                  styles.remove,
                  { backgroundColor: colors.card, borderColor: colors.border, shadowColor: colors.shadow },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Ionicons name="trash-outline" size={15} color={colors.danger} />
              </View>
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { alignSelf: 'center', padding: Spacing.sm, borderRadius: Radius.md },
  edge: { borderWidth: StyleSheet.hairlineWidth },
  clip: { overflow: 'hidden' },
  box: { position: 'absolute' },
  outline: { borderWidth: 2 },
  lightEdge: { borderWidth: StyleSheet.hairlineWidth },
  labelWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  // Helvetica Bold, as the canvas draws it (lib/stamp.ts REDACT_LABEL_EM).
  label: { fontFamily: 'Helvetica', fontWeight: '700' },
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
  removeHit: { position: 'absolute', width: REMOVE_HIT, height: REMOVE_HIT, alignItems: 'center', justifyContent: 'center' },
  remove: {
    width: REMOVE,
    height: REMOVE,
    borderRadius: REMOVE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
});

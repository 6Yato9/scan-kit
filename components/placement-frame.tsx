// components/placement-frame.tsx
// Direct manipulation of a mark on a page preview, the way iOS Markup and
// CamScanner place a signature:
// - SignaturePlacer: the signature sits on the page in a selection frame with
//   four corner handles. Drag its body to move it, drag a corner to resize it
//   (the opposite corner stays put, the shape never changes), pinch anywhere on
//   the page to resize it around its centre, tap elsewhere on the page to move
//   it there. It never leaves the page.
// - LabelPlacer: a label (the timestamp) dragged anywhere on the page; it
//   settles on the edges and the middle when it comes close.
//
// The maths is lib/placement.ts (unit-tested); the result is page fractions,
// exactly what lib/stamp.ts draws into the page, so the preview is the page.
//
// Gestures run through react-native-gesture-handler on the JS thread (runOnJS):
// only this small view re-renders while a finger moves, and the screen gets
// one onChange at the end. While a gesture is in progress `onInteracting(true)`
// lets the screen lock its scroll view, so the drag moves the mark and not the
// page; a one-finger drag that starts on the page outside the mark still
// scrolls the screen.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Image, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useTheme } from '@/contexts/theme-context';
import { Radius, Spacing } from '@/lib/theme';
import { selection } from '@/lib/haptics';
import {
  HANDLES,
  boxToPlacement,
  centerBoxAt,
  maxBoxWidth,
  minBoxWidth,
  moveBox,
  placementToBox,
  resizeBox,
  scaleBox,
  handleTargetOffset,
  anchorToOrigin,
  originToAnchor,
  sameAnchor,
  type Anchor,
  type Box,
  type Handle,
} from '@/lib/placement';
import type { Placement } from '@/lib/stamp';

/** Corner handle: the dot that shows, and the touch target around it. */
// Small, so they sit at the corners of a small signature without hiding it;
// the white ring keeps them visible on ink and on paper.
const DOT = 12;
const TARGET = 44;
/** Extra reach around the signature's body for grabbing it. */
const BODY_SLOP = 10;
/** …and around a label, which is tiny at page scale. */
const LABEL_SLOP = 18;

/** The page image in the same frame PagePreview (components/tool-ui.tsx) draws. */
function PageFrame({ uri, width, height, children }: { uri: string; width: number; height: number; children?: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.frame, { backgroundColor: colors.input }]}>
      <View style={{ width, height }}>
        <Image source={{ uri }} style={{ width, height }} resizeMode="stretch" />
        <View style={[StyleSheet.absoluteFill, styles.edge, { borderColor: colors.thumbBorder }]} pointerEvents="none" />
        {children}
      </View>
    </View>
  );
}

/** Counts gestures in progress so the screen's scroll is locked while any is. */
function useInteracting(onInteracting?: (active: boolean) => void) {
  const count = useRef(0);
  const cb = useRef(onInteracting);
  cb.current = onInteracting;
  return useMemo(() => ({
    begin() {
      count.current += 1;
      if (count.current === 1) cb.current?.(true);
    },
    end() {
      if (count.current === 0) return;
      count.current -= 1;
      if (count.current === 0) cb.current?.(false);
    },
  }), [count, cb]);
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

const isSnap = (v: number) => v === 0 || v === 0.5 || v === 1;
/** Which edges / middles an anchor has settled on ("-" for none). */
const snapKey = (a: Anchor) => `${isSnap(a.x) ? a.x : '-'}|${isSnap(a.y) ? a.y : '-'}`;

export function SignaturePlacer({
  uri,
  width,
  height,
  signature,
  tint,
  placement,
  onChange,
  onInteracting,
}: {
  /** The page image (file URI). */
  uri: string;
  /** Size the page is shown at, in points (its aspect is the page's). */
  width: number;
  height: number;
  signature: { dataUri: string; width: number; height: number };
  /** Ink colour to show the strokes in (null: as drawn). */
  tint: string | null;
  placement: Placement;
  onChange: (p: Placement) => void;
  onInteracting?: (active: boolean) => void;
}) {
  const { colors } = useTheme();
  const bounds = useMemo(() => ({ width, height }), [width, height]);
  const ratio = signature.height / signature.width;
  const minW = minBoxWidth(bounds, ratio);
  const committed = placementToBox(placement, ratio, bounds);

  const [box, setBox] = useState<Box>(committed);
  const boxRef = useRef(box);
  const interacting = useInteracting(onInteracting);
  const active = useRef(0);
  // The parent's placement (after a commit, a page change, a new signature)
  // wins whenever no finger is down.
  const committedKey = `${committed.x}|${committed.y}|${committed.w}|${committed.h}`;
  useEffect(() => {
    if (active.current === 0) {
      boxRef.current = committed;
      setBox(committed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedKey]);

  const latest = useRef({ bounds, minW, onChange, ratio });
  latest.current = { bounds, minW, onChange, ratio };

  const gestures = useMemo(() => {
    const set = (b: Box) => {
      boxRef.current = b;
      setBox(b);
    };
    // Gesture state shared between callbacks. Kept as properties of one
    // object, never as reassigned `let`s: the worklets Babel plugin turns
    // every gesture callback into a worklet that gets its OWN copy of the
    // variables it closes over, so a `let` set in onStart reads as its
    // initial value in onUpdate. An object is shared by reference.
    const g = {
      atLimit: false,
      pinching: false,
      pinchLocked: false,
      pinchFrom: boxRef.current,
      // Where the body drag measures from; re-based after a pinch so the
      // signature doesn't jump when the second finger lifts.
      panFrom: { box: boxRef.current, tx: 0, ty: 0 },
      cornerFrom: boxRef.current,
    };
    // A light tick when the size stops at its smallest or largest.
    const tickAtLimit = (b: Box) => {
      const { bounds: bd, minW: mn, ratio: r } = latest.current;
      const limit = Math.abs(b.w - mn) < 0.5 || Math.abs(b.w - maxBoxWidth(bd, r)) < 0.5;
      if (limit && !g.atLimit) selection();
      g.atLimit = limit;
    };
    const start = () => {
      active.current += 1;
      interacting.begin();
    };
    const finish = () => {
      if (active.current === 0) return;
      active.current -= 1;
      interacting.end();
      if (active.current === 0) {
        g.atLimit = false;
        latest.current.onChange(boxToPlacement(boxRef.current, latest.current.bounds));
      }
    };


    const body = Gesture.Pan()
      .runOnJS(true)
      .minDistance(1)
      .hitSlop(BODY_SLOP)
      .onBegin(start)
      .onStart(() => {
        g.panFrom = { box: boxRef.current, tx: 0, ty: 0 };
      })
      .onUpdate(e => {
        if (g.pinching) {
          g.panFrom = { box: boxRef.current, tx: e.translationX, ty: e.translationY };
          return;
        }
        const from = g.panFrom;
        set(moveBox(from.box, e.translationX - from.tx, e.translationY - from.ty, latest.current.bounds));
      })
      .onFinalize(finish);

    const corners = {} as Record<Handle, ReturnType<typeof Gesture.Pan>>;
    for (const h of HANDLES) {
      corners[h] = Gesture.Pan()
        .runOnJS(true)
        .minDistance(0)
        .onBegin(start)
        .onStart(() => {
          g.cornerFrom = boxRef.current;
        })
        .onUpdate(e => {
          const b = resizeBox(g.cornerFrom, h, e.translationX, e.translationY, latest.current.bounds, latest.current.minW);
          tickAtLimit(b);
          set(b);
        })
        .onFinalize(finish);
    }

    // Pinch anywhere on the page. It only claims the scroll once a second
    // finger is down, so a one-finger drag on the page still scrolls.
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onTouchesDown(e => {
        if (e.numberOfTouches >= 2 && !g.pinchLocked) {
          g.pinchLocked = true;
          start();
        }
      })
      .onStart(() => {
        g.pinching = true;
        g.pinchFrom = boxRef.current;
      })
      .onUpdate(e => {
        const b = scaleBox(g.pinchFrom, e.scale, latest.current.bounds, latest.current.minW);
        tickAtLimit(b);
        set(b);
      })
      .onEnd(() => {
        g.pinching = false;
      })
      .onFinalize(() => {
        g.pinching = false;
        if (g.pinchLocked) {
          g.pinchLocked = false;
          finish();
        }
      });

    // Tap on the page, away from the signature: it moves there.
    const tap = Gesture.Tap()
      .runOnJS(true)
      .onEnd((e, success) => {
        if (!success) return;
        const b = boxRef.current;
        const inside =
          e.x >= b.x - BODY_SLOP && e.x <= b.x + b.w + BODY_SLOP && e.y >= b.y - BODY_SLOP && e.y <= b.y + b.h + BODY_SLOP;
        if (inside) return;
        const next = centerBoxAt(b, e.x, e.y, latest.current.bounds);
        set(next);
        selection();
        latest.current.onChange(boxToPlacement(next, latest.current.bounds));
      });

    const pieces = [body, ...HANDLES.map(h => corners[h])];
    pinch.simultaneousWithExternalGesture(...pieces);
    for (const p of pieces) p.simultaneousWithExternalGesture(pinch);
    return { body, corners, page: Gesture.Simultaneous(pinch, tap) };
  }, [interacting, boxRef, active, latest]);

  // A gesture cut short by unmounting (page switched mid-drag) unlocks the scroll.
  useEffect(() => () => {
    while (active.current > 0) {
      active.current -= 1;
      interacting.end();
    }
  }, [interacting]);

  // VoiceOver: swipe up / down to resize, actions to move.
  const onA11y = (e: AccessibilityActionEvent) => {
    const b = boxRef.current;
    const stepX = width * 0.05;
    const stepY = height * 0.05;
    let next: Box | null = null;
    switch (e.nativeEvent.actionName) {
      case 'increment': next = scaleBox(b, 1.15, bounds, minW); break;
      case 'decrement': next = scaleBox(b, 1 / 1.15, bounds, minW); break;
      case 'moveLeft': next = moveBox(b, -stepX, 0, bounds); break;
      case 'moveRight': next = moveBox(b, stepX, 0, bounds); break;
      case 'moveUp': next = moveBox(b, 0, -stepY, bounds); break;
      case 'moveDown': next = moveBox(b, 0, stepY, bounds); break;
    }
    if (!next) return;
    boxRef.current = next;
    setBox(next);
    onChange(boxToPlacement(next, bounds));
  };
  const place = boxToPlacement(box, bounds);

  return (
    <PageFrame uri={uri} width={width} height={height}>
      <GestureDetector gesture={gestures.page}>
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          <GestureDetector gesture={gestures.body}>
            <View
              collapsable={false}
              style={[styles.body, { left: box.x, top: box.y, width: box.w, height: box.h }]}
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel="Signature on the page"
              accessibilityHint="Drag to move it, drag a corner or pinch to resize it."
              accessibilityValue={{
                text: `${pct(place.w)} of the page wide, ${pct(place.x)} from the left, ${pct(place.y)} from the top`,
              }}
              accessibilityActions={[
                { name: 'increment', label: 'Larger' },
                { name: 'decrement', label: 'Smaller' },
                { name: 'moveLeft', label: 'Move left' },
                { name: 'moveRight', label: 'Move right' },
                { name: 'moveUp', label: 'Move up' },
                { name: 'moveDown', label: 'Move down' },
              ]}
              onAccessibilityAction={onA11y}
            >
              <Image
                // Remounted when the ink changes: iOS applies tintColor only
                // when the image loads, not when the style changes later.
                key={tint ?? 'as-drawn'}
                source={{ uri: signature.dataUri }}
                style={[styles.fill, tint ? { tintColor: tint } : null]}
                resizeMode="stretch"
              />
              <View style={[StyleSheet.absoluteFill, styles.outline, { borderColor: colors.accentFill }]} pointerEvents="none" />
            </View>
          </GestureDetector>
          {HANDLES.map(h => {
            const cx = h === 'tl' || h === 'bl' ? box.x : box.x + box.w;
            const cy = h === 'tl' || h === 'tr' ? box.y : box.y + box.h;
            const off = handleTargetOffset(h, box.w, box.h, TARGET);
            return (
              <GestureDetector key={h} gesture={gestures.corners[h]}>
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
          })}
        </View>
      </GestureDetector>
    </PageFrame>
  );
}

/**
 * A label (the timestamp) dragged anywhere on the page. `render` draws it at
 * the preview's scale; its size is measured, so the anchor (where it sits
 * between the inset edges) maps onto the page whatever the text. It settles
 * on the edges and the middle, with a tick.
 */
export function LabelPlacer({
  uri,
  width,
  height,
  inset,
  anchor,
  onChange,
  onInteracting,
  label,
  children,
}: {
  uri: string;
  width: number;
  height: number;
  /** Gap kept from the page edges, in preview points. */
  inset: number;
  anchor: Anchor;
  onChange: (a: Anchor) => void;
  onInteracting?: (active: boolean) => void;
  /** Spoken name of the label ("Date"). */
  label: string;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [live, setLive] = useState<Anchor | null>(null);
  const shown = live ?? anchor;
  const interacting = useInteracting(onInteracting);
  const latest = useRef({ width, height, inset, size, anchor, onChange });
  latest.current = { width, height, inset, size, anchor, onChange };

  const pan = useMemo(() => {
    // Shared between callbacks as one object: see SignaturePlacer.
    const g: { from: { x: number; y: number }; current: Anchor | null; began: boolean } = {
      from: { x: 0, y: 0 },
      current: null,
      began: false,
    };
    return Gesture.Pan()
      .runOnJS(true)
      .minDistance(1)
      // The label is small at page scale: reach well past it.
      .hitSlop(LABEL_SLOP)
      .onBegin(() => {
        g.began = true;
        interacting.begin();
      })
      .onStart(() => {
        const { width: w, height: h, inset: i, size: s, anchor: a } = latest.current;
        g.from = anchorToOrigin(a, w, h, s?.w ?? 0, s?.h ?? 0, i);
        g.current = a;
      })
      .onUpdate(e => {
        const { width: w, height: h, inset: i, size: s } = latest.current;
        const next = originToAnchor(g.from.x + e.translationX, g.from.y + e.translationY, w, h, s?.w ?? 0, s?.h ?? 0, i);
        // A tick each time it settles on an edge or the middle.
        const prev = g.current;
        if (prev && !sameAnchor(next, prev) && snapKey(next) !== snapKey(prev) && snapKey(next) !== '-|-') {
          selection();
        }
        g.current = next;
        setLive(next);
      })
      .onFinalize(() => {
        if (g.current) latest.current.onChange(g.current);
        g.current = null;
        setLive(null);
        if (g.began) {
          g.began = false;
          interacting.end();
        }
      });
  }, [interacting, latest]);

  const origin = anchorToOrigin(shown, width, height, size?.w ?? 0, size?.h ?? 0, inset);
  const move = (dx: number, dy: number) => {
    const next = originToAnchor(origin.x + dx, origin.y + dy, width, height, size?.w ?? 0, size?.h ?? 0, inset);
    onChange(next);
  };
  const onA11y = (e: AccessibilityActionEvent) => {
    const sx = width * 0.1;
    const sy = height * 0.1;
    switch (e.nativeEvent.actionName) {
      case 'moveLeft': move(-sx, 0); break;
      case 'moveRight': move(sx, 0); break;
      case 'moveUp': move(0, -sy); break;
      case 'moveDown': move(0, sy); break;
    }
  };

  return (
    <PageFrame uri={uri} width={width} height={height}>
      <GestureDetector gesture={pan}>
        <View
          collapsable={false}
          onLayout={e => {
            const { width: w, height: h } = e.nativeEvent.layout;
            if (!size || Math.abs(size.w - w) > 0.5 || Math.abs(size.h - h) > 0.5) setSize({ w, h });
          }}
          style={[
            styles.label,
            { left: origin.x, top: origin.y, opacity: size ? 1 : 0, shadowColor: colors.shadow },
            live ? styles.lifted : null,
          ]}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={`${label} on the page`}
          accessibilityHint="Drag to move it."
          accessibilityValue={{ text: `${pct(shown.x)} across, ${pct(shown.y)} down` }}
          accessibilityActions={[
            { name: 'moveLeft', label: 'Move left' },
            { name: 'moveRight', label: 'Move right' },
            { name: 'moveUp', label: 'Move up' },
            { name: 'moveDown', label: 'Move down' },
          ]}
          onAccessibilityAction={onA11y}
        >
          {children}
          {/* Says "this moves": an accent frame just outside the label. */}
          <View
            pointerEvents="none"
            style={[styles.labelFrame, { borderColor: colors.accentFill }]}
          />
        </View>
      </GestureDetector>
    </PageFrame>
  );
}

const styles = StyleSheet.create({
  frame: { alignSelf: 'center', padding: Spacing.sm, borderRadius: Radius.md },
  edge: { borderWidth: StyleSheet.hairlineWidth },
  body: { position: 'absolute' },
  fill: { width: '100%', height: '100%' },
  outline: { borderWidth: 1.5 },
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
  label: { position: 'absolute' },
  labelFrame: {
    position: 'absolute',
    left: -3,
    top: -3,
    right: -3,
    bottom: -3,
    borderWidth: 1.5,
    borderRadius: 4,
  },
  // Picked up: a soft shadow under it while the finger is down.
  lifted: { shadowOpacity: 0.35, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
});

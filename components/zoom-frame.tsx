// components/zoom-frame.tsx
// A fixed-size frame whose content can be pinched to zoom (up to MAX_ZOOM),
// panned while zoomed, double-tapped to zoom in on a spot and double-tapped
// again to fit. Everything inside zooms together, so marks drawn over a page
// (Find text's highlights) stay on their words.
//
// Built on gesture-handler + Reanimated, so it works the same on iOS and
// Android and runs on the UI thread. (The viewer's ZoomablePage uses
// UIScrollView zooming instead, which suits a pager of plain images.)
//
// `focus` zooms to a box (fractions of the content) and centres it — Find
// text's "next match". A new `focus.key` animates there; a new `resetKey`
// with no focus goes back to fit.
import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { ReduceMotion, runOnJS, useAnimatedStyle, useSharedValue, withDecay, withTiming } from 'react-native-reanimated';

export const MAX_ZOOM = 5;
const DOUBLE_TAP_ZOOM = 2.5;
const ANIM = { duration: 260, reduceMotion: ReduceMotion.System } as const;

export type ZoomFocus = {
  /** A new key moves to this box, even when it is the same box again. */
  key: number;
  /** The box to show, as fractions of the content (0–1). */
  x: number;
  y: number;
  w: number;
  h: number;
};

/** The zoom that makes a box of `w` (a fraction of the width) comfortably readable, with some of its line around it. Pure. */
export function focusZoom(w: number): number {
  return Math.min(3, Math.max(2, 0.35 / Math.max(w, 0.01)));
}

/**
 * The translation that puts content point (qx, qy) of a W × H frame at its
 * centre at zoom `s`, kept so the content still covers the frame. Pure. The
 * frame scales around its centre, so a content point q shows at
 * c + t + s(q - c).
 */
export function centredOn(qx: number, qy: number, W: number, H: number, s: number): { x: number; y: number } {
  const mx = ((s - 1) * W) / 2;
  const my = ((s - 1) * H) / 2;
  return {
    x: Math.min(mx, Math.max(-mx, -s * (qx - W / 2))),
    y: Math.min(my, Math.max(-my, -s * (qy - H / 2))),
  };
}

type Props = {
  width: number;
  height: number;
  children: ReactNode;
  focus?: ZoomFocus | null;
  /** A change goes back to fit (unless `focus` changed too). */
  resetKey?: unknown;
  onZoomChange?: (zoomed: boolean) => void;
};

export function ZoomFrame({ width: W, height: H, children, focus, resetKey, onZoomChange }: Props) {
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const start = useSharedValue({ s: 1, x: 0, y: 0, fx: 0, fy: 0 });
  const zoomedNow = useSharedValue(false);

  const report = (z: boolean) => onZoomChange?.(z);

  const animateTo = (s: number, x: number, y: number) => {
    scale.value = withTiming(s, ANIM);
    tx.value = withTiming(x, ANIM);
    ty.value = withTiming(y, ANIM);
    const z = s > 1.01;
    if (zoomedNow.value !== z) {
      zoomedNow.value = z;
      report(z);
    }
  };

  const focusKey = focus?.key ?? null;
  useEffect(() => {
    if (W <= 0 || H <= 0) return;
    if (focus) {
      const s = focusZoom(focus.w);
      const t = centredOn((focus.x + focus.w / 2) * W, (focus.y + focus.h / 2) * H, W, H, s);
      animateTo(s, t.x, t.y);
    } else {
      scale.value = 1;
      tx.value = 0;
      ty.value = 0;
      if (zoomedNow.value) {
        zoomedNow.value = false;
        report(false);
      }
    }
    // Only a new focus or a reset moves the view; the box itself rides along.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, resetKey, W, H]);

  const pinch = Gesture.Pinch()
    .onStart(e => {
      start.value = { s: scale.value, x: tx.value, y: ty.value, fx: e.focalX, fy: e.focalY };
    })
    .onUpdate(e => {
      const st = start.value;
      const s = Math.min(MAX_ZOOM, Math.max(1, st.s * e.scale));
      // The content point under the fingers when the pinch began stays under them.
      const qx = W / 2 + (st.fx - W / 2 - st.x) / st.s;
      const qy = H / 2 + (st.fy - H / 2 - st.y) / st.s;
      const mx = ((s - 1) * W) / 2;
      const my = ((s - 1) * H) / 2;
      scale.value = s;
      tx.value = Math.min(mx, Math.max(-mx, e.focalX - W / 2 - s * (qx - W / 2)));
      ty.value = Math.min(my, Math.max(-my, e.focalY - H / 2 - s * (qy - H / 2)));
    })
    .onEnd(() => {
      const z = scale.value > 1.01;
      if (!z) {
        scale.value = withTiming(1, ANIM);
        tx.value = withTiming(0, ANIM);
        ty.value = withTiming(0, ANIM);
      }
      if (zoomedNow.value !== z) {
        zoomedNow.value = z;
        runOnJS(report)(z);
      }
    });

  const pan = Gesture.Pan()
    .averageTouches(true)
    .onStart(() => {
      start.value = { s: scale.value, x: tx.value, y: ty.value, fx: 0, fy: 0 };
    })
    .onUpdate(e => {
      const s = scale.value;
      if (s <= 1.01) return;
      const mx = ((s - 1) * W) / 2;
      const my = ((s - 1) * H) / 2;
      tx.value = Math.min(mx, Math.max(-mx, start.value.x + e.translationX));
      ty.value = Math.min(my, Math.max(-my, start.value.y + e.translationY));
    })
    .onEnd(e => {
      const s = scale.value;
      if (s <= 1.01) return;
      const mx = ((s - 1) * W) / 2;
      const my = ((s - 1) * H) / 2;
      tx.value = withDecay({ velocity: e.velocityX, clamp: [-mx, mx], reduceMotion: ReduceMotion.System });
      ty.value = withDecay({ velocity: e.velocityY, clamp: [-my, my], reduceMotion: ReduceMotion.System });
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(e => {
      if (scale.value > 1.01) {
        scale.value = withTiming(1, ANIM);
        tx.value = withTiming(0, ANIM);
        ty.value = withTiming(0, ANIM);
        zoomedNow.value = false;
        runOnJS(report)(false);
        return;
      }
      // The tap is in the frame's (unzoomed) coordinates here.
      const s = DOUBLE_TAP_ZOOM;
      const mx = ((s - 1) * W) / 2;
      const my = ((s - 1) * H) / 2;
      scale.value = withTiming(s, ANIM);
      tx.value = withTiming(Math.min(mx, Math.max(-mx, -s * (e.x - W / 2))), ANIM);
      ty.value = withTiming(Math.min(my, Math.max(-my, -s * (e.y - H / 2))), ANIM);
      zoomedNow.value = true;
      runOnJS(report)(true);
    });

  const gesture = Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan));

  const animated = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View style={[styles.clip, { width: W, height: H }]} collapsable={false}>
        <Animated.View style={[{ width: W, height: H }, animated]}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
});

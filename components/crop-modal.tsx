// components/crop-modal.tsx
// The four-corner (perspective) crop editor for a stored page.
//
// - A page with a source photo (lib/page-source.ts) shows the WHOLE photo with
//   the page's current corners, so a crop that was too tight can be widened
//   into the background again.
// - A page without one shows its unfiltered image with the corners on its full
//   bounds (never a guessed inner rectangle); a perspective crop of it is still
//   possible, and — with "Keep original photos" on — the image it was cropped
//   from is kept, so that crop can be widened back later.
//
// Four corner handles move independently (a magnifier shows the area under the
// finger while one is dragged, so the corner can be put exactly on the paper's
// edge); four edge handles move a whole side. Auto finds the page again, Full
// page selects everything, and the page can be turned left or right. The shape
// must stay convex: otherwise the edges turn red and Done is disabled.
//
// All geometry lives in lib/quad.ts (tested); this file only draws it. Done
// hands the new geometry and the target it was measured on to the caller
// (app/viewer.tsx), which applies it under the page lock.
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PanResponderInstance,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '@/contexts/theme-context';
import { HeaderTextButton, ScreenHeader } from '@/components/screen-header';
import { FilterBaker } from '@/components/filter-baker';
import { useAppLocked } from '@/components/lock-gate';
import { HIT, Spacing, Type } from '@/lib/theme';
import { canDetectQuad, cropTargetFor, detectQuad, type CropTarget } from '@/lib/page-source';
import {
  FULL_QUAD,
  edgeMidpoint,
  fitRect,
  isConvexQuad,
  isFullQuad,
  moveCorner,
  moveEdge,
  quadSourceToView,
  quadViewToSource,
  rotateGeometry,
  sameGeometry,
  toPoints,
  viewToScreen,
  type Fit,
  type PageGeometry,
  type Point,
  type Quad,
  type Rotation,
} from '@/lib/quad';

type Props = {
  visible: boolean;
  /** The stored page to crop (ignored when `target` is given). */
  docId?: string;
  pageIndex?: number;
  /**
   * Crop this photo instead of a stored page (the camera's review,
   * app/camera.tsx): `onDone` receives the new geometry for it.
   */
  target?: CropTarget;
  /** Cache-bust value (document.updatedAt) so the image reflects in-place edits. */
  cacheBust?: number;
  onCancel: () => void;
  /**
   * Applies `geometry` (measured on `target`) to the page. Rejecting keeps the
   * editor open with an error so the user can retry.
   */
  onDone: (geometry: PageGeometry, target: CropTarget) => Promise<void>;
};

const HANDLE_RING = 24;
const LOUPE = 116;
const ZOOM = 2.5;
const CORNER_LABELS = ['Top-left corner', 'Top-right corner', 'Bottom-right corner', 'Bottom-left corner'];
const EDGE_LABELS = ['Top edge', 'Right edge', 'Bottom edge', 'Left edge'];

type Drag = { kind: 'corner' | 'edge'; index: number } | null;

export function CropModal({ visible, docId, pageIndex, target: givenTarget, cacheBust, onCancel, onDone }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [target, setTarget] = useState<CropTarget | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [geometry, setGeometry] = useState<PageGeometry | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [busy, setBusy] = useState<false | 'auto' | 'apply'>(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  // App lock: see the note in the viewer — close properly and remount.
  const locked = useAppLocked();
  const [modalKey, setModalKey] = useState(0);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    if (!locked || !visible) return;
    setModalKey(k => k + 1);
    onCancelRef.current();
  }, [locked, visible]);

  // What to show, read when the editor opens.
  useEffect(() => {
    if (!visible) {
      setTarget(null);
      setImgSize(null);
      setGeometry(null);
      setDrag(null);
      setMessage(null);
      setBusy(false);
      return;
    }
    try {
      const t = givenTarget ?? cropTargetFor(docId ?? '', pageIndex ?? 0);
      setTarget(t);
      setGeometry({ quad: [...t.geometry.quad], rotation: t.geometry.rotation });
    } catch (err) {
      console.error('Crop: target', err);
      setMessage({ text: 'This page can’t be cropped right now. Try again.', error: true });
    }
    // givenTarget is read when the editor opens, like a stored page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, docId, pageIndex]);

  const displayUri = target ? `${target.uri.split('?')[0]}?v=${cacheBust ?? 0}-${target.bytes}` : null;

  useEffect(() => {
    if (!displayUri) return;
    let cancelled = false;
    Image.getSize(
      displayUri,
      (w, h) => { if (!cancelled) setImgSize({ w, h }); },
      () => { if (!cancelled) setMessage({ text: 'This page can’t be shown. Try again.', error: true }); },
    );
    return () => { cancelled = true; };
  }, [displayUri]);

  const rotation: Rotation = geometry?.rotation ?? 0;
  const fit: Fit | null = imgSize && box ? fitRect(box.w, box.h, imgSize.w, imgSize.h, rotation) : null;
  const viewQuad: Quad | null = geometry ? quadSourceToView(geometry.quad, geometry.rotation) : null;
  const valid = !!(viewQuad && fit && isConvexQuad(viewQuad, fit.dispW / fit.dispH, Math.pow(32 / fit.dispH, 2)));

  // Refs for the gesture handlers (created once).
  const geomRef = useRef(geometry);
  geomRef.current = geometry;
  const fitRef = useRef(fit);
  fitRef.current = fit;

  const responders = useMemo(() => {
    const make = (kind: 'corner' | 'edge', index: number): PanResponderInstance => {
      let start: Quad | null = null;
      return PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          const g = geomRef.current;
          start = g ? quadSourceToView(g.quad, g.rotation) : null;
          setDrag({ kind, index });
          setMessage(null);
        },
        onPanResponderMove: (_, gs) => {
          const f = fitRef.current;
          const g = geomRef.current;
          if (!start || !f || !g) return;
          const dx = gs.dx / f.dispW;
          const dy = gs.dy / f.dispH;
          const next = kind === 'corner' ? moveCorner(start, index, dx, dy) : moveEdge(start, index, dx, dy);
          setGeometry({ quad: quadViewToSource(next, g.rotation), rotation: g.rotation });
        },
        onPanResponderRelease: () => { start = null; setDrag(null); },
        onPanResponderTerminate: () => { start = null; setDrag(null); },
      });
    };
    return {
      corners: [0, 1, 2, 3].map(i => make('corner', i)),
      edges: [0, 1, 2, 3].map(i => make('edge', i)),
    };
  }, []);

  const setView = useCallback((q: Quad) => {
    setGeometry(g => (g ? { quad: quadViewToSource(q, g.rotation), rotation: g.rotation } : g));
  }, []);

  const handleFull = () => {
    setMessage(null);
    setView([...FULL_QUAD]);
  };

  const handleRotate = (deg: number) => {
    setMessage(null);
    setGeometry(g => (g ? rotateGeometry(g, deg) : g));
  };

  const handleAuto = async () => {
    if (!target || busy) return;
    setBusy('auto');
    setMessage(null);
    try {
      const found = await detectQuad(target.uri);
      if (found) {
        // detectQuad answers in the photo's own frame (rotation 0); keep the
        // page turned the way it is.
        setGeometry(g => rotateGeometry({ quad: found, rotation: 0 }, g?.rotation ?? 0));
      } else {
        setMessage({ text: 'No page edges found. Drag the corners instead.' });
      }
    } finally {
      setBusy(false);
    }
  };

  async function handleDone() {
    if (!target || !geometry || !valid || busy) return;
    // Nothing changed (or a page without a source left whole): nothing to do.
    const unchanged = sameGeometry(geometry, target.geometry)
      || (!target.hasSource && geometry.rotation === 0 && isFullQuad(geometry.quad));
    if (unchanged) {
      onCancel();
      return;
    }
    setBusy('apply');
    setMessage(null);
    try {
      await onDone({ quad: geometry.quad.map(n => Math.min(1, Math.max(0, n))), rotation: geometry.rotation }, target);
    } catch (err) {
      console.error('Crop failed', err);
      setMessage({ text: 'Couldn’t crop this page. Try again.', error: true });
    } finally {
      setBusy(false);
    }
  }

  const screenPts: Point[] | null = viewQuad && fit ? toPoints(viewQuad).map(p => viewToScreen(p, fit)) : null;
  const lineColor = valid ? colors.chromeAccent : colors.danger;
  const dragPoint: Point | null = (() => {
    if (!drag || !viewQuad || !fit) return null;
    const p = drag.kind === 'corner' ? toPoints(viewQuad)[drag.index] : edgeMidpoint(viewQuad, drag.index);
    return p;
  })();

  const hint = message?.text
    ?? (!valid && viewQuad ? 'The corners cross over. Move them so the outline has four sides.'
      : target?.hasSource ? 'Drag the corners or edges. The whole original is shown, so you can widen the crop.'
        : 'Drag the corners or edges to fit the page.');

  const autoAvailable = canDetectQuad();
  const actions: { key: string; icon: ComponentProps<typeof Ionicons>['name']; label: string; a11y: string; onPress: () => void; flip?: boolean; disabled?: boolean; busy?: boolean }[] = [
    { key: 'auto', icon: 'scan-outline', label: 'Auto', a11y: 'Find the page edges automatically', onPress: handleAuto, disabled: !autoAvailable, busy: busy === 'auto' },
    { key: 'full', icon: 'expand-outline', label: 'Full page', a11y: 'Select the whole image', onPress: handleFull },
    { key: 'left', icon: 'refresh-outline', label: 'Rotate left', a11y: 'Rotate page counterclockwise', onPress: () => handleRotate(-90), flip: true },
    { key: 'right', icon: 'refresh-outline', label: 'Rotate right', a11y: 'Rotate page clockwise', onPress: () => handleRotate(90) },
  ];

  return (
    <Modal key={modalKey} visible={visible && !locked} animationType="slide" onRequestClose={onCancel} transparent={false}>
      <View style={[styles.container, { backgroundColor: colors.chrome }]}>
        <StatusBar style="light" />
        {/* This modal covers the viewer, whose baker can't run while buried. */}
        {visible && !locked && <FilterBaker />}
        <ScreenHeader
          dark
          title="Crop"
          left={<HeaderTextButton title="Cancel" color={colors.chromeText} onPress={onCancel} disabled={busy === 'apply'} />}
          right={
            busy === 'apply' ? (
              <ActivityIndicator color={colors.chromeAccent} style={styles.busy} accessibilityLabel="Cropping" />
            ) : (
              <HeaderTextButton
                title="Done"
                emphasis
                color={colors.chromeAccent}
                disabled={!valid || !!busy}
                onPress={handleDone}
              />
            )
          }
        />

        <View style={styles.cropArea} onLayout={e => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
          {fit && displayUri && imgSize && (
            <View pointerEvents="none" style={[styles.abs, { left: fit.offX, top: fit.offY, width: fit.dispW, height: fit.dispH }]}>
              <TurnedImage uri={displayUri} width={fit.dispW} height={fit.dispH} rotation={rotation} />
            </View>
          )}
          {!fit && !message?.error && <ActivityIndicator style={StyleSheet.absoluteFill} color={colors.chromeMuted} />}

          {screenPts && (
            <>
              {screenPts.map((a, i) => (
                <Segment key={`s${i}`} a={a} b={screenPts[(i + 1) % 4]} color={lineColor} />
              ))}
              {[0, 1, 2, 3].map(i => {
                const a = screenPts[i], b = screenPts[(i + 1) % 4];
                const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                const angle = Math.atan2(b.y - a.y, b.x - a.x);
                const active = drag?.kind === 'edge' && drag.index === i;
                return (
                  <View
                    key={`e${i}`}
                    {...responders.edges[i].panHandlers}
                    style={[styles.handle, { left: mid.x - HIT / 2, top: mid.y - HIT / 2 }]}
                    accessible
                    accessibilityLabel={EDGE_LABELS[i]}
                    accessibilityHint="Drag to move this side"
                  >
                    <View
                      style={[
                        styles.edgeGrip,
                        { backgroundColor: active ? colors.chromeText : lineColor, transform: [{ rotate: `${angle}rad` }] },
                      ]}
                    />
                  </View>
                );
              })}
              {screenPts.map((p, i) => {
                const active = drag?.kind === 'corner' && drag.index === i;
                return (
                  <View
                    key={`c${i}`}
                    {...responders.corners[i].panHandlers}
                    style={[styles.handle, { left: p.x - HIT / 2, top: p.y - HIT / 2 }]}
                    accessible
                    accessibilityLabel={CORNER_LABELS[i]}
                    accessibilityHint="Drag to move this corner"
                  >
                    <View
                      style={[
                        styles.ring,
                        { borderColor: lineColor, backgroundColor: active ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)' },
                      ]}
                    />
                  </View>
                );
              })}
            </>
          )}

          {dragPoint && fit && displayUri && box && screenPts && (
            <Loupe
              uri={displayUri}
              fit={fit}
              rotation={rotation}
              point={dragPoint}
              quadScreen={screenPts}
              box={box}
              accent={lineColor}
              ringColor={colors.chromeText}
              background={colors.chrome}
            />
          )}
        </View>

        <Text
          style={[Type.footnote, styles.hint, { color: message?.error || (!valid && viewQuad) ? colors.danger : colors.chromeMuted }]}
          accessibilityLiveRegion="polite"
        >
          {hint}
        </Text>

        <View style={[styles.actions, { backgroundColor: colors.chromeRaised, borderTopColor: colors.chromeBorder, paddingBottom: insets.bottom + Spacing.xs }]}>
          {actions.map(a => (
            <Pressable
              key={a.key}
              onPress={a.onPress}
              disabled={a.disabled || !!busy || !geometry}
              style={({ pressed }) => [styles.action, (pressed || a.disabled) && { opacity: a.disabled ? 0.35 : 0.55 }]}
              accessibilityRole="button"
              accessibilityLabel={a.a11y}
              accessibilityState={{ disabled: !!a.disabled, busy: !!a.busy }}
            >
              <View style={styles.actionIcon}>
                {a.busy ? (
                  <ActivityIndicator size="small" color={colors.chromeText} />
                ) : (
                  <Ionicons name={a.icon} size={24} color={colors.chromeText} style={a.flip ? styles.flip : undefined} />
                )}
              </View>
              <Text style={[Type.caption, styles.actionLabel, { color: colors.chromeText }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                {a.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

/** An image drawn turned clockwise by `rotation`, filling a `width`×`height` (already turned) box. */
function TurnedImage({ uri, width, height, rotation }: { uri: string; width: number; height: number; rotation: Rotation }) {
  const sideways = rotation === 90 || rotation === 270;
  const w = sideways ? height : width;
  const h = sideways ? width : height;
  return (
    <Image
      source={{ uri }}
      resizeMode="stretch"
      style={{
        position: 'absolute',
        width: w,
        height: h,
        left: (width - w) / 2,
        top: (height - h) / 2,
        transform: [{ rotate: `${rotation}deg` }],
      }}
    />
  );
}

/** A straight line between two screen points, with a dark halo so it reads on any photo. */
function Segment({ a, b, color }: { a: Point; b: Point; color: string }) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return (
    <View
      pointerEvents="none"
      style={[
        styles.segment,
        { left: mid.x - len / 2, top: mid.y - 2, width: len, transform: [{ rotate: `${angle}rad` }] },
      ]}
    >
      <View style={[styles.segmentLine, { backgroundColor: color }]} />
    </View>
  );
}

/**
 * A magnified view of the area around `point` (view frame), shown in the top
 * corner away from the finger, with crosshairs on the exact spot.
 */
function Loupe({
  uri, fit, rotation, point, quadScreen, box, accent, ringColor, background,
}: {
  uri: string; fit: Fit; rotation: Rotation; point: Point; quadScreen: Point[]; box: { w: number; h: number };
  accent: string; ringColor: string; background: string;
}) {
  const p = viewToScreen(point, fit);
  // Opposite side from the finger, so it is never under it.
  const left = p.x < box.w / 2 ? box.w - LOUPE - Spacing.xs : Spacing.xs;
  const top = Spacing.xs;
  const zw = fit.dispW * ZOOM;
  const zh = fit.dispH * ZOOM;
  const ox = LOUPE / 2 - point.x * zw;
  const oy = LOUPE / 2 - point.y * zh;
  // The outline, magnified the same way (screen → loupe).
  const toLoupe = (s: Point): Point => ({ x: (s.x - fit.offX) * ZOOM + ox, y: (s.y - fit.offY) * ZOOM + oy });
  const pts = quadScreen.map(toLoupe);
  return (
    <View pointerEvents="none" style={[styles.loupe, { left, top, borderColor: ringColor, backgroundColor: background }]}>
      <View style={[styles.abs, { left: ox, top: oy, width: zw, height: zh }]}>
        <TurnedImage uri={uri} width={zw} height={zh} rotation={rotation} />
      </View>
      {pts.map((a, i) => (
        <Segment key={i} a={a} b={pts[(i + 1) % 4]} color={accent} />
      ))}
      <View style={[styles.crossH, { backgroundColor: ringColor }]} />
      <View style={[styles.crossV, { backgroundColor: ringColor }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  busy: { minWidth: 60 },
  abs: { position: 'absolute' },
  // Handles at the image edge reach past it; nothing here clips.
  cropArea: { flex: 1, marginHorizontal: Spacing.xxl, marginVertical: Spacing.xl, position: 'relative' },
  handle: { position: 'absolute', width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  ring: { width: HANDLE_RING, height: HANDLE_RING, borderRadius: HANDLE_RING / 2, borderWidth: 3 },
  edgeGrip: { width: 26, height: 6, borderRadius: 3 },
  segment: { position: 'absolute', height: 4, justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.28)', borderRadius: 2 },
  segmentLine: { height: 2 },
  loupe: {
    position: 'absolute',
    width: LOUPE,
    height: LOUPE,
    borderRadius: LOUPE / 2,
    borderWidth: 2,
    overflow: 'hidden',
  },
  crossH: { position: 'absolute', left: LOUPE / 2 - 9, top: LOUPE / 2 - 0.75, width: 18, height: 1.5 },
  crossV: { position: 'absolute', left: LOUPE / 2 - 0.75, top: LOUPE / 2 - 9, width: 1.5, height: 18 },
  hint: { textAlign: 'center', paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.sm, minHeight: 36 },
  actions: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.xs,
    paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  action: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: HIT + 12, gap: 3 },
  actionIcon: { height: 26, justifyContent: 'center' },
  actionLabel: { fontWeight: '500' },
  flip: { transform: [{ scaleX: -1 }] },
});

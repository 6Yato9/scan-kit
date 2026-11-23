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
// - A page edited since its photo was taken (Sign, Markup, Watermark,
//   Timestamp: its kept photo no longer matches it) shows itself, and a
//   "This page / Original photo" switch: the original photo can be cropped
//   again, with a warning that this removes the edits (lib/page-source.ts
//   originalTargetFor). A redacted page never offers it: Redact deletes the
//   photo.
//
// Outside the crop the photo is dimmed: the bright photo is drawn again,
// clipped to the outline by four nested half-plane clips (lib/quad.ts
// edgeClips) — no SVG library needed.
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
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PanResponderInstance,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '@/contexts/theme-context';
import { HeaderTextButton, ScreenHeader } from '@/components/screen-header';
import { FilterBaker } from '@/components/filter-baker';
import { useAppLocked } from '@/components/lock-gate';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import { canDetectQuad, cropTargetFor, detectQuad, originalTargetFor, type CropTarget } from '@/lib/page-source';
import {
  FULL_QUAD,
  edgeClips,
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
  type EdgeClip,
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
/** Side margin of the crop area on Android (see styles.cropArea). */
const ANDROID_CROP_SIDE = 52;
const LOUPE = 116;
const ZOOM = 2.5;
const CORNER_LABELS = ['Top-left corner', 'Top-right corner', 'Bottom-right corner', 'Bottom-left corner'];
const EDGE_LABELS = ['Top edge', 'Right edge', 'Bottom edge', 'Left edge'];

type Drag = { kind: 'corner' | 'edge'; index: number } | null;
type Mode = 'page' | 'original';

const ORIGINAL_WARNING =
  'Starting from the original photo removes anything added to this page since, such as a signature, markup, watermark or timestamp. The filter stays.';

export function CropModal({ visible, docId, pageIndex, target: givenTarget, cacheBust, onCancel, onDone }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [pageTarget, setPageTarget] = useState<CropTarget | null>(null);
  // The page's original photo, when it was edited since (null: not offered).
  const [originalTarget, setOriginalTarget] = useState<CropTarget | null>(null);
  const [mode, setMode] = useState<Mode>('page');
  const target = mode === 'original' && originalTarget ? originalTarget : pageTarget;
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
      setPageTarget(null);
      setOriginalTarget(null);
      setMode('page');
      setImgSize(null);
      setGeometry(null);
      setDrag(null);
      setMessage(null);
      setBusy(false);
      return;
    }
    try {
      const t = givenTarget ?? cropTargetFor(docId ?? '', pageIndex ?? 0);
      setPageTarget(t);
      setOriginalTarget(!givenTarget && !t.hasSource ? originalTargetFor(docId ?? '', pageIndex ?? 0) : null);
      setMode('page');
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

  /** Switches between cropping the page as it is and its original photo. */
  const handleMode = (next: Mode) => {
    if (next === mode || busy) return;
    const t = next === 'original' ? originalTarget : pageTarget;
    if (!t) return;
    setMode(next);
    setImgSize(null); // the other image: measured again before anything is drawn
    setDrag(null);
    setMessage(null);
    setGeometry({ quad: [...t.geometry.quad], rotation: t.geometry.rotation });
  };

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
    // Starting again from the original photo is a change even with the same
    // corners: it removes the edits made since.
    const unchanged = !target.original && (sameGeometry(geometry, target.geometry)
      || (!target.hasSource && geometry.rotation === 0 && isFullQuad(geometry.quad)));
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

  const fromOriginal = !!target?.original;
  const crossed = !valid && !!viewQuad;
  const hint = message?.text
    ?? (crossed ? 'The corners cross over. Move them so the outline has four sides.'
      : fromOriginal ? ORIGINAL_WARNING
        : target?.hasSource ? 'Drag a corner or edge. The whole photo is shown, so you can widen the crop.'
          : 'Drag a corner or edge to adjust.');
  const hintColor = message?.error || crossed ? colors.danger : fromOriginal && !message ? colors.chromeWarning : colors.chromeMuted;

  const autoAvailable = canDetectQuad();
  const actions: { key: string; icon: ComponentProps<typeof Ionicons>['name']; label: string; a11y: string; onPress: () => void; flip?: boolean; disabled?: boolean; busy?: boolean }[] = [
    { key: 'auto', icon: 'scan-outline', label: 'Auto', a11y: 'Find the page edges automatically', onPress: handleAuto, disabled: !autoAvailable, busy: busy === 'auto' },
    { key: 'full', icon: 'expand-outline', label: 'Full page', a11y: 'Select the whole image', onPress: handleFull },
    { key: 'left', icon: 'refresh-outline', label: 'Rotate left', a11y: 'Rotate page counterclockwise', onPress: () => handleRotate(-90), flip: true },
    { key: 'right', icon: 'refresh-outline', label: 'Rotate right', a11y: 'Rotate page clockwise', onPress: () => handleRotate(90) },
  ];

  return (
    <Modal
      key={modalKey}
      visible={visible && !locked}
      animationType="slide"
      // Android's back is Cancel, except while the crop is being applied.
      onRequestClose={() => {
        if (busy !== 'apply') onCancel();
      }}
      transparent={false}
      statusBarTranslucent
      navigationBarTranslucent
    >
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

        {originalTarget && (
          <ModeSwitch
            mode={mode}
            onChange={handleMode}
            disabled={!!busy}
            colors={{ track: colors.chromeRaised, on: colors.chromeBorder, text: colors.chromeText, muted: colors.chromeMuted }}
          />
        )}

        <View style={styles.cropArea} onLayout={e => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
          {fit && displayUri && imgSize && (
            <View pointerEvents="none" style={[styles.abs, { left: fit.offX, top: fit.offY, width: fit.dispW, height: fit.dispH }]}>
              <TurnedImage uri={displayUri} width={fit.dispW} height={fit.dispH} rotation={rotation} />
            </View>
          )}
          {fit && displayUri && imgSize && box && screenPts && (
            <OutsideDim uri={displayUri} fit={fit} rotation={rotation} pts={screenPts} box={box} scrim={colors.chromeScrim} />
          )}
          {!fit && !message?.error && <ActivityIndicator style={StyleSheet.absoluteFill} color={colors.chromeMuted} />}

          {screenPts && (
            <>
              {screenPts.map((a, i) => (
                <Segment key={`s${i}`} a={a} b={screenPts[(i + 1) % 4]} color={lineColor} halo={colors.chromeHalo} />
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
                        { borderColor: lineColor, backgroundColor: active ? colors.chromeHandleActive : colors.chromeHandleFill },
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
              halo={colors.chromeHalo}
              background={colors.chrome}
            />
          )}
        </View>

        <View style={styles.hintRow}>
          {fromOriginal && !message && !crossed && (
            <Ionicons name="alert-circle-outline" size={16} color={hintColor} style={styles.hintIcon} />
          )}
          <Text
            style={[Type.footnote, styles.hint, { color: hintColor }]}
            accessibilityLiveRegion="polite"
            // Capped: uncapped, the largest text sizes made this a five-line
            // block that took a third of the screen from the crop area.
            maxFontSizeMultiplier={1.3}
          >
            {hint}
          </Text>
        </View>

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
function Segment({ a, b, color, halo }: { a: Point; b: Point; color: string; halo: string }) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return (
    <View
      pointerEvents="none"
      style={[
        styles.segment,
        { left: mid.x - len / 2, top: mid.y - 2, width: len, backgroundColor: halo, transform: [{ rotate: `${angle}rad` }] },
      ]}
    >
      <View style={[styles.segmentLine, { backgroundColor: color }]} />
    </View>
  );
}

/**
 * Dims the photo outside the outline `pts`: a scrim over the whole photo, then
 * the bright photo again, clipped to the outline by four nested half-plane
 * clips (lib/quad.ts edgeClips). Each clip is a big square turned to lie along
 * one edge with overflow hidden; the view inside it turns back, so the next
 * clip and finally the photo are placed in the crop area's own coordinates.
 */
function OutsideDim({
  uri, fit, rotation, pts, box, scrim,
}: {
  uri: string; fit: Fit; rotation: Rotation; pts: Point[]; box: { w: number; h: number }; scrim: string;
}) {
  const clips = edgeClips(pts, box.w, box.h);
  const nest = (rest: EdgeClip[]): React.ReactNode => {
    if (rest.length === 0) {
      return (
        <View style={[styles.abs, { left: fit.offX, top: fit.offY, width: fit.dispW, height: fit.dispH }]}>
          <TurnedImage uri={uri} width={fit.dispW} height={fit.dispH} rotation={rotation} />
        </View>
      );
    }
    const [c, ...more] = rest;
    return (
      <View
        collapsable={false}
        style={[styles.clip, { left: c.left, top: c.top, width: c.size, height: c.size, transform: [{ rotate: `${c.angle}rad` }] }]}
      >
        <View
          collapsable={false}
          style={[styles.abs, { left: c.inner.left, top: c.inner.top, width: box.w, height: box.h, transform: [{ rotate: `${-c.angle}rad` }] }]}
        >
          {nest(more)}
        </View>
      </View>
    );
  };
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[styles.abs, { left: fit.offX, top: fit.offY, width: fit.dispW, height: fit.dispH, backgroundColor: scrim }]} />
      {clips && nest(clips)}
    </View>
  );
}

/** "This page / Original photo", drawn for the always-dark chrome. */
function ModeSwitch({
  mode, onChange, disabled, colors,
}: {
  mode: Mode; onChange: (m: Mode) => void; disabled: boolean;
  colors: { track: string; on: string; text: string; muted: string };
}) {
  const options: { value: Mode; label: string; hint: string }[] = [
    { value: 'page', label: 'This page', hint: 'Crops the page as it is now' },
    { value: 'original', label: 'Original photo', hint: 'Crops the photo you scanned again. Anything added to the page since is removed.' },
  ];
  return (
    <View style={[styles.modeTrack, { backgroundColor: colors.track }]} accessibilityRole="radiogroup">
      {options.map(o => {
        const on = o.value === mode;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, selected: on, disabled }}
            accessibilityLabel={o.label}
            accessibilityHint={o.hint}
            style={[styles.modeItem, on && { backgroundColor: colors.on }]}
          >
            <Text
              style={[Type.subhead, { color: on ? colors.text : colors.muted, fontWeight: on ? '600' : '500' }]}
              numberOfLines={1}
              maxFontSizeMultiplier={1.3}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A magnified view of the area around `point` (view frame), shown in the top
 * corner away from the finger, with crosshairs on the exact spot.
 */
function Loupe({
  uri, fit, rotation, point, quadScreen, box, accent, ringColor, halo, background,
}: {
  uri: string; fit: Fit; rotation: Rotation; point: Point; quadScreen: Point[]; box: { w: number; h: number };
  accent: string; ringColor: string; halo: string; background: string;
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
        <Segment key={i} a={a} b={pts[(i + 1) % 4]} color={accent} halo={halo} />
      ))}
      {/* Two-tone, so the crosshair reads on white paper and on a dark table. */}
      <View style={[styles.crossHaloH, { backgroundColor: halo }]} />
      <View style={[styles.crossHaloV, { backgroundColor: halo }]} />
      <View style={[styles.crossH, { backgroundColor: ringColor }]} />
      <View style={[styles.crossV, { backgroundColor: ringColor }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  busy: { minWidth: 60 },
  abs: { position: 'absolute' },
  clip: { position: 'absolute', overflow: 'hidden' },
  // Handles at the image edge reach past it; nothing here clips.
  // Android: the corner handles' touch area (HIT/2 around each corner) must
  // start beyond the system back gesture's edge zone (~24-32dp), or dragging a
  // corner near the screen edge closes the editor instead.
  cropArea: {
    flex: 1,
    marginHorizontal: Platform.OS === 'android' ? ANDROID_CROP_SIDE : Spacing.xxl,
    marginVertical: Spacing.xl,
    position: 'relative',
  },
  handle: { position: 'absolute', width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  ring: { width: HANDLE_RING, height: HANDLE_RING, borderRadius: HANDLE_RING / 2, borderWidth: 3 },
  edgeGrip: { width: 26, height: 6, borderRadius: 3 },
  segment: { position: 'absolute', height: 4, justifyContent: 'center', borderRadius: 2 },
  segmentLine: { height: 2 },
  loupe: {
    position: 'absolute',
    width: LOUPE,
    height: LOUPE,
    borderRadius: LOUPE / 2,
    borderWidth: 2,
    overflow: 'hidden',
  },
  crossH: { position: 'absolute', left: LOUPE / 2 - 10, top: LOUPE / 2 - 0.75, width: 20, height: 1.5 },
  crossV: { position: 'absolute', left: LOUPE / 2 - 0.75, top: LOUPE / 2 - 10, width: 1.5, height: 20 },
  crossHaloH: { position: 'absolute', left: LOUPE / 2 - 11.5, top: LOUPE / 2 - 2.25, width: 23, height: 4.5, borderRadius: 2.25 },
  crossHaloV: { position: 'absolute', left: LOUPE / 2 - 2.25, top: LOUPE / 2 - 11.5, width: 4.5, height: 23, borderRadius: 2.25 },
  hintRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-start',
    gap: 6,
    paddingHorizontal: Spacing.gutter,
    paddingBottom: Spacing.sm,
    minHeight: 36,
  },
  hintIcon: { marginTop: 1 },
  hint: { textAlign: 'center', flexShrink: 1 },
  modeTrack: {
    flexDirection: 'row',
    marginHorizontal: Spacing.gutter,
    marginTop: Spacing.sm,
    padding: 3,
    borderRadius: Radius.sm + 2,
  },
  modeItem: {
    flex: 1,
    minHeight: HIT - 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.xs,
  },
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

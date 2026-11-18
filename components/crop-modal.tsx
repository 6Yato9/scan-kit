// components/crop-modal.tsx
// In-place crop UI for an existing page image. Drag the four corner handles to
// define a crop rectangle over the image; Done applies the crop via
// the caller (see app/viewer.tsx), which writes it under the page lock.
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  PanResponder,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '@/contexts/theme-context';
import { HeaderTextButton, ScreenHeader } from '@/components/screen-header';
import { FilterBaker } from '@/components/filter-baker';
import { useAppLocked } from '@/components/lock-gate';
import { Spacing, Type } from '@/lib/theme';

type Props = {
  visible: boolean;
  uri: string;
  /** Cache-bust value (document.updatedAt) so the image reflects in-place edits such as a rotate. */
  cacheBust?: number;
  onCancel: () => void;
  /**
   * `rect` is in natural image pixels. The caller applies it to the page and to
   * its page-N.orig.jpg shadow (same dimensions, differs only in colour) under
   * the page lock, so a filter bake landing meanwhile can't undo the crop.
   * Rejecting keeps the modal open with an error so the user can retry.
   */
  onDone: (rect: CropRect) => Promise<void>;
};

export type CropRect = { originX: number; originY: number; width: number; height: number };
type Rect = { x: number; y: number; w: number; h: number };
type Fit = { scale: number; offX: number; offY: number; dispW: number; dispH: number };

const HANDLE = 44;     // touch target size
const MIN = 48;        // minimum crop size in display px
const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;
type Corner = (typeof CORNERS)[number];

export function CropModal({ visible, uri, cacheBust, onCancel, onDone }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null); // container size
  const [rect, setRect] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // App lock: pushing /lock makes react-native-screens dismiss this RN Modal
  // natively while JS still thinks it is open — after unlocking it would be
  // gone and impossible to reopen. So close it properly (the user re-opens
  // Crop after unlocking), and remount the Modal so its native host starts
  // fresh. The baker goes immediately: a WebView in a dismissed modal never
  // runs, and as the top bake host it would stall every bake behind it.
  const locked = useAppLocked();
  const [modalKey, setModalKey] = useState(0);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    if (!locked || !visible) return;
    setModalKey(k => k + 1);
    onCancelRef.current();
  }, [locked, visible]);

  // The manipulator gets the bare path; the on-screen image and its measured size
  // get a cache-busted one, or RN's image cache can serve the pre-rotate pixels
  // (and dimensions) after an in-place edit.
  const cleanUri = uri.split('?')[0];
  const displayUri = cacheBust ? `${cleanUri}?v=${cacheBust}` : cleanUri;

  // Load natural image dimensions when the modal opens.
  useEffect(() => {
    if (!visible) {
      setImgSize(null);
      setRect(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    Image.getSize(
      displayUri,
      (w, h) => { if (!cancelled) setImgSize({ w, h }); },
      () => { if (!cancelled) setImgSize(null); },
    );
    return () => { cancelled = true; };
  }, [visible, displayUri]);

  // Compute the displayed-image rect (object-fit: contain) inside the container.
  const fit: Fit | null = imgSize && box
    ? (() => {
        const scale = Math.min(box.w / imgSize.w, box.h / imgSize.h);
        const dispW = imgSize.w * scale;
        const dispH = imgSize.h * scale;
        return { scale, dispW, dispH, offX: (box.w - dispW) / 2, offY: (box.h - dispH) / 2 };
      })()
    : null;

  // Initialise the crop rect to a small inset of the displayed image once known.
  useEffect(() => {
    if (fit && !rect) {
      const inset = 0.06;
      setRect({
        x: fit.offX + fit.dispW * inset,
        y: fit.offY + fit.dispH * inset,
        w: fit.dispW * (1 - inset * 2),
        h: fit.dispH * (1 - inset * 2),
      });
    }
  }, [fit, rect]);

  // One PanResponder per corner. Captures the rect at grant; clamps within the
  // displayed-image bounds with a minimum size.
  const rectRef = useRef<Rect | null>(null);
  rectRef.current = rect;
  const fitRef = useRef<Fit | null>(null);
  fitRef.current = fit;

  function makeResponder(corner: Corner) {
    let start: Rect | null = null;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { start = rectRef.current; },
      onPanResponderMove: (_, gs) => {
        const f = fitRef.current;
        if (!start || !f) return;
        const left = f.offX, top = f.offY, right = f.offX + f.dispW, bottom = f.offY + f.dispH;
        const sx = start.x, sy = start.y, sr = start.x + start.w, sb = start.y + start.h;
        let nx = sx, ny = sy, nr = sr, nb = sb;
        if (corner === 'tl' || corner === 'bl') nx = Math.min(Math.max(left, sx + gs.dx), sr - MIN);
        if (corner === 'tr' || corner === 'br') nr = Math.max(Math.min(right, sr + gs.dx), sx + MIN);
        if (corner === 'tl' || corner === 'tr') ny = Math.min(Math.max(top, sy + gs.dy), sb - MIN);
        if (corner === 'bl' || corner === 'br') nb = Math.max(Math.min(bottom, sb + gs.dy), sy + MIN);
        setRect({ x: nx, y: ny, w: nr - nx, h: nb - ny });
      },
    });
  }

  // Stable responders for the modal's lifetime.
  const responders = useRef<Record<Corner, ReturnType<typeof makeResponder>> | null>(null);
  if (!responders.current) {
    responders.current = { tl: makeResponder('tl'), tr: makeResponder('tr'), bl: makeResponder('bl'), br: makeResponder('br') };
  }

  async function handleDone() {
    if (!rect || !fit || !imgSize || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      // Display coords → image pixel coords.
      const originX = Math.max(0, Math.round((rect.x - fit.offX) / fit.scale));
      const originY = Math.max(0, Math.round((rect.y - fit.offY) / fit.scale));
      const width = Math.min(imgSize.w - originX, Math.round(rect.w / fit.scale));
      const height = Math.min(imgSize.h - originY, Math.round(rect.h / fit.scale));
      if (width < 1 || height < 1) { setBusy(false); return; }
      await onDone({ originX, originY, width, height });
    } catch (err) {
      console.error('Crop failed', err);
      // Leave the modal open so the user can retry.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const cornerPos = (c: Corner): { left: number; top: number } => {
    if (!rect) return { left: 0, top: 0 };
    const half = HANDLE / 2;
    const x = c === 'tl' || c === 'bl' ? rect.x : rect.x + rect.w;
    const y = c === 'tl' || c === 'tr' ? rect.y : rect.y + rect.h;
    return { left: x - half, top: y - half };
  };

  return (
    <Modal key={modalKey} visible={visible && !locked} animationType="slide" onRequestClose={onCancel} transparent={false}>
      <View style={[styles.container, { backgroundColor: colors.chrome }]}>
        <StatusBar style="light" />
        {/* This modal covers the viewer, whose baker can't run while buried. */}
        {visible && !locked && <FilterBaker />}
        <ScreenHeader
          dark
          title="Crop"
          left={<HeaderTextButton title="Cancel" color={colors.chromeText} onPress={onCancel} />}
          right={
            busy ? (
              <ActivityIndicator color={colors.chromeAccent} style={styles.busy} />
            ) : (
              <HeaderTextButton
                title="Done"
                emphasis
                color={colors.chromeAccent}
                disabled={!rect}
                onPress={handleDone}
              />
            )
          }
        />

        {/* Crop area */}
        <View
          style={styles.cropArea}
          onLayout={e => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        >
          <Image source={{ uri: displayUri }} style={StyleSheet.absoluteFill} resizeMode="contain" />

          {rect && (
            <>
              {/* Dim outside the crop rect (four bands) */}
              <View style={[styles.dim, { left: 0, top: 0, right: 0, height: rect.y }]} />
              <View style={[styles.dim, { left: 0, top: rect.y + rect.h, right: 0, bottom: 0 }]} />
              <View style={[styles.dim, { left: 0, top: rect.y, width: rect.x, height: rect.h }]} />
              <View style={[styles.dim, { left: rect.x + rect.w, top: rect.y, right: 0, height: rect.h }]} />

              {/* Crop border */}
              <View pointerEvents="none" style={[styles.cropBorder, { left: rect.x, top: rect.y, width: rect.w, height: rect.h, borderColor: colors.chromeAccent }]} />

              {/* Corner handles */}
              {CORNERS.map(c => {
                const p = cornerPos(c);
                return (
                  <View
                    key={c}
                    {...responders.current![c].panHandlers}
                    style={[styles.handle, { left: p.left, top: p.top }]}
                    accessibilityLabel="Crop corner"
                  >
                    <View style={[styles.handleDot, { backgroundColor: colors.chromeAccent, borderColor: colors.chromeText }]} />
                  </View>
                );
              })}
            </>
          )}
        </View>

        <Text style={[Type.footnote, styles.hint, { color: failed ? colors.danger : colors.chromeMuted, paddingBottom: insets.bottom + Spacing.md }]}>
          {failed ? "Couldn't crop this page. Try again." : 'Drag the corners to crop'}
        </Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  busy: { minWidth: 60 },
  // No overflow:hidden — corner handles sit at the image edge and would be
  // clipped (ungrabbable) on edge-to-edge images. The dim is drawn as explicit
  // bands, so nothing relies on clipping here.
  cropArea: { flex: 1, margin: Spacing.xxl, position: 'relative' },
  dim: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)' },
  cropBorder: { position: 'absolute', borderWidth: 2 },
  handle: { position: 'absolute', width: HANDLE, height: HANDLE, alignItems: 'center', justifyContent: 'center' },
  handleDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2 },
  hint: { textAlign: 'center', paddingTop: Spacing.xs },
});

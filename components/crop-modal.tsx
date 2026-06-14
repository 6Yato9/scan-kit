// components/crop-modal.tsx
// In-place crop UI for an existing page image. Drag the four corner handles to
// define a crop rectangle over the image; Done applies the crop via
// expo-image-manipulator and returns the new file URI.
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';

type Props = {
  visible: boolean;
  uri: string;
  onCancel: () => void;
  onDone: (croppedUri: string) => void;
};

type Rect = { x: number; y: number; w: number; h: number };
type Fit = { scale: number; offX: number; offY: number; dispW: number; dispH: number };

const HANDLE = 28;     // touch target size
const MIN = 48;        // minimum crop size in display px
const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;
type Corner = (typeof CORNERS)[number];

export function CropModal({ visible, uri, onCancel, onDone }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null); // container size
  const [rect, setRect] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);

  // Strip any cache-bust suffix before measuring / cropping.
  const cleanUri = uri.split('?')[0];

  // Load natural image dimensions when the modal opens.
  useEffect(() => {
    if (!visible) {
      setImgSize(null);
      setRect(null);
      return;
    }
    let cancelled = false;
    Image.getSize(
      cleanUri,
      (w, h) => { if (!cancelled) setImgSize({ w, h }); },
      () => { if (!cancelled) setImgSize(null); },
    );
    return () => { cancelled = true; };
  }, [visible, cleanUri]);

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
    try {
      // Display coords → image pixel coords.
      const originX = Math.max(0, Math.round((rect.x - fit.offX) / fit.scale));
      const originY = Math.max(0, Math.round((rect.y - fit.offY) / fit.scale));
      const width = Math.min(imgSize.w - originX, Math.round(rect.w / fit.scale));
      const height = Math.min(imgSize.h - originY, Math.round(rect.h / fit.scale));
      if (width < 1 || height < 1) { setBusy(false); return; }
      const result = await manipulateAsync(
        cleanUri,
        [{ crop: { originX, originY, width, height } }],
        { compress: 0.9, format: SaveFormat.JPEG },
      );
      onDone(result.uri);
    } catch {
      // Leave the modal open so the user can retry.
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
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel} transparent={false}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Top bar */}
        <View style={styles.topBar}>
          <Pressable onPress={onCancel} hitSlop={12} accessibilityRole="button" accessibilityLabel="Cancel crop">
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Crop</Text>
          <Pressable onPress={handleDone} hitSlop={12} disabled={busy} accessibilityRole="button" accessibilityLabel="Apply crop">
            {busy ? <ActivityIndicator color={colors.accent} /> : <Text style={[styles.done, { color: colors.accent }]}>Done</Text>}
          </Pressable>
        </View>

        {/* Crop area */}
        <View
          style={styles.cropArea}
          onLayout={e => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        >
          <Image source={{ uri: cleanUri }} style={StyleSheet.absoluteFill} resizeMode="contain" />

          {rect && (
            <>
              {/* Dim outside the crop rect (four bands) */}
              <View style={[styles.dim, { left: 0, top: 0, right: 0, height: rect.y }]} />
              <View style={[styles.dim, { left: 0, top: rect.y + rect.h, right: 0, bottom: 0 }]} />
              <View style={[styles.dim, { left: 0, top: rect.y, width: rect.x, height: rect.h }]} />
              <View style={[styles.dim, { left: rect.x + rect.w, top: rect.y, right: 0, height: rect.h }]} />

              {/* Crop border */}
              <View pointerEvents="none" style={[styles.cropBorder, { left: rect.x, top: rect.y, width: rect.w, height: rect.h, borderColor: colors.accent }]} />

              {/* Corner handles */}
              {CORNERS.map(c => {
                const p = cornerPos(c);
                return (
                  <View
                    key={c}
                    {...responders.current![c].panHandlers}
                    style={[styles.handle, { left: p.left, top: p.top }]}
                  >
                    <View style={[styles.handleDot, { backgroundColor: colors.accent }]} />
                  </View>
                );
              })}
            </>
          )}
        </View>

        <Text style={styles.hint}>Drag the corners to crop</Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  cancel: { color: '#ccc', fontSize: 16 },
  title: { color: '#fff', fontSize: 17, fontWeight: '700' },
  done: { fontSize: 16, fontWeight: '700' },
  // No overflow:hidden — corner handles sit at the image edge and would be
  // clipped (ungrabbable) on edge-to-edge images. The dim is drawn as explicit
  // bands, so nothing relies on clipping here.
  cropArea: { flex: 1, margin: 16, position: 'relative' },
  dim: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)' },
  cropBorder: { position: 'absolute', borderWidth: 2 },
  handle: { position: 'absolute', width: HANDLE, height: HANDLE, alignItems: 'center', justifyContent: 'center' },
  handleDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: '#fff' },
  hint: { color: '#888', textAlign: 'center', fontSize: 13, paddingBottom: 12 },
});

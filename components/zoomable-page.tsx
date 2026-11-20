// components/zoomable-page.tsx
// One scanned page in the viewer's pager that can be pinched to zoom (up to
// MAX_ZOOM) and panned, double-tapped to zoom in on a spot and double-tapped
// again to fit. Built on iOS's own UIScrollView zooming (ScrollView
// maximumZoomScale), so pinch, momentum and the rubber-band bounce are the
// system's: no JS runs per frame.
//
// Inside the horizontal pager: while a page is zoomed, a sideways drag pans
// the page first and only turns the page once it reaches the page's edge —
// UIKit hands the drag from the inner scroll view to the outer one there, the
// way Photos does. A page that scrolls out of view is put back to fit
// (`resetKey` changes), so coming back to it never shows it half-zoomed.
//
// Sharpness: RN's <Image> decodes a picture at its on-screen size, so a
// zoomed page was only that small bitmap blown up (blurry text). The page is
// drawn with expo-image instead, which keeps the file's full resolution
// (allowDownscaling false) — but only while the page is zoomed, so swiping
// through pages at fit costs no more memory than before.
// `cacheKey` makes an in-place rewrite of the same file load again (the file
// URI itself carries no version). On Android expo-image ignores `cacheKey` for
// file:// URIs (Glide keys its memory cache on the URI string), so there the
// version rides in a `?v=` query instead; Android opens a file:// URI by its
// path, so the query never reaches the file system.
//
// `onZoomChange(true)` when the page goes beyond fit, false when it is back,
// so the viewer can tell (e.g. to hide chrome) — optional.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View, type GestureResponderEvent } from 'react-native';
import { Image } from 'expo-image';

export const MAX_ZOOM = 5;
/** A double tap on a page at fit zooms in this far, centred on the tap. */
export const DOUBLE_TAP_ZOOM = 2.5;
/** Two taps closer together than this are a double tap. */
export const DOUBLE_TAP_MS = 300;

/** The rectangle to zoom to so the point (x, y) of a w × h page is centred at `scale`. Pure. */
export function zoomRectAround(x: number, y: number, w: number, h: number, scale: number) {
  const rw = w / scale;
  const rh = h / scale;
  return {
    x: Math.min(Math.max(0, x - rw / 2), Math.max(0, w - rw)),
    y: Math.min(Math.max(0, y - rh / 2), Math.max(0, h - rh)),
    width: rw,
    height: rh,
  };
}

type Props = {
  /** The page image's file URI (no query string). */
  uri: string;
  /** Changes whenever the file's content does (e.g. the document's updatedAt). */
  cacheKey: string;
  /** The page's box (the pager's page size). */
  width: number;
  height: number;
  /** Side padding around the page at fit, like the plain page had. */
  inset: number;
  /** Changes when the page should go back to fit (it left the screen). */
  resetKey?: unknown;
  onZoomChange?: (zoomed: boolean) => void;
  accessibilityLabel?: string;
};

export function ZoomablePage({ uri, cacheKey, width, height, inset, resetKey, onZoomChange, accessibilityLabel }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const zoomed = useRef(false);
  /** Mirrors `zoomed` for rendering: full resolution only while zoomed. */
  const [sharp, setSharp] = useState(false);
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;

  const setZoomed = useCallback((z: boolean) => {
    if (zoomed.current === z) return;
    zoomed.current = z;
    setSharp(z);
    onZoomChangeRef.current?.(z);
  }, []);

  const fit = useCallback((animated: boolean) => {
    scrollRef.current?.scrollResponderZoomTo({ x: 0, y: 0, width, height, animated });
  }, [width, height]);

  // Back to fit when the page leaves the screen (or the page size changes).
  useEffect(() => {
    if (zoomed.current) {
      fit(false);
      setZoomed(false);
    }
  }, [resetKey, fit, setZoomed]);

  // Double tap through RN's own press handling: a gesture-handler Tap inside
  // the native zoom view never fired (the UIScrollView's recognisers win).
  // The tap's location is in the page's own (unzoomed) coordinates, which is
  // what scrollResponderZoomTo takes.
  const lastTap = useRef(0);
  const onPress = (e: GestureResponderEvent) => {
    const now = Date.now();
    if (now - lastTap.current > DOUBLE_TAP_MS) {
      lastTap.current = now;
      return;
    }
    lastTap.current = 0;
    if (zoomed.current) {
      fit(true);
    } else {
      const { locationX, locationY } = e.nativeEvent;
      scrollRef.current?.scrollResponderZoomTo({ ...zoomRectAround(locationX, locationY, width, height, DOUBLE_TAP_ZOOM), animated: true });
    }
  };

  if (width <= 0 || height <= 0) return <View style={{ width, height }} />;

  return (
    <ScrollView
      ref={scrollRef}
      style={{ width, height }}
      contentContainerStyle={{ width, height }}
      minimumZoomScale={1}
      maximumZoomScale={MAX_ZOOM}
      bouncesZoom
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={64}
      onScroll={e => setZoomed((e.nativeEvent.zoomScale ?? 1) > 1.01)}
      // A pinch that ends below fit snaps back on its own; this catches the end state.
      onScrollEndDrag={e => setZoomed((e.nativeEvent.zoomScale ?? 1) > 1.01)}
    >
      <Pressable onPress={onPress} accessible={false}>
        <View style={[styles.box, { width, height, paddingHorizontal: inset }]} pointerEvents="none">
          <Image
            source={Platform.OS === 'android' ? { uri: `${uri}?v=${encodeURIComponent(cacheKey)}` } : { uri, cacheKey }}
            style={styles.image}
            contentFit="contain"
            allowDownscaling={!sharp}
            cachePolicy="memory"
            transition={0}
            accessibilityLabel={accessibilityLabel}
          />
        </View>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center' },
  image: { flex: 1, alignSelf: 'stretch' },
});

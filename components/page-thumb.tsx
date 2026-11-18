// components/page-thumb.tsx
// A page image in a fixed thumbnail tile. Portrait pages fill the tile (a
// sliver of an A4 or Letter page may be trimmed, as a page preview should);
// pages clearly wider than the tile, such as landscape pages, are fitted whole
// on the tile's neutral background instead of being cut down to their middle
// ("ndscape").
import { useState } from 'react';
import { Image, type ImageStyle, type StyleProp } from 'react-native';

/** How much wider than the tile (width ÷ height) a page may be and still fill it. */
const FILL_TOLERANCE = 1.2;

/**
 * 'cover' when the page's shape is close to (or taller than) the tile's,
 * 'contain' when it is clearly wider, so the whole width stays visible.
 * Unknown sizes fill, which is right for nearly every scan.
 */
export function thumbFit(pageAspect: number | undefined, tileAspect: number | undefined): 'cover' | 'contain' {
  if (!pageAspect || !tileAspect || !Number.isFinite(pageAspect) || !Number.isFinite(tileAspect)) return 'cover';
  return pageAspect > tileAspect * FILL_TOLERANCE ? 'contain' : 'cover';
}

/** width ÷ height per image path (cache-bust query ignored), shared by every thumbnail. */
const aspects = new Map<string, number>();
const keyOf = (uri: string) => uri.split('?')[0];

export function PageThumb({
  uri,
  style,
  accessibilityLabel,
}: {
  /** May carry a `?v=` cache-bust for the Image; it is ignored for the fit. */
  uri: string;
  /** The tile: give it a size and a background (shown beside a fitted page). */
  style: StyleProp<ImageStyle>;
  accessibilityLabel?: string;
}) {
  const [pageAspect, setPageAspect] = useState<number | undefined>(() => aspects.get(keyOf(uri)));
  const [tileAspect, setTileAspect] = useState<number | undefined>();
  const known = pageAspect ?? aspects.get(keyOf(uri));
  return (
    <Image
      source={{ uri }}
      style={style}
      resizeMode={thumbFit(known, tileAspect)}
      accessibilityLabel={accessibilityLabel}
      accessibilityIgnoresInvertColors
      onLayout={e => {
        const { width, height } = e.nativeEvent.layout;
        if (width > 0 && height > 0) setTileAspect(width / height);
      }}
      onLoad={e => {
        const { width, height } = e.nativeEvent.source ?? {};
        if (width && height) {
          aspects.set(keyOf(uri), width / height);
          setPageAspect(width / height);
        }
      }}
    />
  );
}

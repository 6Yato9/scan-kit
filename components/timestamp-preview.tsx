// components/timestamp-preview.tsx
// The Timestamp tool's previews (round 16), drawn from the same resolved
// numbers the canvas bakes with (lib/stamp.ts resolveStamp), in the same font:
// - TimestampBox: the stamp itself — highlight box, border, text — at any
//   scale (`fontSize` is the font size in points at that scale). It is what
//   LabelPlacer drags on the page preview.
// - TimestampCloseUp: the part of the page around the stamp, magnified so its
//   formatting reads (on the page preview the text is about 4 pt), with the
//   stamp where it will be. It is the same geometry scaled up: page width,
//   inset and anchor (lib/placement.ts anchorToOrigin), nothing re-laid out.
import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { anchorToOrigin, type Anchor } from '@/lib/placement';
import type { ResolvedStamp } from '@/lib/stamp';
import { Radius, Spacing, Type } from '@/lib/theme';

type ResolvedTimestamp = Extract<ResolvedStamp, { kind: 'timestamp' }>;

/** Helvetica, as the canvas draws (lib/stamp.ts STAMP_FONT): 500 there is Helvetica's regular face. */
const FAMILY = 'Helvetica';

export function TimestampBox({ r, fontSize }: { r: ResolvedTimestamp; fontSize: number }) {
  // The border sits inside the box, as the canvas strokes it: the padding
  // gives up its width, so the box and the text keep their size and place.
  const border = r.border ? r.borderEm * fontSize : 0;
  return (
    <View
      style={{
        paddingVertical: fontSize * r.padV - border,
        paddingHorizontal: fontSize * r.padH - border,
        borderRadius: fontSize * r.radius,
        backgroundColor: r.bg ?? 'transparent',
        borderWidth: border,
        borderColor: r.border ?? 'transparent',
      }}
    >
      <Text
        style={{
          fontFamily: FAMILY,
          fontWeight: r.weight === '700' ? '700' : '400',
          fontSize,
          lineHeight: fontSize * 1.15,
          color: r.ink,
        }}
        numberOfLines={1}
        allowFontScaling={false}
      >
        {r.text}
      </Text>
    </View>
  );
}

/** About this size (points) for the stamp's text in the close-up. */
const CLOSE_UP_FONT = 14;
/** The magnified page is never wider than this (points): it is decoded at this size. */
const CLOSE_UP_MAX_PAGE = 800;

export function TimestampCloseUp({
  uri,
  aspect,
  anchor,
  r,
  height,
}: {
  uri: string;
  /** Page height / width. */
  aspect: number;
  anchor: Anchor;
  r: ResolvedTimestamp;
  height: number;
}) {
  const { colors } = useTheme();
  const [w, setW] = useState(0);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  // The page magnified so the text is about CLOSE_UP_FONT, but always
  // covering the window, and never larger than CLOSE_UP_MAX_PAGE.
  const pageW = w > 0 ? Math.max(w, height / aspect, Math.min(CLOSE_UP_MAX_PAGE, CLOSE_UP_FONT / r.fontFrac)) : 0;
  const pageH = pageW * aspect;
  const fontSize = r.fontFrac * pageW;
  const inset = r.insetFrac * pageW;
  const bw = box?.w ?? 0;
  const bh = box?.h ?? 0;
  const origin = anchorToOrigin(anchor, pageW, pageH, bw, bh, inset);
  // The stamp in the middle of the window, unless that would show past the page's edge.
  const offX = Math.min(0, Math.max(w - pageW, w / 2 - (origin.x + bw / 2)));
  const offY = Math.min(0, Math.max(height - pageH, height / 2 - (origin.y + bh / 2)));
  return (
    <View
      style={[styles.window, { height, borderColor: colors.thumbBorder, backgroundColor: colors.input }]}
      onLayout={e => {
        const lw = Math.round(e.nativeEvent.layout.width);
        if (Math.abs(lw - w) > 0.5) setW(lw);
      }}
      accessible
      accessibilityLabel={`Close-up of the timestamp: ${r.text}`}
    >
      {pageW > 0 ? (
        <View style={{ position: 'absolute', left: offX, top: offY, width: pageW, height: pageH }} pointerEvents="none">
          <Image source={{ uri }} style={{ width: pageW, height: pageH }} resizeMode="stretch" />
          <View
            style={{ position: 'absolute', left: origin.x, top: origin.y, opacity: box ? 1 : 0 }}
            onLayout={e => {
              const { width: lw, height: lh } = e.nativeEvent.layout;
              if (!box || Math.abs(box.w - lw) > 0.5 || Math.abs(box.h - lh) > 0.5) setBox({ w: lw, h: lh });
            }}
          >
            <TimestampBox r={r} fontSize={fontSize} />
          </View>
        </View>
      ) : null}
      {/* Says what this is: the page, magnified. */}
      <View style={[styles.tag, { backgroundColor: colors.bg }]} pointerEvents="none">
        <Ionicons name="search" size={11} color={colors.muted} />
        <Text style={[Type.caption, { color: colors.muted }]} maxFontSizeMultiplier={1.2}>
          Close-up
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  window: { borderRadius: Radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  tag: {
    position: 'absolute',
    left: Spacing.sm,
    top: Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: Spacing.sm - 2,
    paddingVertical: 2,
    borderRadius: Radius.pill,
    opacity: 0.92,
  },
});

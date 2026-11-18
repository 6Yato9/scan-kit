// components/word-clamp-text.tsx
// Text clamped to a number of lines that, when it overflows, ends on a whole
// word followed by "…" ("Northwind Traders quarterly…"), never mid-word
// ("Northwind Traders quarterly consulti…"), which iOS's tail truncation does.
//
// Candidates are laid out invisibly at the same width: first the full text,
// then the words that fit plus "…", dropping a word until it fits.
//
// A spaced dash stays at the end of the line with the word before it
// ("Northwind Traders –" / "Project Atlas"), never starting the next line —
// unless keeping them together would leave a single word alone on the first
// line ("Meeting" / "Notes – Project…"): then the dash may start the second
// line ("Meeting Notes" / "– Project Atlas"), which keeps the whole name.
import { useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

/**
 * `text` with the space before each spaced dash ("Invoice - Project") made
 * non-breaking, so a line can break after the dash but never before it.
 */
export function glueDashes(text: string): string {
  return text.replace(/ ([-–—])(?=\s)/g, '\u00A0$1');
}

/**
 * True when glueing a dash pushed a word off the first line: that line holds a
 * single word and the next one starts with a word glued to its dash
 * ("Meeting" / "Notes\u00A0– Project"). The text then reads better unglued.
 */
export function glueStrandsFirstLine(lines: string[]): boolean {
  if (lines.length < 2) return false;
  const first = lines[0].trim();
  return first.length > 0 && !/\s/.test(first) && /^\S+\u00A0[-–—]/.test(lines[1]);
}

/** `text` without its last word (and any trailing separators), or null if it is one word. */
export function dropLastWord(text: string): string | null {
  const trimmed = text.replace(/\s+$/, '');
  const cut = trimmed.search(/\s+\S*$/);
  if (cut <= 0) return null;
  return trimmed.slice(0, cut).replace(/[\s,;:–—-]+$/, '') || null;
}

/** The first candidate after the full text overflowed: the words on the first `max` lines, plus "…". */
export function firstCandidate(lines: string[], max: number): string | null {
  const kept = lines.slice(0, max).join('').replace(/[\s,;:–—-]+$/, '');
  return kept ? `${kept}…` : null;
}

type Fit = {
  source: string;
  candidate: string | null;
  done: boolean;
  result: string | null;
  /** Dashes kept with the word before them (see glueStrandsFirstLine). */
  glued: boolean;
};

export function WordClampText({
  children,
  numberOfLines,
  style,
  maxFontSizeMultiplier,
}: {
  children: string;
  numberOfLines: number;
  style?: StyleProp<TextStyle>;
  maxFontSizeMultiplier?: number;
}) {
  // A new text or width starts the fitting over.
  const [width, setWidth] = useState(0);
  const glued = glueDashes(children);
  const source = `${width}\n${children}`;
  const fresh: Fit = { source, candidate: null, done: false, result: null, glued: glued !== children };
  const [stored, setFit] = useState<Fit>(fresh);
  const fit = stored.source === source ? stored : fresh;
  const text = fit.glued ? glued : children;
  const shown = fit.done && fit.result ? fit.result : text;

  return (
    <View onLayout={e => setWidth(Math.round(e.nativeEvent.layout.width))}>
      <Text style={style} numberOfLines={numberOfLines} maxFontSizeMultiplier={maxFontSizeMultiplier}>
        {shown}
      </Text>
      {fit.done || width === 0 ? null : (
        // Measures one candidate at the same width; never seen or read. Keyed
        // so every candidate is a fresh layout that reports its lines.
        <Text
          key={`${fit.source}\n${fit.glued}\n${fit.candidate ?? ''}`}
          style={[style, styles.measure]}
          maxFontSizeMultiplier={maxFontSizeMultiplier}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          onTextLayout={e => {
            const lines = e.nativeEvent.lines.map(l => l.text);
            const fits = lines.length <= numberOfLines;
            if (fit.candidate === null) {
              // A glued dash left one word alone on line 1: measure again unglued.
              if (fit.glued && glueStrandsFirstLine(lines)) {
                setFit({ ...fit, glued: false });
                return;
              }
              // The full text: done if it fits, else start from the words on the kept lines.
              const first = fits ? null : firstCandidate(lines, numberOfLines);
              setFit(fits || !first
                ? { ...fit, done: true, result: null }
                : { ...fit, candidate: first });
              return;
            }
            if (fits) {
              setFit({ ...fit, done: true, result: fit.candidate });
              return;
            }
            const shorter = dropLastWord(fit.candidate.slice(0, -1));
            setFit(shorter
              ? { ...fit, candidate: `${shorter}…` }
              : { ...fit, done: true, result: null }); // one long word: normal truncation
          }}
        >
          {fit.candidate ?? text}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  measure: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 },
});

// lib/theme.ts
export type ThemePreference = 'light' | 'dark' | 'system';

export type ThemeColors = {
  bg: string;
  card: string;
  input: string;
  text: string;
  subtext: string;
  muted: string;
  faint: string;
  border: string;
  separator: string;
  placeholder: string;
  accent: string;
  accentLight: string;
  danger: string;
  dangerBg: string;
  dangerBorder: string;
  actionBtnBg: string;
  secondary: string;        // secondary button bg (e.g. Retake)
  /** Fill for primary buttons / selected segments. Meets 4.5:1 with onAccent in both modes. */
  accentFill: string;
  /** Text and icons drawn on accentFill. */
  onAccent: string;
  /** Always-dark chrome (viewer, annotate, crop) — independent of the app theme. */
  chrome: string;
  chromeRaised: string;
  chromeText: string;
  chromeMuted: string;
  /** Tinted text/icons (selected states, "Done") on chrome. */
  chromeAccent: string;
  /** Hairlines and inactive outlines on chrome. */
  chromeBorder: string;
  /** A sheet of paper (signature pad, page previews) — white in both themes. */
  paper: string;
  /** Faint guide line drawn on `paper`. */
  paperLine: string;
};

export const Colors: Record<'light' | 'dark', ThemeColors> = {
  light: {
    bg: '#f5f5f5',
    card: '#ffffff',
    input: '#ebebeb',
    text: '#1a1a1a',
    subtext: '#555',
    muted: '#666',
    faint: '#777',
    border: '#e8e8e8',
    separator: '#f0f0f0',
    placeholder: '#e8e8e8',
    accent: '#0a7ea4',
    accentLight: '#e8f5fa',
    danger: '#cc0000',
    dangerBg: '#fff0f0',
    dangerBorder: '#ffc5c5',
    actionBtnBg: '#f5f5f5',
    secondary: '#f0f0f0',
    accentFill: '#0a7ea4',
    onAccent: '#ffffff',
    chrome: '#111111',
    chromeRaised: '#1c1c1e',
    chromeText: '#ffffff',
    chromeMuted: '#9a9a9f',
    chromeAccent: '#4ec6e0',
    chromeBorder: '#3a3a3c',
    paper: '#ffffff',
    paperLine: '#c8c8c8',
  },
  dark: {
    bg: '#111111',
    card: '#1e1e1e',
    input: '#2a2a2a',
    text: '#f0f0f0',
    subtext: '#aaa',
    muted: '#888',
    faint: '#888',
    border: '#333333',
    separator: '#2a2a2a',
    placeholder: '#333333',
    accent: '#4ec6e0',
    accentLight: '#1a3d4a',
    danger: '#ff6b6b',
    dangerBg: '#3d1a1a',
    dangerBorder: '#7a3333',
    actionBtnBg: '#2a2a2a',
    secondary: '#2a2a2a',
    // The dark accent (#4ec6e0) is right for tinted text and icons on dark
    // backgrounds but gives white text only ~2:1, so filled buttons use the
    // deeper light-mode accent instead.
    accentFill: '#0a7ea4',
    onAccent: '#ffffff',
    chrome: '#111111',
    chromeRaised: '#1c1c1e',
    chromeText: '#ffffff',
    chromeMuted: '#9a9a9f',
    chromeAccent: '#4ec6e0',
    chromeBorder: '#3a3a3c',
    paper: '#ffffff',
    paperLine: '#c8c8c8',
  },
};

// ---------------------------------------------------------------------------
// Layout and type scales. Use these instead of ad-hoc numbers so every screen
// shares one rhythm.
// ---------------------------------------------------------------------------

/** 4-pt spacing scale. `gutter` is the horizontal screen padding everywhere. */
export const Spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  gutter: 16,
} as const;

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

/** Minimum hit target (Apple HIG). */
export const HIT = 44;

/** iOS-style text styles. Colour is applied by the caller from the theme. */
export const Type = {
  largeTitle: { fontSize: 34, fontWeight: '700' as const, letterSpacing: 0.37 },
  title: { fontSize: 22, fontWeight: '700' as const },
  headline: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  callout: { fontSize: 15, fontWeight: '400' as const },
  subhead: { fontSize: 15, fontWeight: '500' as const },
  footnote: { fontSize: 13, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
  sectionLabel: { fontSize: 13, fontWeight: '600' as const, letterSpacing: 0.4, textTransform: 'uppercase' as const },
} as const;

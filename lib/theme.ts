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
  /** Secondary buttons: a tinted fill that reads on both `bg` and `card`. */
  tintFill: string;
  /** Text and icons on `tintFill` (≥ 4.5:1). */
  onTint: string;
  /** Selected segment of a segmented control — raised above the `input` track. */
  segmentOn: string;
  /** Outline of an unselected radio / checkbox. */
  ring: string;
  /** Hairline around document thumbnails so white pages don't melt into white cards. */
  thumbBorder: string;
  /** Drop shadows. */
  shadow: string;
  /** Dark wash behind text or badges drawn over images. */
  scrim: string;
  /** Lighter wash for unselected checkboxes over images. */
  scrimSoft: string;
  /** Text and outlines drawn on `scrim`. */
  onScrim: string;
  /** Dimmed backdrop behind sheets. */
  backdrop: string;
  /** Hairline edge around sheets (only visible in dark mode). */
  sheetBorder: string;
  /** Grabber at the top of a sheet. */
  handle: string;
  /** Floating tab bar: material tint for the blur, a fallback fill, and its hairline. */
  barBlurTint: 'systemChromeMaterialLight' | 'systemChromeMaterialDark';
  barFill: string;
  barBorder: string;
  /** The tab bar's moving selection pill. */
  barSelector: string;
  barSelectorBorder: string;
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
    tintFill: '#dcebf1',
    onTint: '#07698a',
    segmentOn: '#ffffff',
    ring: '#c4c4c8',
    thumbBorder: '#dadade',
    shadow: '#000000',
    scrim: 'rgba(0,0,0,0.55)',
    scrimSoft: 'rgba(0,0,0,0.25)',
    onScrim: '#ffffff',
    backdrop: 'rgba(0,0,0,0.4)',
    sheetBorder: 'transparent',
    handle: 'rgba(0,0,0,0.18)',
    barBlurTint: 'systemChromeMaterialLight',
    barFill: 'rgba(248,248,248,0.72)',
    barBorder: 'rgba(0,0,0,0.08)',
    barSelector: 'rgba(0,0,0,0.07)',
    barSelectorBorder: 'rgba(0,0,0,0.10)',
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
    tintFill: '#1d3a45',
    onTint: '#6fd3ea',
    segmentOn: '#4a4a4e',
    ring: '#5a5a5e',
    thumbBorder: '#3a3a3c',
    shadow: '#000000',
    scrim: 'rgba(0,0,0,0.55)',
    scrimSoft: 'rgba(0,0,0,0.25)',
    onScrim: '#ffffff',
    backdrop: 'rgba(0,0,0,0.6)',
    sheetBorder: 'rgba(255,255,255,0.08)',
    handle: 'rgba(255,255,255,0.25)',
    barBlurTint: 'systemChromeMaterialDark',
    barFill: 'rgba(30,30,30,0.72)',
    barBorder: 'rgba(255,255,255,0.12)',
    barSelector: 'rgba(255,255,255,0.12)',
    barSelectorBorder: 'rgba(255,255,255,0.18)',
  },
};

/**
 * Ink colours are content, not UI: they are what ends up on the page, so they
 * are the same in both themes. Annotation pens and the stamp previews use them.
 */
export const Ink = {
  black: '#000000',
  red: '#e53935',
  blue: '#1565c0',
  green: '#2e7d32',
  /** Signature strokes as saved into the PDF. */
  signature: '#111111',
  /** Timestamp label as drawn by lib/stamp.ts (kept in sync with its overlay). */
  stampText: '#222222',
  stampBg: 'rgba(255,255,255,0.85)',
} as const;

/**
 * Highlighter colours (Markup). Content like Ink: drawn opaque on their own
 * layer and multiplied onto the page, so dark print shows through.
 */
export const Highlight = {
  yellow: '#ffe45e',
  green: '#a6ee8f',
  pink: '#ffa8d2',
  blue: '#a3dcff',
} as const;

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

/**
 * Bottom padding a tab screen's scroll content needs so its last row can
 * scroll fully clear of the floating tab bar (and its raised scan button).
 * Add the bottom safe-area inset on top of this.
 */
export const TAB_BAR_CLEARANCE = 112;

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

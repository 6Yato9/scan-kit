// lib/tool-catalog.ts
// The one list of Scan Kit's tools: id, label, icon, colour and the screen each
// opens. The Tools tab, Home's Tools row and the viewer's Tools sheet all draw
// from it, so a tool looks and reads the same wherever it appears.
//
// Colour: every tool has its own hue, drawn as the icon on a pale tile of the
// same hue (the Tools tab looked like this before round 3 made it uniform; the
// owner asked for it back). Each hue has a deeper shade for light mode and a
// lighter one for dark mode, and the tile is that shade blended into the card
// it sits on, so the icon keeps at least 4.5:1 against its own tile in both
// themes (tested in __tests__/tool-catalog.test.ts) — not just the 3:1 WCAG
// asks of icons. Neighbours in a row never share a hue.
//
// Which tools fit an open document (documentToolSections) is decided here too,
// as a pure function of what the document is and what this build and this PDF
// allow, so the viewer only maps ids to actions.
//
// Pure: no React Native imports (types only), so jest tests it directly.
import type { Href } from 'expo-router';
import type { AppIconName } from '@/components/app-icon';
import { Colors } from '@/lib/theme';

// ── Colour ───────────────────────────────────────────────────────────────────

export type ToolHue =
  | 'blue'
  | 'indigo'
  | 'purple'
  | 'pink'
  | 'red'
  | 'orange'
  | 'amber'
  | 'green'
  | 'teal'
  | 'cyan'
  | 'brown'
  | 'graphite';

/** Icon colour per hue: `light` on white cards, `dark` on the dark theme's cards. */
export const TOOL_HUES: Record<ToolHue, { light: string; dark: string }> = {
  blue: { light: '#1A62C2', dark: '#66A8FF' },
  indigo: { light: '#4F46E5', dark: '#9D98FF' },
  purple: { light: '#8A3DCF', dark: '#C996F5' },
  pink: { light: '#BC2864', dark: '#FF85B0' },
  red: { light: '#BF352B', dark: '#FF8075' },
  orange: { light: '#AC4A0C', dark: '#FFA25C' },
  amber: { light: '#8F5600', dark: '#F5C451' },
  green: { light: '#1D7637', dark: '#63D484' },
  teal: { light: '#0A6F69', dark: '#4ED6C8' },
  cyan: { light: '#086E90', dark: '#4EC6E0' },
  brown: { light: '#86562E', dark: '#D9A877' },
  graphite: { light: '#4E5D6E', dark: '#AAB8C8' },
};

/** How much of the hue the tile carries over the card (a pale wash, stronger in dark mode to read at all). */
export const TILE_TINT = { light: 0.12, dark: 0.18 } as const;

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** `fg` laid over `bg` at `alpha`, as an opaque #rrggbb. */
export function blendHex(fg: string, bg: string, alpha: number): string {
  const a = parseHex(fg);
  const b = parseHex(bg);
  return `#${a.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2 contrast ratio between two opaque colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = parseHex(hex).map(c => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * A tool's icon colour and tile colour for the theme. The tile is opaque (the
 * hue blended into the theme's card), so it looks the same in a sheet, on a
 * card or on the screen background.
 */
export function toolSwatch(hue: ToolHue, dark: boolean): { fg: string; bg: string } {
  const fg = TOOL_HUES[hue][dark ? 'dark' : 'light'];
  const card = Colors[dark ? 'dark' : 'light'].card;
  return { fg, bg: blendHex(fg, card, dark ? TILE_TINT.dark : TILE_TINT.light) };
}

// ── The catalogue ────────────────────────────────────────────────────────────

export type ToolId =
  | 'whiteboard'
  | 'book'
  | 'id-card'
  | 'business-card'
  | 'sign'
  | 'redact'
  | 'watermark'
  | 'timestamp'
  | 'merge'
  | 'create-pdf'
  | 'split'
  | 'extract'
  | 'compress'
  | 'unrestrict'
  | 'protect'
  | 'flatten'
  | 'extract-text'
  | 'find-text'
  | 'qr'
  | 'long-image'
  | 'erase-marks'
  // Only offered on an open document (the viewer's Tools sheet):
  | 'fill'
  | 'convert-pages';

export type ToolEntry = {
  id: ToolId;
  label: string;
  icon: AppIconName;
  hue: ToolHue;
  /**
   * The screen it opens, with the params it always needs. Null for tools that
   * only exist on an open document and run in the viewer itself.
   */
  route: { pathname: string; params?: Record<string, string> } | null;
};

// Labels match the title of the screen they open and fit on one line. Icons:
// see components/app-icon.tsx for the SF Symbol glyphs (signature, watermark,
// id-card, split, long-image). Flatten uses the layers glyph of Share's
// "Flattened PDF"; Create PDF a document with files attached; Split one frame
// divided in two (the scissors are Extract pages).
export const TOOLS: Record<ToolId, ToolEntry> = {
  whiteboard: { id: 'whiteboard', label: 'Whiteboard', icon: 'easel-outline', hue: 'teal', route: { pathname: '/tools/whiteboard' } },
  book: { id: 'book', label: 'Book mode', icon: 'book-outline', hue: 'brown', route: { pathname: '/tools/book' } },
  'id-card': { id: 'id-card', label: 'ID card', icon: 'id-card', hue: 'orange', route: { pathname: '/tools/id-card' } },
  'business-card': { id: 'business-card', label: 'Business card', icon: 'person-add-outline', hue: 'indigo', route: { pathname: '/tools/business-card' } },

  sign: { id: 'sign', label: 'Sign', icon: 'signature', hue: 'blue', route: { pathname: '/tools/sign' } },
  redact: { id: 'redact', label: 'Redact', icon: 'eye-off-outline', hue: 'graphite', route: { pathname: '/tools/redact' } },
  watermark: { id: 'watermark', label: 'Watermark', icon: 'watermark', hue: 'purple', route: { pathname: '/tools/watermark' } },
  timestamp: { id: 'timestamp', label: 'Timestamp', icon: 'time-outline', hue: 'amber', route: { pathname: '/tools/timestamp' } },

  merge: { id: 'merge', label: 'Merge', icon: 'git-merge-outline', hue: 'cyan', route: { pathname: '/tools/merge' } },
  'create-pdf': { id: 'create-pdf', label: 'Create PDF', icon: 'document-attach-outline', hue: 'red', route: { pathname: '/tools/create-pdf' } },
  split: { id: 'split', label: 'Split', icon: 'split', hue: 'pink', route: { pathname: '/tools/split' } },
  extract: { id: 'extract', label: 'Extract pages', icon: 'cut-outline', hue: 'green', route: { pathname: '/tools/extract' } },

  compress: { id: 'compress', label: 'Compress', icon: 'contract-outline', hue: 'orange', route: { pathname: '/tools/compress', params: { mode: 'pdf' } } },
  unrestrict: { id: 'unrestrict', label: 'Unlock PDF', icon: 'lock-open-outline', hue: 'green', route: { pathname: '/tools/unrestrict' } },
  protect: { id: 'protect', label: 'Protect PDF', icon: 'lock-closed-outline', hue: 'indigo', route: { pathname: '/tools/protect' } },
  flatten: { id: 'flatten', label: 'Flatten PDF', icon: 'layers-outline', hue: 'brown', route: { pathname: '/tools/flatten' } },

  'extract-text': { id: 'extract-text', label: 'Extract text', icon: 'reader-outline', hue: 'green', route: { pathname: '/tools/extract-text' } },
  // Amber: the yellow of its highlights.
  'find-text': { id: 'find-text', label: 'Find text', icon: 'search-outline', hue: 'amber', route: { pathname: '/tools/find-text' } },
  qr: { id: 'qr', label: 'QR code', icon: 'qr-code-outline', hue: 'graphite', route: { pathname: '/tools/qr' } },
  'long-image': { id: 'long-image', label: 'Long image', icon: 'long-image', hue: 'amber', route: { pathname: '/tools/long-image' } },
  'erase-marks': { id: 'erase-marks', label: 'Erase marks', icon: 'color-wand-outline', hue: 'purple', route: { pathname: '/tools/erase-marks' } },

  // An imported PDF's Fill & sign is Sign for PDFs: the same glyph and colour.
  fill: { id: 'fill', label: 'Fill & sign', icon: 'signature', hue: 'blue', route: null },
  // "Convert to pages" in the "…" menu; on a tile it must fit one line (the banner says "Edit this PDF as pages").
  'convert-pages': { id: 'convert-pages', label: 'Edit as pages', icon: 'images-outline', hue: 'orange', route: null },
};

export type ToolSection = { title: string; tools: ToolId[] };

// The Tools tab. Genuine tools only: anything the core screens already do
// lives there instead — import (Files "+"), reorder / rotate / text (viewer),
// print / save as images (Export). Sections are rows of four (Convert runs on
// to a second row), so icons line up down the screen. Pages holds what makes
// or takes apart documents; PDF what changes the file itself. Find text and QR
// code sit in Convert beside Extract text: all three read what is printed on
// a page or photo, while Scan holds the capture modes.
export const TOOL_SECTIONS: ToolSection[] = [
  { title: 'Scan', tools: ['whiteboard', 'book', 'id-card', 'business-card'] },
  { title: 'Edit', tools: ['sign', 'redact', 'watermark', 'timestamp'] },
  { title: 'Pages', tools: ['merge', 'create-pdf', 'split', 'extract'] },
  { title: 'PDF', tools: ['compress', 'unrestrict', 'protect', 'flatten'] },
  { title: 'Convert', tools: ['extract-text', 'find-text', 'qr', 'long-image', 'erase-marks'] },
];

/** Home's Tools row: everyday tools, one tap away (every tool is in the Tools tab). */
export const HOME_TOOLS: ToolId[] = ['sign', 'id-card', 'extract-text', 'watermark'];

/** Where a catalogue tool opens from the Tools tab or Home (no document chosen). */
export function toolHref(id: ToolId): Href {
  const route = TOOLS[id].route;
  if (!route) throw new Error(`${id} only opens on a document`);
  return (route.params ? { pathname: route.pathname, params: route.params } : route.pathname) as Href;
}

/**
 * Where a tool opens on the document in the viewer: its route with `docId`
 * (the tool preselects that document, is presented over the viewer and goes
 * back to it when done — components/tool-doc.tsx) and `page`, the page on
 * screen, for the tools that start on a page (Sign, Redact).
 */
export function toolHrefForDocument(id: ToolId, docId: string, page?: number): Href {
  const route = TOOLS[id].route;
  if (!route) throw new Error(`${id} runs in the viewer`);
  const params: Record<string, string> = { ...(route.params ?? {}), docId };
  if (page != null && Number.isFinite(page) && page >= 0) params.page = String(Math.floor(page));
  return { pathname: route.pathname, params } as unknown as Href;
}

/**
 * A tool's `page` route param as a page index for a document of `pageCount`
 * pages: null when absent or not a number, else clamped onto the document.
 */
export function parsePageParam(raw: unknown, pageCount: number): number | null {
  if (typeof raw !== 'string' || raw.trim() === '' || pageCount < 1) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(Math.floor(n), pageCount - 1));
}

// ── Tools for an open document ───────────────────────────────────────────────

export type DocToolContext = {
  /** A scanned (image-page) document, or an imported PDF. */
  kind: 'scan' | 'pdf';
  /** Pages (for a PDF, as its view reports; 0 until it has loaded). */
  pageCount: number;
  /** The PDF needs a password (locked now, or unlocked only for this session). */
  passwordProtected?: boolean;
  /** The PDF can't be shown (locked, damaged): only what fixes that is offered. */
  unreadable?: boolean;
  /** What this build, and this PDF, allow (the native checks live in the viewer). */
  can: {
    ocr?: boolean;
    protect?: boolean;
    /** Fill & sign is offered for this PDF (the build has it and its author allows it). */
    fill?: boolean;
    /** Pages of this PDF can be edited right now (split). */
    editPdfPages?: boolean;
    mergePdf?: boolean;
    unrestrict?: boolean;
    flatten?: boolean;
    convertPdf?: boolean;
  };
};

/**
 * The tools that apply to an open document, grouped like the Tools tab (same
 * section names, same order), empty sections left out.
 *
 * Scanned documents get every page tool; the ones that need two pages (Split,
 * Extract pages, Long image) only when there are two. Imported PDFs get what
 * works on the PDF as it is — Fill & sign, Merge, Split, Protect / Unlock /
 * Flatten — plus Convert to pages ("Edit as pages"), which opens the page
 * tools to them, in two rows (Edit, PDF) rather than four thin sections. Sign,
 * Redact, Watermark and Timestamp aren't offered for a PDF: they'd have to
 * convert it first (the "…" menu's Convert to pages says so plainly).
 */
export function documentToolSections(ctx: DocToolContext): ToolSection[] {
  const { can } = ctx;
  const multi = ctx.pageCount > 1;
  const pick = (entries: [ToolId, boolean | undefined][]) => entries.filter(([, ok]) => !!ok).map(([id]) => id);

  const sections: ToolSection[] =
    ctx.kind === 'scan'
      ? [
          { title: 'Edit', tools: ['sign', 'redact', 'watermark', 'timestamp'] },
          { title: 'Pages', tools: pick([['merge', true], ['split', multi], ['extract', multi], ['long-image', multi]]) },
          {
            title: 'Convert',
            tools: pick([['extract-text', can.ocr], ['find-text', can.ocr], ['erase-marks', true], ['compress', true], ['protect', can.protect]]),
          },
        ]
      : ctx.unreadable
        ? // A PDF that won't open: Unlock PDF removes its password for good (it asks for it).
          [{ title: 'PDF', tools: pick([['unrestrict', ctx.passwordProtected && can.unrestrict]]) }]
        : [
            // One row, not three thin ones: a PDF has few tools per Tools-tab section.
            {
              title: 'Edit',
              tools: pick([
                ['fill', can.fill],
                ['convert-pages', can.convertPdf],
                ['merge', can.mergePdf],
                ['split', can.editPdfPages && multi],
              ]),
            },
            {
              title: 'PDF',
              tools: pick([
                // A PDF that already needs a password isn't offered: Unlock PDF removes it first.
                ['protect', can.protect && !ctx.passwordProtected],
                ['unrestrict', can.unrestrict],
                ['flatten', can.flatten],
                // Searches the PDF's pages as they are (it reads them; nothing changes).
                ['find-text', can.ocr],
              ]),
            },
          ];
  return sections.filter(s => s.tools.length > 0);
}

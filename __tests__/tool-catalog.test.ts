// __tests__/tool-catalog.test.ts
// The shared tool catalogue (lib/tool-catalog.ts): colours that stay legible in
// both themes, routes that exist, which tools an open document is offered, the
// page a tool opens on — and the viewer toolbar's scrolling layout
// (lib/toolbar-layout.ts).
import * as fs from 'fs';
import * as path from 'path';
import {
  blendHex,
  contrastRatio,
  documentToolSections,
  HOME_TOOLS,
  parsePageParam,
  TOOL_HUES,
  TOOL_SECTIONS,
  TOOLS,
  toolHref,
  toolHrefForDocument,
  toolSwatch,
  type DocToolContext,
  type ToolHue,
  type ToolId,
} from '../lib/tool-catalog';
import { toolbarLayout, TOOLBAR_PEEK } from '../lib/toolbar-layout';
import { Colors } from '../lib/theme';

const ids = (sections: { tools: ToolId[] }[]) => sections.flatMap(s => s.tools);

describe('tool colours', () => {
  const hues = Object.keys(TOOL_HUES) as ToolHue[];

  test.each(hues)('%s icon reads on its own tile (≥ 4.5:1) in light and dark', hue => {
    for (const dark of [false, true]) {
      const { fg, bg } = toolSwatch(hue, dark);
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
      // And on the bare card, e.g. the "…" sheet's tiles, which colour only the glyph.
      expect(contrastRatio(fg, Colors[dark ? 'dark' : 'light'].card)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('tiles are a pale wash of the hue over the card, not the card itself', () => {
    const { bg: light } = toolSwatch('blue', false);
    const { bg: dark } = toolSwatch('blue', true);
    expect(light).not.toBe(Colors.light.card);
    expect(dark).not.toBe(Colors.dark.card);
    expect(contrastRatio(light, Colors.light.card)).toBeLessThan(1.25);
  });

  test('blend and contrast helpers', () => {
    expect(blendHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1);
  });

  test('neighbours in a row never share a hue (Tools tab and Home)', () => {
    for (const row of [...TOOL_SECTIONS.map(s => s.tools), HOME_TOOLS]) {
      for (let i = 1; i < row.length; i++) expect(TOOLS[row[i]].hue).not.toBe(TOOLS[row[i - 1]].hue);
    }
  });

  test('neighbours in the viewer sheet rows never share a hue', () => {
    const all = { ocr: true, protect: true, fill: true, mergePdf: true, editPdfPages: true, unrestrict: true, flatten: true, convertPdf: true };
    const sheets = [
      ...documentToolSections({ kind: 'scan', pageCount: 3, can: all }),
      ...documentToolSections({ kind: 'pdf', pageCount: 3, can: all }),
    ];
    for (const s of sheets) {
      for (let i = 1; i < s.tools.length; i++) expect(TOOLS[s.tools[i]].hue).not.toBe(TOOLS[s.tools[i - 1]].hue);
    }
  });
});

describe('catalogue', () => {
  test('every Tools tab section fills rows of four (only Convert runs on), each tool once', () => {
    for (const s of TOOL_SECTIONS) expect(s.tools).toHaveLength(s.title === 'Convert' ? 5 : 4);
    const all = ids(TOOL_SECTIONS);
    expect(new Set(all).size).toBe(all.length);
  });

  test('labels fit a tile: short enough for one line at 12pt', () => {
    for (const t of Object.values(TOOLS)) expect(t.label.length).toBeLessThanOrEqual(14);
  });

  test('every routed tool opens a screen that exists', () => {
    for (const t of Object.values(TOOLS)) {
      if (!t.route) continue;
      const file = path.join(__dirname, '..', 'app', `${t.route.pathname.replace(/^\//, '')}.tsx`);
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  test('the Tools tab and Home only list tools with a screen', () => {
    for (const id of [...ids(TOOL_SECTIONS), ...HOME_TOOLS]) expect(TOOLS[id].route).not.toBeNull();
    expect(() => toolHref('fill')).toThrow();
  });

  test('hrefs keep their fixed params and add the document and page', () => {
    expect(toolHref('sign')).toBe('/tools/sign');
    expect(toolHref('compress')).toEqual({ pathname: '/tools/compress', params: { mode: 'pdf' } });
    expect(toolHrefForDocument('compress', 'd1', 2)).toEqual({
      pathname: '/tools/compress',
      params: { mode: 'pdf', docId: 'd1', page: '2' },
    });
    expect(toolHrefForDocument('protect', 'd1')).toEqual({ pathname: '/tools/protect', params: { docId: 'd1' } });
    expect(toolHrefForDocument('sign', 'd1', -1)).toEqual({ pathname: '/tools/sign', params: { docId: 'd1' } });
    expect(() => toolHrefForDocument('convert-pages', 'd1')).toThrow();
  });

  test('page params are read safely and clamped onto the document', () => {
    expect(parsePageParam(undefined, 3)).toBeNull();
    expect(parsePageParam('', 3)).toBeNull();
    expect(parsePageParam('abc', 3)).toBeNull();
    expect(parsePageParam(['1'], 3)).toBeNull();
    expect(parsePageParam('1', 3)).toBe(1);
    expect(parsePageParam('9', 3)).toBe(2);
    expect(parsePageParam('-4', 3)).toBe(0);
    expect(parsePageParam('1.7', 3)).toBe(1);
    expect(parsePageParam('0', 0)).toBeNull();
  });
});

describe('tools for an open document', () => {
  const scan = (pageCount: number, can: DocToolContext['can'] = { ocr: true, protect: true }) =>
    documentToolSections({ kind: 'scan', pageCount, can });
  const pdf = (over: Partial<DocToolContext> = {}, can: DocToolContext['can'] = {}) =>
    documentToolSections({
      kind: 'pdf',
      pageCount: 4,
      ...over,
      can: { fill: true, mergePdf: true, editPdfPages: true, protect: true, unrestrict: true, flatten: true, convertPdf: true, ...can },
    });

  test('a scanned document gets every page tool, grouped like the Tools tab', () => {
    const sections = scan(3);
    expect(sections.map(s => s.title)).toEqual(['Edit', 'Pages', 'Convert']);
    expect(ids(sections)).toEqual([
      'sign', 'redact', 'watermark', 'timestamp',
      'merge', 'split', 'extract', 'long-image',
      'extract-text', 'find-text', 'erase-marks', 'compress', 'protect',
    ]);
  });

  test('a one-page scan leaves out what needs two pages', () => {
    const all = ids(scan(1));
    expect(all).not.toContain('split');
    expect(all).not.toContain('extract');
    expect(all).not.toContain('long-image');
    expect(all).toContain('merge');
  });

  test('what the build lacks is left out', () => {
    const all = ids(scan(2, {}));
    expect(all).not.toContain('extract-text');
    expect(all).not.toContain('find-text');
    expect(all).not.toContain('protect');
  });

  test('an imported PDF gets what works on the PDF as it is', () => {
    const sections = pdf();
    expect(sections.map(s => s.title)).toEqual(['Edit', 'PDF']);
    expect(ids(sections)).toEqual(['fill', 'convert-pages', 'merge', 'split', 'protect', 'unrestrict', 'flatten']);
    // With text recognition, Find text too: it only reads the pages.
    expect(ids(pdf({}, { ocr: true }))).toContain('find-text');
    // Never the image-only tools: they would have to convert it first.
    for (const id of ['sign', 'redact', 'watermark', 'timestamp', 'erase-marks', 'compress', 'long-image'] as ToolId[]) {
      expect(ids(sections)).not.toContain(id);
    }
  });

  test('a protected PDF is not offered Protect; a one-page PDF not Split', () => {
    expect(ids(pdf({ passwordProtected: true }))).not.toContain('protect');
    expect(ids(pdf({ pageCount: 1 }))).not.toContain('split');
  });

  test('a PDF that will not open offers only Unlock PDF, and only when it is locked', () => {
    expect(ids(pdf({ unreadable: true, passwordProtected: true }))).toEqual(['unrestrict']);
    expect(pdf({ unreadable: true })).toEqual([]);
  });

  test('empty sections are dropped', () => {
    const sections = pdf({}, { protect: false, unrestrict: false, flatten: false });
    expect(sections.map(s => s.title)).toEqual(['Edit']);
  });
});

describe('viewer toolbar layout', () => {
  test('items that fit share the width, without scrolling', () => {
    expect(toolbarLayout(320, 5, 64)).toEqual({ itemWidth: 64, scrolls: false });
    expect(toolbarLayout(400, 5, 64)).toEqual({ itemWidth: 80, scrolls: false });
  });

  test('items that do not fit scroll, never below the minimum, with the edge item cut part-way', () => {
    const available = 320;
    const { itemWidth, scrolls } = toolbarLayout(available, 7, 64);
    expect(scrolls).toBe(true);
    expect(itemWidth).toBeGreaterThanOrEqual(64);
    const visible = available / itemWidth;
    expect(visible % 1).toBeCloseTo(TOOLBAR_PEEK);
    expect(Math.floor(visible)).toBeLessThan(7);
  });

  test('larger text (a wider minimum) scrolls a row that fitted', () => {
    expect(toolbarLayout(320, 5, 64).scrolls).toBe(false);
    expect(toolbarLayout(320, 5, Math.round(64 * 1.3)).scrolls).toBe(true);
  });

  test('degenerate sizes', () => {
    expect(toolbarLayout(0, 3, 64).scrolls).toBe(false);
    expect(toolbarLayout(320, 0, 64).scrolls).toBe(false);
    expect(toolbarLayout(70, 3, 64).itemWidth).toBeGreaterThanOrEqual(64);
  });
});

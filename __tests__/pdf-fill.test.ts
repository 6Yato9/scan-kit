// __tests__/pdf-fill.test.ts
// Fill & sign (lib/pdf-fill.ts): the display-space ↔ PDF-space conversion
// (crop box, all four page rotations), what is sent to native for each kind
// of addition and form field, the messages, and the save path's refusal of a
// PDF that changed since the screen read it.
const mockRewrite = jest.fn();
const mockPrints = new Map<string, { size: number; md5: string }>();
jest.mock('../lib/pdf-edit', () => {
  class PdfEditError extends Error {
    kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.kind = kind;
    }
  }
  return {
    PdfEditError,
    rewriteStoredPdf: (...args: unknown[]) => mockRewrite(...args),
    undoPdfEdit: jest.fn(async () => ({ id: 'd1' })),
    filePrint: (uri: string) => mockPrints.get(uri) ?? { size: null, md5: null },
    samePrint: (a: { size: number; md5: string }, b: { size: number; md5: string }) =>
      a.size !== null && a.size === b.size && a.md5 === b.md5,
  };
});
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(p => (typeof p === 'string' ? p : p.uri)).join('/'); }
    get exists() { return true; }
  }
  class MockDirectory extends MockFile {
    create() {}
    delete() {}
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { cache: { uri: 'file:///caches' } } };
});
const mockNative: any = {
  pdfFill: jest.fn(async () => 3),
  pdfFillInfo: jest.fn(),
  pdfRenderPage: jest.fn(),
  replaceFile: jest.fn(),
};
jest.mock('../modules/vision-ocr/src', () => ({ get VisionOcr() { return mockNative; } }));

import {
  clampRect,
  displayPointToPage,
  displayRectToPage,
  displaySize,
  fieldLabel,
  fillMessage,
  fillStoredPdf,
  firstChangedPage,
  normalizeRotation,
  pageGeometry,
  pagePointToDisplay,
  pageRectToDisplay,
  planFieldValues,
  planMarks,
  stepFontSize,
  subscribePdfRewrites,
  takePendingRewrite,
  textPadding,
  toggleButton,
  type FillMark,
  type PageGeometry,
} from '../lib/pdf-fill';
import { SIGNATURE_INK } from '../lib/stamp';
import type { NativeFillField, NativeFillPage } from '../modules/vision-ocr/src';

const LETTER = { crop: [0, 0, 612, 792], media: [0, 0, 612, 792] };
const page = (rotation: number, crop = LETTER.crop): NativeFillPage => ({ crop, media: LETTER.media, rotation });
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe('geometry', () => {
  test('rotation is one of four turns, whatever the sign or size', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-180)).toBe(180);
    expect(normalizeRotation(720)).toBe(0);
  });

  test('a quarter turn swaps the shown width and height', () => {
    expect(displaySize(pageGeometry(page(0)))).toEqual({ width: 612, height: 792 });
    expect(displaySize(pageGeometry(page(90)))).toEqual({ width: 792, height: 612 });
    expect(displaySize(pageGeometry(page(270)))).toEqual({ width: 792, height: 612 });
    expect(displaySize(pageGeometry(page(180)))).toEqual({ width: 612, height: 792 });
  });

  test('upright page: the top-left of the screen is the top-left of the page (PDF y goes up)', () => {
    const g = pageGeometry(page(0));
    close(displayPointToPage(0, 0, g), [0, 792]);
    close(displayRectToPage({ x: 0.1, y: 0.05, w: 0.5, h: 0.03 }, g), [61.2, 792 - 0.08 * 792, 306, 0.03 * 792]);
  });

  test('the crop box is what is shown: rects are relative to it, not to the media box', () => {
    const g = pageGeometry(page(0, [60, 80, 512, 612]));
    expect(displaySize(g)).toEqual({ width: 512, height: 612 });
    close(displayRectToPage({ x: 0, y: 0, w: 1, h: 1 }, g), [60, 80, 512, 612]);
    // Top-left corner of what is shown is the crop box's top-left in PDF space.
    close(displayPointToPage(0, 0, g), [60, 692]);
    close(displayRectToPage({ x: 0.5, y: 0.5, w: 0.25, h: 0.25 }, g), [60 + 256, 80 + 612 * 0.25, 128, 153]);
  });

  test('page turned 90° clockwise: the screen’s top-left is the page’s bottom-left', () => {
    // Proven with poppler, Ghostscript and Quick Look renders of a written file
    // (scratchpad r13pdf/exp): text placed at the shown top-left reads upright there.
    const g = pageGeometry(page(90));
    close(displayPointToPage(0, 0, g), [0, 0]);
    close(displayPointToPage(792, 0, g), [0, 792]);
    close(displayPointToPage(0, 612, g), [612, 0]);
    close(displayRectToPage({ x: 0.08, y: 0.03, w: 0.6, h: 0.03 }, g), [0.03 * 612, 0.08 * 792, 0.03 * 612, 0.6 * 792]);
  });

  test('page turned 180°: the screen’s top-left is the page’s bottom-right', () => {
    const g = pageGeometry(page(180));
    close(displayPointToPage(0, 0, g), [612, 0]);
    close(displayPointToPage(612, 792, g), [0, 792]);
  });

  test('page turned 270°: the screen’s top-left is the page’s top-right', () => {
    const g = pageGeometry(page(270));
    close(displayPointToPage(0, 0, g), [612, 792]);
    close(displayPointToPage(792, 0, g), [612, 0]);
    close(displayPointToPage(0, 612, g), [0, 792]);
  });

  test('display → page → display is the identity, for every rotation, with a crop box', () => {
    const rects = [
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 0.1, y: 0.7, w: 0.33, h: 0.05 },
      { x: 0.62, y: 0.12, w: 0.2, h: 0.4 },
    ];
    for (const rot of [0, 90, 180, 270]) {
      const g: PageGeometry = pageGeometry(page(rot, [60, 80, 512, 612]));
      for (const r of rects) {
        const back = pageRectToDisplay(displayRectToPage(r, g), g);
        close([back.x, back.y, back.w, back.h], [r.x, r.y, r.w, r.h]);
        const [u, v] = pagePointToDisplay(...displayPointToPage(10, 20, g), g);
        close([u, v], [10, 20]);
      }
    }
  });

  test('a form field in PDF space lands where the page shows it', () => {
    // The "Full name" field of the test form: x 160, y 638, 300 × 20 on a Letter page.
    const r = pageRectToDisplay([160, 638, 300, 20], pageGeometry(page(0)));
    close([r.x, r.y, r.w, r.h], [160 / 612, (792 - 658) / 792, 300 / 612, 20 / 792]);
  });

  test('clampRect shortens a box hanging off the page, never moves it', () => {
    expect(clampRect({ x: 0.9, y: 0.95, w: 0.3, h: 0.1 })).toEqual({ x: 0.9, y: 0.95, w: expect.closeTo(0.1, 9), h: expect.closeTo(0.05, 9) });
    expect(clampRect({ x: -0.1, y: 0.2, w: 0.3, h: 0.1 })).toEqual({ x: 0, y: 0.2, w: 0.3, h: 0.1 });
  });
});

const mark = (over: Partial<FillMark>): FillMark => ({ id: 'm', page: 0, kind: 'text', x: 0.1, y: 0.1, w: 0.2, h: 0.02, ink: 'black', ...over });

describe('planMarks', () => {
  const pages = [page(0), page(90)];

  test('text: its box gets room for the last letter and descenders, in its ink and size', () => {
    const [m] = planMarks([mark({ text: 'Jane Doe', fontSize: 14 })], pages);
    const pad = textPadding(14);
    const g = pageGeometry(pages[0]);
    const plain = displayRectToPage({ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }, g);
    expect(m).toMatchObject({ page: 0, kind: 'text', text: 'Jane Doe', fontSize: 14, color: SIGNATURE_INK.black });
    expect(m.rect[2]).toBeCloseTo(plain[2] + pad.right, 6);
    expect(m.rect[3]).toBeCloseTo(plain[3] + pad.bottom, 6);
    // Padding grows the box right and down on screen: its top-left stays put.
    expect(m.rect[0]).toBeCloseTo(plain[0], 6);
    expect(m.rect[1] + m.rect[3]).toBeCloseTo(plain[1] + plain[3], 6);
  });

  test('a date is text; empty text is dropped; trailing blank lines are trimmed', () => {
    const out = planMarks([
      mark({ kind: 'date', text: 'Nov 19, 2026' }),
      mark({ text: '   ' }),
      mark({ text: 'Two\nlines\n\n' }),
    ], pages);
    expect(out.map(m => m.text)).toEqual(['Nov 19, 2026', 'Two\nlines']);
    expect(out.every(m => m.kind === 'text')).toBe(true);
  });

  test('check, cross and signature, on a turned page, in blue ink', () => {
    const sig = { dataUri: 'data:image/png;base64,AAAA', width: 300, height: 100 };
    const out = planMarks([
      mark({ kind: 'check', page: 1, ink: 'blue', w: 0.03, h: 0.04 }),
      mark({ kind: 'cross', page: 1 }),
      mark({ kind: 'signature', page: 1, signature: sig, ink: 'blue' }),
      mark({ kind: 'initials', page: 1 }), // no image: nothing to draw
    ], pages);
    expect(out.map(m => m.kind)).toEqual(['check', 'cross', 'image']);
    expect(out[0].color).toBe(SIGNATURE_INK.blue);
    expect(out[2]).toMatchObject({ image: sig.dataUri, color: SIGNATURE_INK.blue, page: 1 });
    close(out[0].rect, displayRectToPage({ x: 0.1, y: 0.1, w: 0.03, h: 0.04 }, pageGeometry(pages[1])));
  });

  test('marks on a page that does not exist are dropped', () => {
    expect(planMarks([mark({ page: 5, text: 'x' })], pages)).toEqual([]);
  });
});

const field = (over: Partial<NativeFillField>): NativeFillField => ({
  id: '0:0', page: 0, name: 'f', kind: 'text', rect: [0, 0, 10, 10], readOnly: false, fontSize: 0, value: '', ...over,
});

describe('form fields', () => {
  const fields = [
    field({ id: '0:0', name: 'name', value: '' }),
    field({ id: '0:1', name: 'zip', value: '', maxLength: 5 }),
    field({ id: '0:2', name: 'agree', kind: 'checkbox', on: false }),
    field({ id: '0:3', name: 'pets', kind: 'radio', on: false, onValue: 'yes' }),
    field({ id: '0:4', name: 'pets', kind: 'radio', on: true, onValue: 'no' }),
    field({ id: '1:0', page: 1, name: 'locked', readOnly: true }),
    field({ id: '1:1', page: 1, name: 'country', kind: 'choice', value: 'Choose', options: ['Choose', 'France'] }),
  ];

  test('only what changed is sent; read-only fields never are; max length is kept', () => {
    const out = planFieldValues(fields, {
      '0:0': { value: 'Jane' },
      '0:1': { value: '1234567' },
      '1:0': { value: 'nope' },
      '1:1': { value: 'Choose' }, // unchanged
    });
    expect(out).toEqual([
      { id: '0:0', name: 'name', kind: 'text', value: 'Jane' },
      { id: '0:1', name: 'zip', kind: 'text', value: '12345' },
    ]);
  });

  test('a checkbox toggles; a radio button is chosen and its group cleared', () => {
    let edits = toggleButton(fields[2], fields, {});
    expect(edits['0:2']).toEqual({ on: true });
    edits = toggleButton(fields[2], fields, edits);
    expect(edits['0:2']).toEqual({ on: false });
    edits = toggleButton(fields[3], fields, {});
    expect(edits).toEqual({ '0:3': { on: true }, '0:4': { on: false } });
  });

  test('a changed radio group is sent whole, so native knows which one is chosen', () => {
    const edits = toggleButton(fields[3], fields, {});
    const out = planFieldValues(fields, edits);
    expect(out).toEqual(expect.arrayContaining([
      { id: '0:3', name: 'pets', kind: 'radio', on: true },
      { id: '0:4', name: 'pets', kind: 'radio', on: false },
    ]));
    expect(out).toHaveLength(2);
  });

  test('a checkbox put back as it was is not sent', () => {
    expect(planFieldValues(fields, { '0:2': { on: false } })).toEqual([]);
  });

  test('first changed page: marks and fields', () => {
    expect(firstChangedPage([mark({ page: 2, text: 'x' })], [{ id: '1:1', name: 'country', kind: 'choice', value: 'France' }], fields, 0)).toBe(1);
    expect(firstChangedPage([], [], fields, 3)).toBe(3);
  });
});

describe('messages and sizes', () => {
  const sig = { dataUri: 'data:image/png;base64,AAAA', width: 3, height: 1 };
  test('what the toast says', () => {
    expect(fillMessage([mark({ kind: 'signature', signature: sig })], 0)).toBe('Signed');
    expect(fillMessage([mark({ kind: 'signature', signature: sig }), mark({ text: 'x' })], 0)).toBe('Filled in and signed');
    expect(fillMessage([mark({ kind: 'initials', signature: sig })], 2)).toBe('Filled in and signed');
    expect(fillMessage([], 2)).toBe('Form filled in');
    expect(fillMessage([mark({ kind: 'check' })], 0)).toBe('Filled in');
    expect(fillMessage([mark({ text: '  ' })], 1)).toBe('Form filled in');
  });

  test('font size steps along the scale and stops at its ends', () => {
    expect(stepFontSize(12, 1)).toBe(14);
    expect(stepFontSize(12, -1)).toBe(11);
    expect(stepFontSize(13, -1)).toBe(12);
    expect(stepFontSize(40, 1)).toBe(40);
    expect(stepFontSize(8, -1)).toBe(8);
  });
});

describe('fillStoredPdf', () => {
  const session = {
    info: { pageCount: 3, encrypted: false, canAnnotate: true, canFillForms: true, pages: [page(0), page(90), page(0)], fields: [field({ id: '0:0', name: 'name' })] },
    print: { size: 10, md5: 'aaa' },
  };
  beforeEach(() => {
    mockRewrite.mockReset();
    mockNative.pdfFill.mockClear();
    mockRewrite.mockImplementation(async (_id: string, write: (t: string, o: string) => Promise<number>, expected: number) => {
      const n = await write('file:///docs/d1/document.pdf', 'file:///work/after.pdf');
      return { doc: { id: 'd1' }, pageCount: n, undo: null, expected };
    });
  });

  test('writes the planned fields and marks through the crash-safe rewrite, and tells the viewer', async () => {
    mockPrints.set('file:///docs/d1/document.pdf', { size: 10, md5: 'aaa' });
    const seen: [string, number][] = [];
    const off = subscribePdfRewrites((id, p) => seen.push([id, p]));
    const res: any = await fillStoredPdf('d1', 'file:///docs/d1/document.pdf?v=3', session as any, [mark({ text: 'Hi' })], { '0:0': { value: 'Jane' } }, 1);
    off();
    expect(res.expected).toBe(3);
    const [target, out, fields, marks] = mockNative.pdfFill.mock.calls[0];
    expect([target, out]).toEqual(['file:///docs/d1/document.pdf', 'file:///work/after.pdf']);
    expect(fields).toEqual([{ id: '0:0', name: 'name', kind: 'text', value: 'Jane' }]);
    expect(marks).toHaveLength(1);
    expect(seen).toEqual([['d1', 1]]);
    // A viewer opened afterwards (Fill & sign from Tools) shows that page, once.
    expect(takePendingRewrite('other')).toBeNull();
    expect(takePendingRewrite('d1')).toBe(1);
    expect(takePendingRewrite('d1')).toBeNull();
  });

  test('refuses when the PDF is no longer what the screen read', async () => {
    mockPrints.set('file:///docs/d1/document.pdf', { size: 11, md5: 'bbb' });
    await expect(fillStoredPdf('d1', 'file:///docs/d1/document.pdf', session as any, [mark({ text: 'Hi' })], {}, 0))
      .rejects.toMatchObject({ kind: 'changed' });
    expect(mockNative.pdfFill).not.toHaveBeenCalled();
  });

  test('nothing to save is not a write; permissions drop what is not allowed', async () => {
    mockPrints.set('file:///docs/d1/document.pdf', { size: 10, md5: 'aaa' });
    await expect(fillStoredPdf('d1', 'file:///docs/d1/document.pdf', session as any, [mark({ text: ' ' })], {}, 0))
      .rejects.toMatchObject({ kind: 'failed' });
    const formOnly = { ...session, info: { ...session.info, canAnnotate: false } };
    await expect(fillStoredPdf('d1', 'file:///docs/d1/document.pdf', formOnly as any, [mark({ text: 'Hi' })], {}, 0))
      .rejects.toMatchObject({ kind: 'failed' });
    expect(mockRewrite).not.toHaveBeenCalled();
  });
});

describe('fieldLabel', () => {
  test('the form’s description first, else a readable name', () => {
    expect(fieldLabel({ name: 'x', label: 'Applicant’s full name' })).toBe('Applicant’s full name');
    expect(fieldLabel({ name: 'full_name' })).toBe('Full name');
    expect(fieldLabel({ name: 'dateOfBirth' })).toBe('Date of birth');
    expect(fieldLabel({ name: 'page1.applicant.email-address' })).toBe('Email address');
    expect(fieldLabel({ name: 'Text1[0]' })).toBe('Text1');
    expect(fieldLabel({ name: '' })).toBe('Field');
  });
});

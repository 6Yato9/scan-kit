// lib/id-card-sheet.ts: ID card on one page (r12 research #2) — the card is
// drawn at its real size, 85.6 × 53.98 mm, on the user's paper.
import { buildIdCardSheetHtml, cardWidthMm, ID1_MM, planIdCardSheet, sheetPaperFor, SHEET_DPI } from '../lib/id-card-sheet';

const mm = (px: number) => (px / SHEET_DPI) * 25.4;

test('A4 at 300 dpi, both sides at real size, centred in the top and bottom halves', () => {
  const plan = planIdCardSheet([{ width: 1700, height: 1072 }, { width: 1700, height: 1072 }], 'A4');
  expect(plan.width).toBe(2480);
  expect(plan.height).toBe(3508);
  expect(plan.width / plan.height).toBeCloseTo(210 / 297, 3);
  for (const c of plan.cards) {
    expect(mm(c.width)).toBeCloseTo(ID1_MM.width, 1);
    expect(mm(c.height)).toBeCloseTo(ID1_MM.height, 1);
    expect(Math.abs(c.x + c.width / 2 - plan.width / 2)).toBeLessThanOrEqual(1);
    expect(c.rotate).toBe(false);
  }
  const [front, back] = plan.cards;
  expect(Math.abs(front.y + front.height / 2 - plan.height / 4)).toBeLessThanOrEqual(1);
  expect(Math.abs(back.y + back.height / 2 - (plan.height * 3) / 4)).toBeLessThanOrEqual(1);
  expect(front.y + front.height).toBeLessThan(plan.height / 2);
  expect(back.y).toBeGreaterThan(plan.height / 2);
  expect(cardWidthMm(plan)).toBeCloseTo(85.6, 1);
});

test('Letter paper keeps the card at 85.6 mm', () => {
  const plan = planIdCardSheet([{ width: 800, height: 500 }], 'Letter');
  expect(mm(plan.width)).toBeCloseTo(215.9, 0);
  expect(mm(plan.height)).toBeCloseTo(279.4, 0);
  expect(cardWidthMm(plan)).toBeCloseTo(85.6, 1);
});

test('front only: one card, centred in the top half', () => {
  const plan = planIdCardSheet([{ width: 800, height: 500 }]);
  expect(plan.cards).toHaveLength(1);
  expect(Math.abs(plan.cards[0].y + plan.cards[0].height / 2 - plan.height / 4)).toBeLessThanOrEqual(1);
});

test('an upright capture is turned to lie landscape, still at real size', () => {
  const plan = planIdCardSheet([{ width: 500, height: 800 }]);
  expect(plan.cards[0].rotate).toBe(true);
  expect(mm(plan.cards[0].width)).toBeCloseTo(85.6, 1);
});

test('paper comes from Document settings; Auto and unknown mean A4', () => {
  expect(sheetPaperFor('Letter')).toBe('Letter');
  expect(sheetPaperFor('A4')).toBe('A4');
  expect(sheetPaperFor('Legal')).toBe('Letter');
  expect(sheetPaperFor('Auto')).toBe('A4');
  expect(sheetPaperFor(undefined)).toBe('A4');
});

test('the sheet fits the WebKit canvas budget and the HTML carries the plan', () => {
  const plan = planIdCardSheet([{ width: 1, height: 1 }, { width: 1, height: 1 }], 'Letter');
  expect(plan.width * plan.height).toBeLessThan(15_000_000);
  const html = buildIdCardSheetHtml(['file:///a.jpg', 'file:///b.jpg'], plan);
  expect(html).toContain('"file:///a.jpg"');
  expect(html).toContain(`"width":${plan.width}`);
  expect(html).toContain("toDataURL('image/jpeg'");
});

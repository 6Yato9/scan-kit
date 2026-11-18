// __tests__/r7-ui.test.tsx
// Pure helpers behind the round-7 UI: fitting landscape pages into thumbnail
// tiles, keeping a spaced dash with the word before it, remembering a hidden
// convert suggestion, and detecting the native PDF view.
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn() }));
jest.mock('expo', () => ({ ...jest.requireActual('expo'), requireNativeView: jest.fn(() => () => null) }));
jest.mock('../contexts/theme-context', () => ({ useTheme: () => ({ colors: {} }) }));

import { thumbFit } from '../components/page-thumb';
import { dropLastWord, glueDashes } from '../components/word-clamp-text';
import { withDismissed } from '../components/pdf-convert-banner';
import { hasNativePdfView } from '../modules/vision-ocr/src/PdfDocumentView';

const TILE = 0.75; // the 3:4 portrait tiles of cards and the page strip

describe('thumbFit', () => {
  it('fills the tile with portrait pages, including tall receipts', () => {
    expect(thumbFit(1 / Math.SQRT2, TILE)).toBe('cover'); // A4
    expect(thumbFit(8.5 / 11, TILE)).toBe('cover'); // Letter
    expect(thumbFit(0.3, TILE)).toBe('cover'); // receipt
  });

  it('fits a landscape page whole instead of cutting it to its middle', () => {
    expect(thumbFit(Math.SQRT2, TILE)).toBe('contain');
    expect(thumbFit(1.5, TILE)).toBe('contain');
    expect(thumbFit(1, TILE)).toBe('contain'); // square page in a portrait tile
  });

  it('fills until the sizes are known', () => {
    expect(thumbFit(undefined, TILE)).toBe('cover');
    expect(thumbFit(1.5, undefined)).toBe('cover');
    expect(thumbFit(NaN, TILE)).toBe('cover');
  });
});

describe('glueDashes', () => {
  it('makes the space before a spaced dash non-breaking', () => {
    expect(glueDashes('Invoice 4471 - Project Atlas')).toBe('Invoice 4471 - Project Atlas');
    expect(glueDashes('Lease – renewal — notice')).toBe('Lease – renewal — notice');
  });

  it('leaves hyphenated words and trailing dashes alone', () => {
    expect(glueDashes('Scan 18-11-2026 00:26')).toBe('Scan 18-11-2026 00:26');
    expect(glueDashes('Re-scan -')).toBe('Re-scan -');
  });

  it('still drops the dash with the last word when clamping', () => {
    expect(dropLastWord(glueDashes('Invoice 4471 - Project'))).toBe('Invoice 4471');
  });
});

describe('withDismissed', () => {
  it('adds an id once, newest last', () => {
    expect(withDismissed(['a', 'b'], 'a')).toEqual(['b', 'a']);
    expect(withDismissed([], 'x')).toEqual(['x']);
  });

  it('keeps only the newest ids', () => {
    expect(withDismissed(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });
});

describe('hasNativePdfView', () => {
  it('is true only when the build registers the VisionOcr view', () => {
    expect(hasNativePdfView({ getViewConfig: name => (name === 'VisionOcr' ? { validAttributes: {} } : null) })).toBe(true);
    // An older build: the module exists but has no view.
    expect(hasNativePdfView({ getViewConfig: () => null })).toBe(false);
    expect(hasNativePdfView({})).toBe(false);
    expect(hasNativePdfView(undefined)).toBe(false);
    expect(hasNativePdfView({ getViewConfig: () => { throw new Error('no'); } })).toBe(false);
  });
});

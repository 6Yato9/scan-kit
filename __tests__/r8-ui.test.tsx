// __tests__/r8-ui.test.tsx
// Pure helpers behind the round-8 UI: the export sheet's "Text" row detail,
// and the heights the Filters panel animates between (so the page above never jumps).
jest.mock('expo-file-system', () => ({ File: class {}, Directory: class {}, Paths: { document: 'file:///d' } }));
jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }));
jest.mock('jszip', () => jest.fn());
jest.mock('../lib/ocr', () => ({ ocrAvailable: () => true, recognizeLines: jest.fn() }));
jest.mock('../lib/storage', () => ({ getDocSettings: jest.fn() }));
jest.mock('../lib/share', () => ({}));
jest.mock('../lib/pdf', () => ({}));
jest.mock('../lib/photos', () => ({}));
jest.mock('../lib/bake', () => ({ bakePreviews: jest.fn(), PREVIEW_FILTERS: [] }));
jest.mock('../lib/bake-html', () => ({ PREVIEW_ASPECT: 0.5 }));
jest.mock('../lib/doc-size', () => ({ documentBytes: jest.fn() }));
jest.mock('../components/tool-ui', () => ({ formatBytes: (n: number) => String(n) }));
jest.mock('../components/bottom-sheet', () => ({}));
jest.mock('../components/primary-button', () => ({}));
jest.mock('../components/section-label', () => ({}));
jest.mock('../components/toast', () => ({ useToast: jest.fn() }));
jest.mock('../components/chrome-slider', () => ({ ChromeSlider: () => null }));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: () => null },
  Easing: { bezier: () => () => 0 },
  ReduceMotion: { System: 'system' },
  runOnJS: (fn: unknown) => fn,
  useAnimatedStyle: () => ({}),
  useSharedValue: (v: number) => ({ value: v }),
  withTiming: (v: number) => v,
}));
jest.mock('../contexts/theme-context', () => ({ useTheme: () => ({ colors: {} }) }));

import { StyleSheet } from 'react-native';
import { textDetail } from '../components/export-sheet';
import { panelHeight, replacedBarsHeight } from '../components/page-actions-sheet';

describe('textDetail', () => {
  it('counts small amounts of text exactly', () => {
    expect(textDetail('Total')).toBe('Recognized text · 1 word');
    expect(textDetail('Invoice 2041\n\nTotal due  $120.00')).toBe('Recognized text · 5 words');
  });

  it('rounds longer text like the size estimates', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    expect(textDetail(words(243))).toBe('Recognized text · about 240 words');
    expect(textDetail(words(1260))).toBe('Recognized text · about 1,300 words');
  });
});

describe('replacedBarsHeight', () => {
  it('matches the toolbar and thumbnail strip the panel replaces', () => {
    // iPhone with a home indicator (34pt): 68 toolbar + 93 strip + 22 padding.
    // (plus the toolbar's hairline).
    const hairline = StyleSheet.hairlineWidth;
    expect(replacedBarsHeight(34)).toBeCloseTo(183 + hairline);
    // No home indicator: the strip keeps its 8pt minimum padding.
    expect(replacedBarsHeight(0)).toBeCloseTo(169 + hairline);
  });

  it('is shorter than the open panel, which the page shrinks to make room for', () => {
    // 8 + 44 top row + 8 + 182 content (four 44pt slider rows since R12's
    // Sharpness, 2pt apart) + inset + 8.
    expect(panelHeight(34)).toBe(284);
    expect(panelHeight(34)).toBeGreaterThan(replacedBarsHeight(34));
  });
});

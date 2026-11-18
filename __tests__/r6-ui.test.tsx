// __tests__/r6-ui.test.tsx
// Pure helpers behind the round-6 UI: moving a page in the strip, clamping a
// card's name at a word, and the export-all ZIP's name.
jest.mock('react-native-draggable-flatlist', () => ({ __esModule: true, default: () => null, ScaleDecorator: () => null }));
jest.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: () => null }));
jest.mock('expo-file-system', () => ({ File: class {}, Directory: class {}, Paths: { document: 'file:///d' } }));
jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }));
jest.mock('../lib/ocr', () => ({ ocrAvailable: () => true, recognizeLines: jest.fn() }));
jest.mock('../lib/storage', () => ({ getDocSettings: jest.fn() }));
jest.mock('../lib/share', () => ({}));
jest.mock('../components/tool-ui', () => ({ formatBytes: (n: number) => String(n) }));
jest.mock('../lib/doc-size', () => ({ documentsBytes: jest.fn() }));

import { movedOrder } from '../components/thumbnail-strip';
import { dropLastWord, firstCandidate } from '../components/word-clamp-text';
import { exportAllName } from '../components/multi-share-sheet';
import { uniqueNames } from '../lib/unique-names';

describe('movedOrder', () => {
  it('moves a page right or left, as old indices in their new places', () => {
    expect(movedOrder(4, 0, 2)).toEqual([1, 2, 0, 3]);
    expect(movedOrder(4, 3, 0)).toEqual([3, 0, 1, 2]);
    expect(movedOrder(2, 1, 0)).toEqual([1, 0]);
  });

  it('is the identity for no move or an index out of range', () => {
    expect(movedOrder(3, 1, 1)).toEqual([0, 1, 2]);
    expect(movedOrder(3, -1, 1)).toEqual([0, 1, 2]);
    expect(movedOrder(3, 0, 3)).toEqual([0, 1, 2]);
  });
});

describe('word clamp', () => {
  it('starts from the words on the kept lines plus an ellipsis', () => {
    expect(firstCandidate(['Northwind Traders ', 'quarterly ', 'consulting invoice'], 2)).toBe('Northwind Traders quarterly…');
    expect(firstCandidate(['Lease, ', 'renewal — ', 'notice'], 2)).toBe('Lease, renewal…');
  });

  it('drops whole words, never part of one', () => {
    expect(dropLastWord('Northwind Traders quarterly')).toBe('Northwind Traders');
    expect(dropLastWord('Invoice, March')).toBe('Invoice');
    expect(dropLastWord('Supercalifragilistic')).toBeNull();
  });
});

describe('export all', () => {
  it('names the ZIP after the library and the local date', () => {
    expect(exportAllName(new Date(2026, 0, 5, 23, 30))).toBe('Scan Kit documents 2026-01-05');
  });

  it('keeps file names in the ZIP unique', () => {
    expect(uniqueNames(['Scan.pdf', 'scan.pdf', 'Scan.pdf'])).toEqual(['Scan.pdf', 'scan 2.pdf', 'Scan 3.pdf']);
  });
});

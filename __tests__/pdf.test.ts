// __tests__/pdf.test.ts
import * as FileSystem from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import { generatePdf } from '../lib/pdf';

// lib/pdf.ts reads page files via the legacy filesystem API (the v19 main-export
// functions throw at runtime), so the mock targets the legacy subpath.
jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: jest.fn().mockResolvedValue('FAKEBASE64'),
  EncodingType: { Base64: 'base64' },
}));

jest.mock('expo-print', () => ({
  printToFileAsync: jest.fn().mockResolvedValue({ uri: 'file:///output.pdf' }),
}));

const mockReadAs = FileSystem.readAsStringAsync as jest.Mock;
const mockPrint = Print.printToFileAsync as jest.Mock;

beforeEach(() => jest.clearAllMocks());

test('reads each page as base64', async () => {
  await generatePdf(['file:///page0.jpg', 'file:///page1.jpg']);
  expect(mockReadAs).toHaveBeenCalledTimes(2);
  expect(mockReadAs).toHaveBeenCalledWith('file:///page0.jpg', { encoding: 'base64' });
  expect(mockReadAs).toHaveBeenCalledWith('file:///page1.jpg', { encoding: 'base64' });
});

test('embeds data URIs in the HTML passed to printToFileAsync', async () => {
  await generatePdf(['file:///page0.jpg']);
  const { html } = mockPrint.mock.calls[0][0];
  expect(html).toContain('data:image/jpeg;base64,FAKEBASE64');
  expect(html).not.toContain('file:///page0.jpg');
});

test('returns the URI from printToFileAsync', async () => {
  const uri = await generatePdf(['file:///page0.jpg']);
  expect(uri).toBe('file:///output.pdf');
});

// Regression guard: filters are now baked into page pixels (see lib/bake.ts)
// before generatePdf ever reads them, so the exported HTML must never inject
// a CSS `filter:` — doing so would double-apply the filter on top of already-
// filtered pixels. Passing a non-'original' filters array here should have no
// effect on the generated HTML.
test('never injects a CSS filter, even when a filters array is passed', async () => {
  await generatePdf(['file:///page0.jpg'], ['grayscale'], [{ brightness: 20, contrast: 0, saturation: 0 }]);
  const { html } = mockPrint.mock.calls[0][0];
  expect(html).not.toContain('filter:');
});

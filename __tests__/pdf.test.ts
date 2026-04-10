// __tests__/pdf.test.ts
import * as FileSystem from 'expo-file-system';
import * as Print from 'expo-print';
import { generatePdf } from '../lib/pdf';

jest.mock('expo-file-system', () => ({
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

test('applies CSS filter when filter is not original', async () => {
  await generatePdf(['file:///page0.jpg'], ['grayscale']);
  const { html } = mockPrint.mock.calls[0][0];
  expect(html).toContain('filter:');
});

// __tests__/pdf-protect.test.ts
// The password-protected PDF export: availability check and the native call.
import { VisionOcr } from '../modules/vision-ocr/src';
import { canProtectPdf, MIN_PDF_PASSWORD, protectPdf, PdfProtectError } from '../lib/pdf';

jest.mock('../modules/vision-ocr/src', () => ({
  VisionOcr: { protectPdf: jest.fn().mockResolvedValue('file:///out/Doc.pdf') },
}));
jest.mock('../lib/ocr', () => ({ recognizeLines: jest.fn() }));

const native = VisionOcr as unknown as { protectPdf?: jest.Mock };
const realProtect = native.protectPdf!;

afterEach(() => {
  native.protectPdf = realProtect;
  realProtect.mockClear();
});

test('canProtectPdf follows the native function', () => {
  expect(canProtectPdf()).toBe(true);
  native.protectPdf = undefined;
  expect(canProtectPdf()).toBe(false);
});

test('protectPdf passes clean URIs and the password to the native module', async () => {
  await expect(protectPdf('file:///tmp/in.pdf?v=3', 'file:///out/Doc.pdf', 'secret')).resolves.toBe('file:///out/Doc.pdf');
  expect(realProtect).toHaveBeenCalledWith('file:///tmp/in.pdf', 'file:///out/Doc.pdf', 'secret');
});

test('protectPdf refuses short passwords without calling native code', async () => {
  await expect(protectPdf('file:///in.pdf', 'file:///out.pdf', 'x'.repeat(MIN_PDF_PASSWORD - 1))).rejects.toBeInstanceOf(PdfProtectError);
  expect(realProtect).not.toHaveBeenCalled();
});

test('protectPdf turns native failures and a missing module into PdfProtectError', async () => {
  realProtect.mockRejectedValueOnce(new Error('ERR_PDF_PROTECT /private/var/…'));
  await expect(protectPdf('file:///in.pdf', 'file:///out.pdf', 'secret')).rejects.toBeInstanceOf(PdfProtectError);
  native.protectPdf = undefined;
  await expect(protectPdf('file:///in.pdf', 'file:///out.pdf', 'secret')).rejects.toBeInstanceOf(PdfProtectError);
});

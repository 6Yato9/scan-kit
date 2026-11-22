// Android port phase 4: the PDF tools light up on Android. Every JS gate is a
// presence check on VisionOcr, so this reads the function names the Kotlin
// module registers (VisionOcrModule.kt) and checks each tool's gate opens with
// exactly that set; and no "not available on Android yet" copy is left.
import fs from 'node:fs';
import path from 'node:path';
import { canEditPdfPages, canMergePdfDocuments } from '../lib/pdf-edit';
import { canFillPdf, canFlattenPdf } from '../lib/pdf-fill';
import { canFlattenDocuments } from '../lib/pdf-flatten';
import { canProtectDocuments } from '../lib/pdf-protect';
import { canProtectPdf } from '../lib/pdf';
import { canUnrestrictPdf } from '../lib/pdf-unrestrict';
import { canUnlockForSession } from '../lib/pdf-session';
import { canCreateFromPdfs, canRenderPdfThumbs } from '../lib/create-pdf-build';

const ROOT = path.join(__dirname, '..');
const kotlin = fs.readFileSync(path.join(ROOT, 'modules/vision-ocr/android/src/main/java/expo/modules/visionocr/VisionOcrModule.kt'), 'utf8');
const androidFunctions = [...kotlin.matchAll(/(?:Async)?Function\("([A-Za-z]+)"\)/g)].map(m => m[1]);

let mockNative: Record<string, unknown> | null = null;
jest.mock('../modules/vision-ocr/src', () => ({ get VisionOcr() { return mockNative; } }));
jest.mock('@react-native-async-storage/async-storage', () => jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const gates: Record<string, () => boolean> = {
  canEditPdfPages,
  canMergePdfDocuments,
  canFillPdf,
  canFlattenPdf,
  canFlattenDocuments,
  canProtectDocuments,
  canProtectPdf,
  canUnrestrictPdf,
  canUnlockForSession,
  canCreateFromPdfs,
  canRenderPdfThumbs,
};

describe('Android PDF tools (phase 4)', () => {
  it('registers every PDF tool function iOS has', () => {
    for (const name of [
      'pdfEditPages', 'mergePdfs', 'protectPdf', 'protectPdfKeeping', 'unrestrictPdf', 'pdfFillInfo',
      'pdfRenderPage', 'pdfFill', 'pdfFlatten', 'pdfFillForceFallback', 'replaceFile', 'pdfInfo',
      'pdfPermissions', 'unlockPdf', 'pdfPageTexts', 'renderPdfPages',
    ]) {
      expect(androidFunctions).toContain(name);
    }
  });

  it('opens every PDF tool gate with the functions Android registers', () => {
    mockNative = Object.fromEntries(androidFunctions.map(n => [n, jest.fn()]));
    for (const [name, gate] of Object.entries(gates)) {
      expect([name, gate()]).toEqual([name, true]);
    }
  });

  it('keeps them closed for a build without them (the "update Scan Kit" copy)', () => {
    mockNative = { recognize: jest.fn() };
    for (const [name, gate] of Object.entries(gates)) {
      expect([name, gate()]).toEqual([name, false]);
    }
  });

  it('leaves no "not available on Android yet" copy', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && /available on Android yet|coming in a later version of Scan Kit for Android/.test(fs.readFileSync(p, 'utf8'))) {
          hits.push(path.relative(ROOT, p));
        }
      }
    };
    for (const d of ['app', 'components', 'lib']) walk(path.join(ROOT, d));
    expect(hits).toEqual([]);
  });
});

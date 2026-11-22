// Android port phase 5: text actions, read aloud, contacts and calendar light
// up on Android through the same presence checks as on iOS. This reads the
// names VisionOcrModule.kt registers and checks each gate opens with exactly
// that set. Also: the password rule Protect PDF and the export sheet share.
import fs from 'node:fs';
import path from 'node:path';
import { Platform } from 'react-native';
import { canAddContact, canAddToCalendar, canDetectBarcodes, canWriteVCard, detectData } from '../lib/text-actions';
import { canReadAloud } from '../lib/read-aloud';
import { hasUnsupportedPasswordCharacters, PdfProtectError, protectPdf } from '../lib/pdf';

const ROOT = path.join(__dirname, '..');
const kotlin = fs.readFileSync(path.join(ROOT, 'modules/vision-ocr/android/src/main/java/expo/modules/visionocr/VisionOcrModule.kt'), 'utf8');
const androidFunctions = [...kotlin.matchAll(/(?:Async)?Function\("([A-Za-z]+)"\)/g)].map(m => m[1]);

let mockNative: Record<string, unknown> | null = null;
jest.mock('../modules/vision-ocr/src', () => ({ get VisionOcr() { return mockNative; } }));
jest.mock('expo-web-browser', () => ({}));
jest.mock('@react-native-async-storage/async-storage', () => jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

describe('Android text actions (phase 5)', () => {
  it('registers the text-action functions iOS has (nameEntities stays iOS only)', () => {
    for (const name of [
      'detectData', 'detectBarcodes', 'detectLanguage', 'speak', 'pauseSpeaking', 'resumeSpeaking', 'stopSpeaking',
      'presentEventEditor', 'presentNewContact', 'writeVCard',
    ]) {
      expect(androidFunctions).toContain(name);
    }
    expect(androidFunctions).not.toContain('nameEntities');
    expect(kotlin).toMatch(/Events\("onSpeechProgress", "onSpeechState"\)/);
  });

  it('opens every gate with the functions Android registers', () => {
    mockNative = { ...Object.fromEntries(androidFunctions.map(n => [n, jest.fn()])), addListener: jest.fn() };
    expect([canAddContact(), canAddToCalendar(), canDetectBarcodes(), canWriteVCard(), canReadAloud()]).toEqual([true, true, true, true, true]);
    mockNative = { recognize: jest.fn() };
    expect([canAddContact(), canAddToCalendar(), canDetectBarcodes(), canWriteVCard(), canReadAloud()]).toEqual([false, false, false, false, false]);
  });

  it('adds dates to what Android’s detector finds', async () => {
    const os = Platform.OS;
    Object.defineProperty(Platform, 'OS', { get: () => 'android', configurable: true });
    try {
      const text = 'Call +1 415 555 0132 before Monday, 9 March 2026 at 17:00.';
      mockNative = {
        detectData: jest.fn(async () => [{ type: 'phone', text: '+1 415 555 0132', range: [5, 15], value: '+1 415 555 0132' }]),
      };
      const found = await detectData(text);
      expect(found.map(d => [d.type, d.text])).toEqual([
        ['phone', '+1 415 555 0132'],
        ['date', 'Monday, 9 March 2026 at 17:00'],
      ]);
    } finally {
      Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true });
    }
  });
});

describe('PDF password characters (both platforms)', () => {
  it('allows printable ASCII only', () => {
    for (const ok of ['abcd', 'Correct horse battery staple', 'P@ss-w0rd!~{}', '1234']) expect(hasUnsupportedPasswordCharacters(ok)).toBe(false);
    for (const bad of ['Café-2026', 'Łódź-2026', 'straße', 'Key🔑-2026', 'tab\there', 'ｆｕｌｌ']) expect(hasUnsupportedPasswordCharacters(bad)).toBe(true);
  });

  it('protectPdf refuses them before calling native', async () => {
    const native = jest.fn(async () => 'file:///out.pdf');
    mockNative = { protectPdf: native };
    await expect(protectPdf('file:///in.pdf', 'file:///out.pdf', 'Café-2026')).rejects.toBeInstanceOf(PdfProtectError);
    expect(native).not.toHaveBeenCalled();
    await expect(protectPdf('file:///in.pdf', 'file:///out.pdf', 'Cafe-2026')).resolves.toBe('file:///out.pdf');
  });
});

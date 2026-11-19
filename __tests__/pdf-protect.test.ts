// __tests__/pdf-protect.test.ts
// Protect PDF and Flatten PDF (lib/pdf-protect.ts, lib/pdf-flatten.ts,
// lib/copy-undo.ts): copy names, the password strength hint (a hint, never a
// rule), and what the Flatten screen says for each kind of PDF.
jest.mock('expo-crypto', () => ({ randomUUID: () => 'new-1' }));
jest.mock('../modules/vision-ocr/src', () => ({ VisionOcr: null }));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import { copyName, copyUndoneMessage } from '../lib/copy-undo';
import { MIN_PDF_PASSWORD, passwordHint, passwordStrength, protectedName } from '../lib/pdf-protect';
import { flattenedName, flattenStateOf, flattenSummary } from '../lib/pdf-flatten';
import { unrestrictedName } from '../lib/pdf-unrestrict';

test('copies are named "<name> (what)" the same way by every PDF tool', () => {
  expect(protectedName('Lease')).toBe('Lease (protected)');
  expect(flattenedName('  Tax form ')).toBe('Tax form (flattened)');
  expect(unrestrictedName('Lease')).toBe('Lease (unrestricted)');
  // Doing it twice doesn't stack the suffix.
  expect(protectedName('Lease (protected)')).toBe('Lease (protected)');
  expect(flattenedName('Lease (Flattened)')).toBe('Lease (Flattened)');
  expect(copyName('', 'protected')).toBe('Document (protected)');
  expect(copyUndoneMessage('protected', 'deleted')).toBe('Protected copy removed');
  expect(copyUndoneMessage('flattened', 'trashed')).toBe('Flattened copy moved to Recently deleted');
});

test('password strength: only a minimum length is required', () => {
  expect(MIN_PDF_PASSWORD).toBe(4);
  expect(passwordStrength('')).toBe('short');
  expect(passwordStrength('abc')).toBe('short');
  // The obvious picks are weak whatever their length.
  for (const pw of ['1234', 'aaaaaaaaaaaa', 'abcdefgh', 'password', 'Password1', 'qwerty!', '87654321']) {
    expect(passwordStrength(pw)).toBe('weak');
  }
  expect(passwordStrength('cat5')).toBe('weak');
  expect(passwordStrength('blue7fox')).toBe('fair');
  expect(passwordStrength('tangerine17')).toBe('strong');
  // A phrase of plain words is strong: no symbol or capital required.
  expect(passwordStrength('correct horse battery')).toBe('strong');
  expect(passwordHint('short')).toMatch(/at least 4 characters/);
  expect(passwordHint('strong')).toBe('Strong password.');
});

const info = (over: object) => ({ pageCount: 2, locked: false, encrypted: false, canAnnotate: true, canFillForms: true, formFields: 0, annotations: 0, ...over });

test('flatten: what each kind of PDF is offered', () => {
  expect(flattenStateOf(info({ formFields: 3, annotations: 1 }))).toEqual({ kind: 'ready', pageCount: 2, formFields: 3, annotations: 1 });
  expect(flattenStateOf(info({}))).toEqual({ kind: 'nothing' });
  expect(flattenStateOf(info({ locked: true, formFields: 3 }))).toEqual({ kind: 'locked' });
  expect(flattenStateOf(info({ signed: true, formFields: 3 }))).toEqual({ kind: 'signed' });
  expect(flattenStateOf(info({ encrypted: true, canFillForms: false, formFields: 3 }))).toEqual({ kind: 'restricted' });
  // Encrypted but allowing both: fine.
  expect(flattenStateOf(info({ encrypted: true, annotations: 2 })).kind).toBe('ready');
  expect(flattenSummary(3, 0)).toBe('3 form fields');
  expect(flattenSummary(1, 1)).toBe('1 form field and 1 addition');
  expect(flattenSummary(0, 4)).toBe('4 additions');
});

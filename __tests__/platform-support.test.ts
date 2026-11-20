// Android port, phase 0: platform-specific copy must leave iOS exactly as it was.
import { Platform } from 'react-native';
import { lockMethodLabel } from '../lib/biometrics';
import { unavailableCopy } from '../lib/platform-support';

const IOS = { title: 'Update Scan Kit to flatten PDFs', text: 'This version of Scan Kit can’t flatten a PDF.' };

describe('lockMethodLabel', () => {
  it('keeps the iOS names on iOS', () => {
    expect(lockMethodLabel('faceId', 'ios')).toBe('Face ID');
    expect(lockMethodLabel('touchId', 'ios')).toBe('Touch ID');
    expect(lockMethodLabel('passcode', 'ios')).toBe('your passcode');
  });

  it('uses Android’s own words on Android', () => {
    expect(lockMethodLabel('faceId', 'android')).toBe('your face');
    expect(lockMethodLabel('touchId', 'android')).toBe('your fingerprint');
    expect(lockMethodLabel('passcode', 'android')).toBe('your screen lock');
  });
});

describe('unavailableCopy', () => {
  const original = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
  });

  it('returns the iOS copy unchanged on iOS', () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    expect(unavailableCopy(IOS, 'Flatten PDF')).toBe(IOS);
  });

  it('says the feature is coming on Android', () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const copy = unavailableCopy(IOS, 'Flatten PDF');
    expect(copy.title).toBe('Flatten PDF isn’t available on Android yet');
    expect(copy.text).not.toMatch(/update|install/i);
  });
});

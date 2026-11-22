// Android port, phase 0: platform-specific copy must leave iOS exactly as it was.
import { lockMethodLabel } from '../lib/biometrics';

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

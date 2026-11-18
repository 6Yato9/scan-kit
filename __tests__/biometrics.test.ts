// __tests__/biometrics.test.ts
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(),
  isEnrolledAsync: jest.fn(),
  getEnrolledLevelAsync: jest.fn(),
  supportedAuthenticationTypesAsync: jest.fn(),
  authenticateAsync: jest.fn(),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
}));
const mockLA = jest.requireMock('expo-local-authentication') as Record<string, jest.Mock>;

import { authenticate, biometricKind, classifyAuthResult } from '../lib/biometrics';

beforeEach(() => {
  jest.resetAllMocks();
  mockLA.hasHardwareAsync.mockResolvedValue(true);
  mockLA.isEnrolledAsync.mockResolvedValue(true);
  mockLA.getEnrolledLevelAsync.mockResolvedValue(3);
});

describe('classifyAuthResult (never lock the user out)', () => {
  it('success is success', () => {
    expect(classifyAuthResult({ success: true })).toBe('success');
  });
  it('cancel / failure stays locked (with a retry button)', () => {
    expect(classifyAuthResult({ success: false, error: 'user_cancel' })).toBe('failed');
    expect(classifyAuthResult({ success: false, error: 'authentication_failed' })).toBe('failed');
    expect(classifyAuthResult({ success: false, error: 'lockout' })).toBe('failed');
  });
  it.each(['passcode_not_set', 'not_enrolled', 'not_available'])('%s fails open', error => {
    expect(classifyAuthResult({ success: false, error })).toBe('unavailable');
  });
});

describe('authenticate', () => {
  it('fails open when nothing is enrolled (no passcode, no biometrics)', async () => {
    mockLA.getEnrolledLevelAsync.mockResolvedValue(0);
    expect(await authenticate('x')).toBe('unavailable');
    expect(mockLA.authenticateAsync).not.toHaveBeenCalled();
  });
  it('fails open when the passcode was removed after enabling the lock', async () => {
    mockLA.authenticateAsync.mockResolvedValue({ success: false, error: 'passcode_not_set' });
    expect(await authenticate('x')).toBe('unavailable');
  });
  it('fails open when the native call throws', async () => {
    mockLA.authenticateAsync.mockRejectedValue(new Error('boom'));
    expect(await authenticate('x')).toBe('unavailable');
  });
  it('reports a user cancel as failed', async () => {
    mockLA.authenticateAsync.mockResolvedValue({ success: false, error: 'user_cancel' });
    expect(await authenticate('x')).toBe('failed');
  });
});

describe('biometricKind', () => {
  it('detects Face ID', async () => {
    mockLA.supportedAuthenticationTypesAsync.mockResolvedValue([2]);
    expect(await biometricKind()).toBe('faceId');
  });
  it('detects Touch ID', async () => {
    mockLA.supportedAuthenticationTypesAsync.mockResolvedValue([1]);
    expect(await biometricKind()).toBe('touchId');
  });
  it('falls back to passcode when biometrics are not enrolled', async () => {
    mockLA.isEnrolledAsync.mockResolvedValue(false);
    expect(await biometricKind()).toBe('passcode');
  });
});

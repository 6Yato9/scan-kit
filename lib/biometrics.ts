// lib/biometrics.ts
// Thin, crash-safe wrappers over expo-local-authentication for the app lock.
//
// SAFETY: the user's documents are local-only with no backup. A permanent
// lockout = permanent data loss. So every path here is biased toward NOT
// trapping the user: anything that means "this device cannot authenticate
// right now" (no hardware, nothing enrolled, no passcode, or a thrown error)
// resolves to 'unavailable' so the caller can fail OPEN.
import * as LocalAuthentication from 'expo-local-authentication';

export type AuthResult = 'success' | 'failed' | 'unavailable';
export type BiometricKind = 'faceId' | 'touchId' | 'passcode';

/**
 * Error codes that mean the device has no usable way to authenticate. Mapping
 * these to 'failed' would leave a locked user with an Unlock button that can
 * never succeed (e.g. after removing the device passcode).
 */
const UNAVAILABLE_ERRORS = new Set<string>([
  'not_enrolled',
  'not_available',
  'passcode_not_set',
  'invalid_context',
]);

/** Pure mapping from an authenticateAsync result to our tri-state. Exported for tests. */
export function classifyAuthResult(res: { success: boolean; error?: string }): AuthResult {
  if (res.success) return 'success';
  if (res.error && UNAVAILABLE_ERRORS.has(res.error)) return 'unavailable';
  return 'failed';
}

/** True only when the device has biometric hardware AND the user is enrolled. */
export async function canUseBiometrics(): Promise<boolean> {
  try {
    const [hasHardware, isEnrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hasHardware && isEnrolled;
  } catch {
    return false;
  }
}

/** True when the device reports biometric hardware (enrollment not required). */
export async function hasBiometricHardware(): Promise<boolean> {
  try {
    return await LocalAuthentication.hasHardwareAsync();
  } catch {
    return false;
  }
}

/** Which unlock method the device will offer, for labels and icons. */
export async function biometricKind(): Promise<BiometricKind> {
  try {
    if (!(await canUseBiometrics())) return 'passcode';
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'faceId';
    if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'touchId';
    return 'passcode';
  } catch {
    return 'passcode';
  }
}

/** True when the device can authenticate at all (biometrics or a passcode). */
export async function canAuthenticate(): Promise<boolean> {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    return level !== LocalAuthentication.SecurityLevel.NONE;
  } catch {
    return false;
  }
}

/**
 * Prompt the user to authenticate.
 * - 'success'     → user passed (biometric or device passcode fallback).
 * - 'failed'      → user cancelled or failed; caller should stay locked but
 *                   ALWAYS offer a retry (never auto-loop the prompt).
 * - 'unavailable' → nothing to authenticate with, or the call threw; caller
 *                   MUST fail open.
 */
export async function authenticate(promptMessage: string): Promise<AuthResult> {
  if (!(await canAuthenticate())) return 'unavailable';
  try {
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage,
      fallbackLabel: 'Use passcode',
      disableDeviceFallback: false,
    });
    return classifyAuthResult(res as { success: boolean; error?: string });
  } catch {
    return 'unavailable';
  }
}

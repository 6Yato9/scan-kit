// lib/biometrics.ts
// Thin, crash-safe wrappers over expo-local-authentication for the app lock.
//
// SAFETY: the user's documents are local-only with no backup. A permanent
// lockout = permanent data loss. So every path here is biased toward NOT
// trapping the user: any thrown error (sensor genuinely unavailable) resolves
// to a benign value so the caller can fail OPEN.
import * as LocalAuthentication from 'expo-local-authentication';

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

/**
 * Prompt the user to authenticate.
 * - 'success'     → user passed (biometric or device passcode fallback).
 * - 'failed'      → user cancelled or failed; caller should stay locked but
 *                   ALWAYS offer a retry (never auto-loop the prompt).
 * - 'unavailable' → no hardware OR the call threw; caller MUST fail open.
 */
export async function authenticate(
  promptMessage: string
): Promise<'success' | 'failed' | 'unavailable'> {
  if (!(await hasHardwareAsyncSafe())) return 'unavailable';
  try {
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage,
      fallbackLabel: 'Use Passcode',
      disableDeviceFallback: false,
    });
    return res.success ? 'success' : 'failed';
  } catch {
    return 'unavailable';
  }
}

// hasHardwareAsync can itself throw on some platforms; treat a throw as "no
// hardware" so authenticate() fails open rather than bricking.
async function hasHardwareAsyncSafe(): Promise<boolean> {
  try {
    return await LocalAuthentication.hasHardwareAsync();
  } catch {
    return false;
  }
}

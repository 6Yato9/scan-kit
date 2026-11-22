// lib/android-leave.ts
//
// When App Lock locks on Android (components/lock-gate.tsx), as pure rules.
//
// iOS locks when the app goes to the background. Pickers, the share sheet,
// the print dialog, the in-app browser and the calendar / contact editors are
// shown INSIDE the app there, so using them never locks it. On Android each of
// them is another app's activity: Scan Kit's own activity is paused (a sheet
// or dialog drawn over it: the share chooser, a permission prompt) or stopped
// (a full-screen picker, the print screen, a Custom Tab, Gmail's compose
// screen after the chooser), and React Native reports "background" for both.
// Locking then would ask for the fingerprint every time a photo is picked or
// a file shared. So on Android:
//   - A pause alone never locks (the app is still on screen under the sheet).
//   - A stop locks, unless the app itself just opened another app's screen
//     (a tracked picker is open, lib/system-ui withSystemUI; or a hand-off was
//     marked, lib/system-ui markHandOff) or our own unlock prompt is up (API
//     26-29 show the screen-lock fallback as an activity of its own).
//   - A hand-off that lasts longer than HANDOFF_MAX_AWAY_MS locks on return.
//     Android doesn't tell the app when the user goes Home from inside another
//     app's screen, so a long absence is treated as having left.
//   - Already locked and stopped (Home from the lock screen): ask again on
//     return, as iOS does.

/** A hand-off longer than this counts as leaving the app (checked on return). */
export const HANDOFF_MAX_AWAY_MS = 2 * 60 * 1000;

export type StopDecision =
  /** Lock now (the user left the app). */
  | 'lock'
  /** The app opened another app's screen: remember when, decide on return. */
  | 'handoff'
  /** Already locked: just ask again on return. */
  | 'reprompt'
  /** Our own unlock prompt took the screen: nothing to do. */
  | 'none';

export function decideOnStop(state: {
  locked: boolean;
  authenticating: boolean;
  pickerOpen: boolean;
  handOffPending: boolean;
}): StopDecision {
  if (state.authenticating) return 'none';
  if (state.locked) return 'reprompt';
  if (state.pickerOpen || state.handOffPending) return 'handoff';
  return 'lock';
}

/** Back from a hand-off that started at `awaySince`: lock if it lasted too long. */
export function decideOnReturn(awaySince: number | null, now: number): 'lock' | 'stay' {
  if (awaySince === null) return 'stay';
  return now - awaySince > HANDOFF_MAX_AWAY_MS ? 'lock' : 'stay';
}

// lib/remembered-prefs.ts
// The rule every screen with remembered choices follows (round 16 review):
// the stored choices arrive a moment after the screen opens, and a choice the
// user made before they arrived must never be overwritten by them. Pure and
// framework-free, so the sequence is unit-tested; the React side is
// components/use-remembered-prefs.ts.
//
// - begin(): a read of the stored value starts (screen opened, sheet shown).
// - change(patch): the user chose something. Until the stored value has
//   arrived the patch is held, not written: writing it then would store the
//   defaults over every other remembered field.
// - arrive(token, stored): the stored value, with every field the user has
//   changed meanwhile laid over it — and written back when there was one.
//   A late answer from an earlier read (token) is ignored.

export class RememberedPrefs<T extends object> {
  /** What the screen shows: the latest choice. */
  value: T;
  private pending: Partial<T> | null = null;
  private loaded = false;
  private token = 0;

  constructor(initial: T) {
    this.value = initial;
  }

  /** A read starts; pass the token it returns to arrive(). */
  begin(): number {
    this.loaded = false;
    this.pending = null;
    this.token += 1;
    return this.token;
  }

  /** The stored value arrived. Null when it is stale (another read began since). */
  arrive(token: number, stored: T): { value: T; save: boolean } | null {
    if (token !== this.token || this.loaded) return null;
    this.loaded = true;
    const pending = this.pending;
    this.pending = null;
    this.value = pending ? { ...stored, ...pending } : stored;
    return { value: this.value, save: pending !== null };
  }

  /** The user chose something: what to show, and whether to write it now. */
  change(patch: Partial<T>): { value: T; save: boolean } {
    this.value = { ...this.value, ...patch };
    if (!this.loaded) {
      this.pending = { ...(this.pending ?? {}), ...patch };
      return { value: this.value, save: false };
    }
    return { value: this.value, save: true };
  }
}

// components/use-remembered-prefs.ts
// A screen's remembered choices (Split, Compress, Erase marks, Long image,
// Book mode, Whiteboard, ID card, Extract text, the export sheet, Create PDF):
// shown at once with the defaults, replaced by the stored choices when they
// arrive — except any the user has already changed, which win (the rule is
// lib/remembered-prefs.ts, unit-tested there).
//
// Returns [value, update, latest]: `update(patch)` changes and remembers;
// `latest()` is the newest choice, for handlers that run after two quick taps
// (the render's `value` may be one behind). No ref is written during render:
// the React Compiler is on.
import { useCallback, useEffect, useState } from 'react';
import { RememberedPrefs } from '@/lib/remembered-prefs';

export function useRememberedPrefs<T extends object>(
  initial: T,
  load: () => Promise<T>,
  save: (value: T) => Promise<unknown> | void,
  options: {
    /** Read while true, and again each time it turns true (a sheet being shown). Default true. */
    active?: boolean;
    /** Once the stored choices are in (with the user's own laid over them). */
    onLoaded?: (value: T) => void;
  } = {},
): readonly [T, (patch: Partial<T>) => void, () => T] {
  const { active = true, onLoaded } = options;
  const [store] = useState(() => new RememberedPrefs(initial));
  const [value, setValue] = useState(initial);

  const write = useCallback(
    (v: T) => {
      try {
        Promise.resolve(save(v)).catch(() => {});
      } catch {}
    },
    [save],
  );

  useEffect(() => {
    if (!active) return;
    const token = store.begin();
    let live = true;
    load()
      .catch(() => store.value)
      .then(stored => {
        if (!live) return;
        const r = store.arrive(token, stored);
        if (!r) return;
        setValue(r.value);
        if (r.save) write(r.value);
        onLoaded?.(r.value);
      });
    return () => {
      live = false;
    };
    // `load` and `onLoaded` are read when the read starts; a new function each render must not re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, store]);

  const update = useCallback(
    (patch: Partial<T>) => {
      const r = store.change(patch);
      setValue(r.value);
      if (r.save) write(r.value);
    },
    [store, write],
  );
  const latest = useCallback(() => store.value, [store]);
  return [value, update, latest] as const;
}

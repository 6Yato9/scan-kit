// contexts/theme-context.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance, Platform, useColorScheme } from 'react-native';
import { Colors, ThemePreference, type ThemeColors } from '@/lib/theme';
import { getThemePreference, getThemePreferenceSync, saveThemePreference } from '@/lib/storage';

type ThemeContextType = {
  preference: ThemePreference;
  isDark: boolean;
  colors: ThemeColors;
  setPreference: (p: ThemePreference) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextType>({
  preference: 'system',
  isDark: false,
  colors: Colors.light,
  setPreference: async () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  // Use the sync cache so the initial render already has the correct preference,
  // preventing a light→dark flash when the stored pref differs from the system scheme.
  const [preference, setPreferenceState] = useState<ThemePreference>(getThemePreferenceSync);

  useEffect(() => {
    getThemePreference().then(setPreferenceState);
  }, []);

  // Android: the app's own Light / Dark choice also sets the native night
  // mode, so what Android draws itself follows it rather than the system's:
  // alerts, the bottom sheets' navigation-bar contrast and keyboards. iOS is
  // unchanged (UIKit's sheets and alerts there keep following the system).
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    Appearance.setColorScheme(preference === 'system' ? null : preference);
  }, [preference]);

  const isDark = preference === 'system' ? systemScheme === 'dark' : preference === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];

  const setPreference = useCallback(async (p: ThemePreference) => {
    setPreferenceState(p);
    await saveThemePreference(p);
  }, []);

  const value = useMemo(
    () => ({ preference, isDark, colors, setPreference }),
    [preference, isDark, colors, setPreference]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

/**
 * Renders its subtree with the dark palette whatever the app theme is. The
 * always-dark screens (viewer) wrap their sheets in it, so a bright sheet never
 * slides over the dark chrome.
 */
export function DarkThemeScope({ children }: { children: React.ReactNode }) {
  const ctx = useContext(ThemeContext);
  const value = useMemo(() => ({ ...ctx, isDark: true, colors: Colors.dark }), [ctx]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

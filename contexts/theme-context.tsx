// contexts/theme-context.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { Colors, ThemePreference, type ThemeColors } from '@/lib/theme';
import { getThemePreference, saveThemePreference } from '@/lib/storage';

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
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  useEffect(() => {
    getThemePreference().then(setPreferenceState);
  }, []);

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

// app/_layout.tsx
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ScanProvider } from '@/contexts/scan-context';
import { ThemeProvider, useTheme } from '@/contexts/theme-context';

function ThemedStack() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.card },
        headerTintColor: colors.text,
        headerTitleStyle: { color: colors.text, fontWeight: '600' },
        headerBackTitle: '',           // hide "(tabs)" back label
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="viewer"
        options={{ presentation: 'fullScreenModal', headerShown: false }}
      />
      <Stack.Screen
        name="review"
        options={{ presentation: 'fullScreenModal', headerShown: false }}
      />
      <Stack.Screen
        name="annotate"
        options={{ presentation: 'fullScreenModal', headerShown: false }}
      />
      <Stack.Screen
        name="settings/scan-settings"
        options={{ title: 'Scan Settings', presentation: 'card' }}
      />
      <Stack.Screen
        name="settings/document-settings"
        options={{ title: 'Document Settings', presentation: 'card' }}
      />
      <Stack.Screen
        name="settings/printer"
        options={{ title: 'My Printer', presentation: 'card' }}
      />
      <Stack.Screen
        name="settings/about"
        options={{ title: 'About', presentation: 'card' }}
      />
      <Stack.Screen name="tools/qr" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
      <Stack.Screen name="tools/id-card" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/compress" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/extract" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/watermark" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/timestamp" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/sign" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/merge" options={{ headerShown: false, presentation: 'card' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <ScanProvider>
          <ThemedStack />
        </ScanProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

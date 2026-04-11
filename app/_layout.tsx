// app/_layout.tsx
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ScanProvider } from '@/contexts/scan-context';
import { ThemeProvider } from '@/contexts/theme-context';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <ScanProvider>
        <Stack>
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
        </Stack>
        </ScanProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

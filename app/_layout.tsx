// app/_layout.tsx
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeProvider } from '@/contexts/theme-context';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
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
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

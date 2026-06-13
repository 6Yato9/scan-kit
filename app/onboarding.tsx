// app/onboarding.tsx
import { useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { setOnboarded } from '@/lib/storage';

const SLIDE_COUNT = 3;

type Feature = { icon: keyof typeof MaterialCommunityIcons.glyphMap; text: string };

const FEATURES: Feature[] = [
  { icon: 'scan-helper', text: 'Auto edge detection & filters' },
  { icon: 'file-export-outline', text: 'PDF, long-image & ZIP export' },
  { icon: 'shape-plus', text: 'ID card, QR, sign, watermark & more' },
];

export default function OnboardingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  const [, requestPermission] = useCameraPermissions();
  const [finishing, setFinishing] = useState(false);

  function goToTabs() {
    router.replace('/(tabs)');
  }

  async function handleSkip() {
    if (finishing) return;
    setFinishing(true);
    await setOnboarded();
    goToTabs();
  }

  async function handleAllowCamera() {
    if (finishing) return;
    setFinishing(true);
    try {
      // Primes the OS camera prompt shared by the scanner (same NSCameraUsageDescription).
      await requestPermission();
    } catch {
      // Ignore — proceed regardless of grant/deny.
    }
    await setOnboarded();
    goToTabs();
  }

  function onMomentumEnd(e: { nativeEvent: { contentOffset: { x: number } } }) {
    const next = Math.round(e.nativeEvent.contentOffset.x / width);
    if (next !== page) setPage(next);
  }

  const isLast = page === SLIDE_COUNT - 1;

  return (
    <View style={[styles.container, { backgroundColor: colors.bg, paddingTop: insets.top }]}>
      {/* Skip (slides 1–2 only) */}
      <View style={styles.topBar}>
        {!isLast ? (
          <Pressable
            onPress={handleSkip}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Skip onboarding"
          >
            <Text style={[styles.skip, { color: colors.muted }]}>Skip</Text>
          </Pressable>
        ) : (
          <View style={styles.skipPlaceholder} />
        )}
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onMomentumEnd}
        style={styles.pager}
      >
        {/* Slide 1 — Welcome */}
        <View style={[styles.slide, { width }]}>
          <View style={[styles.iconCircle, { backgroundColor: colors.accentLight }]}>
            <MaterialCommunityIcons name="file-document-multiple-outline" size={84} color={colors.accent} />
          </View>
          <Text style={[styles.appName, { color: colors.text }]}>Scan Kit</Text>
          <Text style={[styles.tagline, { color: colors.subtext }]}>
            Scan, organise, and share documents — right on your phone.
          </Text>
        </View>

        {/* Slide 2 — Features */}
        <View style={[styles.slide, { width }]}>
          <Text style={[styles.slideHeading, { color: colors.text }]}>Everything you need</Text>
          <View style={styles.featureList}>
            {FEATURES.map(f => (
              <View key={f.text} style={[styles.featureRow, { backgroundColor: colors.card }]}>
                <View style={[styles.featureIcon, { backgroundColor: colors.accentLight }]}>
                  <MaterialCommunityIcons name={f.icon} size={24} color={colors.accent} />
                </View>
                <Text style={[styles.featureText, { color: colors.text }]}>{f.text}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Slide 3 — Permission priming */}
        <View style={[styles.slide, { width }]}>
          <View style={[styles.iconCircle, { backgroundColor: colors.accentLight }]}>
            <Ionicons name="camera" size={78} color={colors.accent} />
          </View>
          <Text style={[styles.slideHeading, { color: colors.text }]}>Camera access</Text>
          <Text style={[styles.tagline, { color: colors.subtext }]}>
            Scan Kit needs camera access to scan documents. Your scans stay on your device.
          </Text>
        </View>
      </ScrollView>

      {/* Dots */}
      <View style={styles.dots}>
        {Array.from({ length: SLIDE_COUNT }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                backgroundColor: i === page ? colors.accent : isDark ? '#444' : '#ccc',
                width: i === page ? 20 : 8,
              },
            ]}
          />
        ))}
      </View>

      {/* Bottom controls */}
      <View style={[styles.controls, { paddingBottom: insets.bottom + 16 }]}>
        {isLast ? (
          <Pressable
            style={[styles.primaryBtn, { backgroundColor: colors.accent }, finishing && styles.btnDisabled]}
            onPress={handleAllowCamera}
            disabled={finishing}
            accessibilityRole="button"
            accessibilityLabel="Allow Camera"
          >
            <Text style={styles.primaryText}>Allow Camera</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.primaryBtn, { backgroundColor: colors.accent }]}
            onPress={() => scrollRef.current?.scrollTo({ x: width * (page + 1), animated: true })}
            accessibilityRole="button"
            accessibilityLabel="Next"
          >
            <Text style={styles.primaryText}>Next</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    height: 44,
    paddingHorizontal: 20,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  skip: { fontSize: 16, fontWeight: '600' },
  skipPlaceholder: { height: 20 },
  pager: { flex: 1 },
  slide: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
  },
  iconCircle: {
    width: 168,
    height: 168,
    borderRadius: 84,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
  },
  appName: {
    fontSize: 38,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginBottom: 14,
  },
  slideHeading: {
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.3,
    marginBottom: 28,
    textAlign: 'center',
  },
  tagline: {
    fontSize: 17,
    lineHeight: 25,
    textAlign: 'center',
  },
  featureList: { width: '100%', gap: 14 },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    gap: 16,
  },
  featureIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureText: { flex: 1, fontSize: 16, fontWeight: '600' },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 24,
  },
  dot: { height: 8, borderRadius: 4 },
  controls: { paddingHorizontal: 24 },
  primaryBtn: {
    borderRadius: 16,
    paddingVertical: 17,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.6 },
  primaryText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});

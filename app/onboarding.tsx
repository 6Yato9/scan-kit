// app/onboarding.tsx
// First-run introduction: welcome, what the app does, and camera priming.
import { useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { setOnboarded } from '@/lib/storage';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { BrandMark } from '@/components/brand-mark';
import { PrimaryButton } from '@/components/primary-button';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

const SLIDE_COUNT = 3;

type Feature = { icon: keyof typeof Ionicons.glyphMap; title: string; text: string };

const FEATURES: Feature[] = [
  { icon: 'scan-outline', title: 'Clean scans', text: 'Edges are found for you, and filters make text crisp.' },
  { icon: 'share-outline', title: 'Share anywhere', text: 'Export as PDF, images, or a ZIP, or print directly.' },
  { icon: 'construct-outline', title: 'Handy tools', text: 'ID cards, QR codes, signatures, watermarks, and more.' },
  { icon: 'lock-closed-outline', title: 'Private by design', text: 'Everything stays on your device. No account needed.' },
];

export default function OnboardingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  const [, requestPermission] = useCameraPermissions();
  const [finishing, setFinishing] = useState(false);

  async function finish(askCamera: boolean) {
    if (finishing) return;
    setFinishing(true);
    if (askCamera) {
      try {
        // Primes the OS camera prompt shared by the scanner (same NSCameraUsageDescription).
        await requestPermission();
      } catch {
        // Ignore — proceed regardless of grant/deny.
      }
    }
    await setOnboarded();
    navigateWhenUnlocked(() => router.replace('/(tabs)'));
  }

  function goTo(i: number) {
    scrollRef.current?.scrollTo({ x: width * i, animated: true });
    setPage(i);
  }

  function onMomentumEnd(e: { nativeEvent: { contentOffset: { x: number } } }) {
    const next = Math.round(e.nativeEvent.contentOffset.x / width);
    if (next !== page) setPage(next);
  }

  const isLast = page === SLIDE_COUNT - 1;

  return (
    <View style={[styles.container, { backgroundColor: colors.bg, paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        {!isLast && (
          <Pressable
            onPress={() => finish(false)}
            hitSlop={8}
            style={styles.skipBtn}
            accessibilityRole="button"
            accessibilityLabel="Skip introduction"
          >
            <Text style={[Type.body, { color: colors.muted, fontWeight: '500' }]}>Skip</Text>
          </Pressable>
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
        <Slide width={width}>
          <BrandMark size={128} />
          <Text style={[styles.appName, { color: colors.text }]} accessibilityRole="header">Scan Kit</Text>
          <Text style={[styles.tagline, { color: colors.subtext }]}>
            Scan, organize, and share your documents, all on your device.
          </Text>
        </Slide>

        {/* Slide 2 — Features */}
        <Slide width={width}>
          <Text style={[styles.slideHeading, { color: colors.text }]} accessibilityRole="header">Everything in one place</Text>
          <View style={[styles.featureCard, { backgroundColor: colors.card }]}>
            {FEATURES.map((f, i) => (
              <View
                key={f.title}
                style={[
                  styles.featureRow,
                  i < FEATURES.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
                ]}
              >
                <View style={[styles.featureIcon, { backgroundColor: colors.accentLight }]}>
                  <Ionicons name={f.icon} size={22} color={colors.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[Type.headline, { color: colors.text }]}>{f.title}</Text>
                  <Text style={[Type.footnote, { color: colors.muted, marginTop: 2, lineHeight: 18 }]}>{f.text}</Text>
                </View>
              </View>
            ))}
          </View>
        </Slide>

        {/* Slide 3 — Camera priming */}
        <Slide width={width}>
          <View style={[styles.iconCircle, { backgroundColor: colors.accentLight }]}>
            <Ionicons name="camera-outline" size={56} color={colors.accent} />
          </View>
          <Text style={[styles.slideHeading, { color: colors.text }]} accessibilityRole="header">Allow camera access</Text>
          <Text style={[styles.tagline, { color: colors.subtext }]}>
            Scan Kit uses the camera only to scan documents. Your scans never leave your device.
          </Text>
        </Slide>
      </ScrollView>

      {/* Page dots */}
      <View style={styles.dots} accessibilityRole="adjustable" accessibilityLabel={`Page ${page + 1} of ${SLIDE_COUNT}`}>
        {Array.from({ length: SLIDE_COUNT }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              { backgroundColor: i === page ? colors.accent : colors.muted, opacity: i === page ? 1 : 0.3, width: i === page ? 22 : 8 },
            ]}
          />
        ))}
      </View>

      <View style={[styles.controls, { paddingBottom: insets.bottom + Spacing.sm }]}>
        {/* The camera slide offers only Continue, which shows the system
            prompt: App Review (guideline 5.1.1) rejects a priming screen with a
            way out before the prompt. The prompt itself has Don't Allow. */}
        <PrimaryButton
          title={isLast ? 'Continue' : 'Next'}
          icon={isLast ? 'camera-outline' : undefined}
          onPress={isLast ? () => finish(true) : () => goTo(page + 1)}
          loading={isLast && finishing}
        />
        {/* Keeps the button at the same height as before the camera slide lost "Not now". */}
        <View style={styles.notNow} />
      </View>
    </View>
  );
}

/** Content wider than this reads as a stretched phone layout on iPad. */
const READABLE_WIDTH = 520;

/**
 * One page of the pager. It scrolls vertically when its content is taller
 * than the screen (small phones, large text) and keeps a readable width on
 * iPad, centred.
 */
function Slide({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <ScrollView style={{ width }} contentContainerStyle={styles.slide} showsVerticalScrollIndicator={false}>
      <View style={styles.slideInner}>{children}</View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    height: HIT,
    paddingHorizontal: Spacing.sm,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  skipBtn: { minHeight: HIT, minWidth: HIT, paddingHorizontal: Spacing.md, justifyContent: 'center', alignItems: 'center' },
  pager: { flex: 1 },
  slide: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxxl,
    paddingVertical: Spacing.lg,
  },
  slideInner: { width: '100%', maxWidth: READABLE_WIDTH, alignItems: 'center' },
  iconCircle: {
    width: 128,
    height: 128,
    borderRadius: 64,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xxxl,
  },
  appName: {
    fontSize: 38,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginTop: Spacing.xxxl,
    marginBottom: Spacing.md,
  },
  slideHeading: {
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.3,
    marginBottom: Spacing.lg,
    textAlign: 'center',
  },
  tagline: {
    fontSize: 17,
    lineHeight: 25,
    textAlign: 'center',
  },
  featureCard: { alignSelf: 'stretch', borderRadius: Radius.lg, paddingHorizontal: Spacing.lg, marginTop: Spacing.sm },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md + 2, paddingVertical: Spacing.lg },
  featureIcon: { width: 44, height: 44, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.xl,
  },
  dot: { height: 8, borderRadius: 4 },
  controls: { paddingHorizontal: Spacing.xxl, width: '100%', maxWidth: READABLE_WIDTH + 2 * Spacing.xxl, alignSelf: 'center' },
  notNow: { height: HIT, alignItems: 'center', justifyContent: 'center', marginTop: Spacing.xs },
});

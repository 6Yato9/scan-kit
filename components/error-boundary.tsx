// components/error-boundary.tsx
// Last-resort screen when rendering throws. It reads colors straight from
// lib/theme (not the theme context) so it still works if the provider itself
// is what failed, and it follows the system appearance. The raw error is never
// shown to users; in development builds a "Show details" toggle reveals it.
import { Component, ErrorInfo, ReactNode } from 'react';
import { Appearance, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, HIT, Radius, Spacing, Type } from '@/lib/theme';

type Props = { children: ReactNode };
type State = { hasError: boolean; error: Error | null; showDetails: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, showDetails: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught an error', error, info);
  }

  reset = () => {
    this.setState({ hasError: false, error: null, showDetails: false });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const c = Colors[Appearance.getColorScheme() === 'dark' ? 'dark' : 'light'];
    return (
      <View style={[styles.container, { backgroundColor: c.bg }]}>
        <View style={styles.card}>
          <View style={[styles.iconCircle, { backgroundColor: c.accentLight }]}>
            <Ionicons name="alert-circle-outline" size={40} color={c.accent} />
          </View>
          <Text style={[Type.title, styles.title, { color: c.text }]} accessibilityRole="header">
            Something went wrong
          </Text>
          <Text style={[Type.callout, styles.message, { color: c.muted }]}>
            Your documents are safe. Try again, and if this keeps happening, restart Scan Kit.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.button, { backgroundColor: c.accentFill }, pressed && styles.pressed]}
            onPress={this.reset}
            accessibilityRole="button"
          >
            <Text style={[Type.headline, { color: c.onAccent }]}>Try again</Text>
          </Pressable>
          {__DEV__ && this.state.error ? (
            <>
              <Pressable
                onPress={() => this.setState(s => ({ showDetails: !s.showDetails }))}
                style={styles.details}
                accessibilityRole="button"
              >
                <Text style={[Type.subhead, { color: c.accent }]}>
                  {this.state.showDetails ? 'Hide details' : 'Show details'}
                </Text>
              </Pressable>
              {this.state.showDetails && (
                <ScrollView style={[styles.detailBox, { backgroundColor: c.card }]}>
                  <Text selectable style={[Type.caption, { color: c.subtext }]}>
                    {String(this.state.error.stack ?? this.state.error.message)}
                  </Text>
                </ScrollView>
              )}
            </>
          ) : null}
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xxl },
  card: { width: '100%', maxWidth: 360, alignItems: 'center' },
  iconCircle: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.xl },
  title: { textAlign: 'center', marginBottom: Spacing.sm },
  message: { textAlign: 'center', lineHeight: 21, marginBottom: Spacing.xxl },
  button: { alignSelf: 'stretch', height: 50, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.8 },
  details: { minHeight: HIT, justifyContent: 'center', marginTop: Spacing.sm },
  detailBox: { alignSelf: 'stretch', maxHeight: 200, borderRadius: Radius.sm, padding: Spacing.md },
});

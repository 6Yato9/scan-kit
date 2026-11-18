// components/app-switch.tsx
// The app's one toggle. React Native's iOS Switch lays itself out with
// `alignSelf: 'flex-start'` (so it sits at the top of a two-line row instead
// of on its centre line) and reserves 2pt more than UISwitch draws, all on
// the right, while UISwitch itself paints from the left of that box. On iOS 26
// the Liquid Glass switch is also wider (63pt) than earlier ones (51pt). This
// wrapper centres the switch vertically in a fixed-height box and pulls its
// visible right edge in to where a row's chevrons and values visibly end, so a
// toggle lines up with the chevron column on every iOS version.
import { Platform, StyleSheet, Switch, View } from 'react-native';
import { useTheme } from '@/contexts/theme-context';

/** Height of the box the switch is centred in (UISwitch is 28–31pt tall). */
const BOX_H = 32;

/**
 * Right inset that puts the switch's visible edge on the chevron column: the
 * chevron glyph sits about 5pt inside its box, and React Native's iOS switch
 * box is 2pt wider than the track it draws.
 */
const RIGHT_INSET = Platform.OS === 'ios' ? 3 : 0;

export function AppSwitch({
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
}: {
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.box}>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ true: colors.accentFill, false: Platform.OS === 'ios' ? undefined : colors.border }}
        accessibilityLabel={accessibilityLabel}
        style={styles.switch}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { height: BOX_H, justifyContent: 'center', marginRight: RIGHT_INSET },
  switch: { alignSelf: 'center' },
});

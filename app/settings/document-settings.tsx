// app/settings/document-settings.tsx
// The PDF image quality setting was removed: file size is chosen when
// exporting (Export › Smaller PDF, or the Compress tool). The stored
// `pdfQuality` value stays in DocSettings, defaulting to 'standard', so code
// that still reads it keeps working.
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { getDocSettings, saveDocSettings, DocSettings } from '@/lib/storage';
import { autoName } from '@/lib/auto-name';
import { useTheme } from '@/contexts/theme-context';
import { SettingsGroup, SettingsRow } from '@/components/settings-list';
import { ToolScreen } from '@/components/tool-ui';
import { HIT, Spacing, Type } from '@/lib/theme';

const PAGE_SIZE_OPTIONS: { label: string; desc: string; value: DocSettings['pdfPageSize'] }[] = [
  { label: 'Auto (match page)', desc: 'Receipts and cards fill the page', value: 'Auto' },
  { label: 'A4', desc: '210 × 297 mm', value: 'A4' },
  { label: 'US Letter', desc: '8.5 × 11 in', value: 'Letter' },
];

export default function DocumentSettingsScreen() {
  const { colors } = useTheme();
  const [settings, setSettings] = useState<DocSettings | null>(null);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<TextInput>(null);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    getDocSettings().then(s => { if (!cancelled) setSettings(s); });
    return () => { cancelled = true; };
  }, []));

  const update = async (patch: Partial<DocSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveDocSettings(next);
  };

  // Shows exactly what the scanner will produce (lib/auto-name.ts). Drawn with
  // no-break spaces in the footer so the example never splits across lines.
  const example = autoName(new Date(), settings?.namePrefix ?? 'Scan');

  return (
    <ToolScreen title="Document settings">
      <SettingsGroup
        title="Fallback name"
        footer={`New scans are named from the text on the page, like “Invoice 2041.” When no title can be read, they get this name and the date: “${example.replace(/ /g, '\u00A0')}.”`}
      >
        <Pressable style={styles.inputRow} onPress={() => inputRef.current?.focus()} accessible={false}>
          <TextInput
            ref={inputRef}
            style={[Type.body, styles.input, { color: colors.text }]}
            value={settings?.namePrefix ?? ''}
            onChangeText={v => update({ namePrefix: v })}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            placeholder="Scan"
            placeholderTextColor={colors.muted}
            returnKeyType="done"
            autoCorrect={false}
            accessibilityLabel="Fallback name"
            accessibilityHint="The name a new scan gets when no title can be read from it"
            clearButtonMode="while-editing"
          />
          {/* Edit cue: the row is a text field, not a label. The clear button
              takes its place while editing. */}
          {editing ? null : <Ionicons name="pencil-outline" size={18} color={colors.muted} />}
        </Pressable>
      </SettingsGroup>

      <SettingsGroup
        title="Paper size"
        footer="Used for every PDF you export and everything you print. Auto shapes each PDF like your scans; a scan of a full sheet still gets A4 or Letter."
      >
        {PAGE_SIZE_OPTIONS.map((opt, i) => (
          <SettingsRow
            key={opt.value}
            label={opt.label}
            description={opt.desc}
            accessory={{ type: 'check', selected: settings?.pdfPageSize === opt.value }}
            onPress={() => update({ pdfPageSize: opt.value })}
            last={i === PAGE_SIZE_OPTIONS.length - 1}
          />
        ))}
      </SettingsGroup>

    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    minHeight: HIT + 8,
  },
  input: { flex: 1, paddingVertical: Spacing.md },
});

// app/settings/scan-settings.tsx
import { useCallback, useState } from 'react';
import { FILTER_CAPTIONS, FILTER_LABELS } from '@/components/page-actions-sheet';
import { useFocusEffect } from 'expo-router';
import { PREVIEW_FILTERS } from '@/lib/bake';
import { getScanSettings, saveScanSettings, ScanSettings } from '@/lib/storage';
import { PageFilter } from '@/types/document';
import { SettingsGroup, SettingsRow } from '@/components/settings-list';
import { ToolScreen } from '@/components/tool-ui';

type Quality = ScanSettings['quality'];

const QUALITY_OPTIONS: { label: string; value: Quality; desc: string }[] = [
  { label: 'Standard', value: 'low', desc: 'Smallest files, about 0.5 MB a page' },
  { label: 'High', value: 'medium', desc: 'About 1 MB a page' },
  { label: 'Best', value: 'high', desc: 'Sharpest text, about 1.5 MB a page' },
];

// Same names, order and captions as the viewer's filter tiles; the rest of
// each line says what the filter does to the page (one line each, so
// "Recommended" never wraps onto a line of its own).
const FILTER_DETAILS: Record<PageFilter, string> = {
  original: 'no cleanup',
  enhanced: 'clean white paper. Recommended',
  grayscale: 'clean white paper',
  bw: 'pure black on white',
};
const FILTER_OPTIONS: { label: string; value: PageFilter; desc: string }[] = PREVIEW_FILTERS.map(f => ({
  label: FILTER_LABELS[f],
  value: f,
  desc: `${FILTER_CAPTIONS[f]}, ${FILTER_DETAILS[f]}`,
}));

export default function ScanSettingsScreen() {
  const [settings, setSettings] = useState<ScanSettings | null>(null);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    getScanSettings().then(s => { if (!cancelled) setSettings(s); });
    return () => { cancelled = true; };
  }, []));

  const update = async (patch: Partial<ScanSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveScanSettings(next);
  };

  return (
    <ToolScreen title="Scan settings">
      <SettingsGroup title="Image quality" footer="Applies to new scans and imported photos.">
        {QUALITY_OPTIONS.map((opt, i) => (
          <SettingsRow
            key={opt.value}
            label={opt.label}
            description={opt.desc}
            accessory={{ type: 'check', selected: settings?.quality === opt.value }}
            onPress={() => update({ quality: opt.value })}
            last={i === QUALITY_OPTIONS.length - 1}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup title="Default filter" footer="Every new page gets this filter. In the viewer you can change it for one page, or apply a filter to every page at once.">
        {FILTER_OPTIONS.map((opt, i) => (
          <SettingsRow
            key={opt.value}
            label={opt.label}
            description={opt.desc}
            accessory={{ type: 'check', selected: settings?.defaultFilter === opt.value }}
            onPress={() => update({ defaultFilter: opt.value })}
            last={i === FILTER_OPTIONS.length - 1}
          />
        ))}
      </SettingsGroup>
    </ToolScreen>
  );
}

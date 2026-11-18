// app/settings/scan-settings.tsx
import { useCallback, useState } from 'react';
import { FILTER_CAPTIONS, FILTER_LABELS } from '@/components/page-actions-sheet';
import { useFocusEffect } from 'expo-router';
import { PREVIEW_FILTERS } from '@/lib/bake';
import { getScanSettings, saveScanSettings, ScanSettings } from '@/lib/storage';
import { PageFilter } from '@/types/document';
import { SettingsGroup, SettingsRow } from '@/components/settings-list';
import { ToolScreen } from '@/components/tool-ui';
import { scanKitCameraAvailable } from '@/lib/tool-scan';

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
  noshadow: 'shadows removed',
  grayscale: 'clean white paper',
  bw: 'pure black on white',
  fainttext: 'faded print and receipts',
  photo: 'no flattening',
  whiteboard: 'glare removed',
  inksaver: 'uses less toner',
};
const FILTER_OPTIONS: { label: string; value: PageFilter; desc: string }[] = PREVIEW_FILTERS.map(f => ({
  label: FILTER_LABELS[f],
  value: f,
  desc: `${FILTER_CAPTIONS[f]}, ${FILTER_DETAILS[f]}`,
}));

const CAMERA_OPTIONS: { label: string; value: NonNullable<ScanSettings['camera']>; desc: string }[] = [
  { label: 'Scan Kit camera', value: 'scankit', desc: 'Keeps each photo, so a crop can be widened later' },
  { label: 'Apple document scanner', value: 'apple', desc: 'Built into iOS. Pages are saved already cropped' },
];

export default function ScanSettingsScreen() {
  const [settings, setSettings] = useState<ScanSettings | null>(null);
  // Builds without Scan Kit's camera view always use Apple's scanner.
  const [hasOwnCamera] = useState(scanKitCameraAvailable);
  const camera = settings?.camera === 'apple' ? 'apple' : 'scankit';

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
      {hasOwnCamera && (
        <>
          <SettingsGroup title="Camera">
            {CAMERA_OPTIONS.map((opt, i) => (
              <SettingsRow
                key={opt.value}
                label={opt.label}
                description={opt.desc}
                accessory={{ type: 'check', selected: !!settings && camera === opt.value }}
                onPress={() => update({ camera: opt.value })}
                last={i === CAMERA_OPTIONS.length - 1}
              />
            ))}
          </SettingsGroup>

          {camera === 'scankit' && (
            <SettingsGroup
              title="Capture"
              footer="Auto-capture takes the photo once the page holds steady; you can also switch it in the camera. Review each page shows every page for checking right after it is captured."
            >
              <SettingsRow
                label="Auto-capture"
                accessory={{
                  type: 'switch',
                  value: settings ? settings.autoCapture !== false : true,
                  onChange: v => { update({ autoCapture: v }); },
                  disabled: !settings,
                }}
              />
              <SettingsRow
                label="Review each page"
                accessory={{
                  type: 'switch',
                  value: settings?.reviewEachPage === true,
                  onChange: v => { update({ reviewEachPage: v }); },
                  disabled: !settings,
                }}
                last
              />
            </SettingsGroup>
          )}
        </>
      )}

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

      <SettingsGroup
        title="Cropping"
        footer="Keeps the whole photo behind each new page, so Crop can widen a page that was cut too tight. Uses about twice the space per page. Turning it off doesn’t remove photos already kept."
      >
        <SettingsRow
          label="Keep original photos"
          accessory={{
            type: 'switch',
            value: settings ? settings.keepSources !== false : true,
            onChange: v => { update({ keepSources: v }); },
            disabled: !settings,
          }}
          last
        />
      </SettingsGroup>
    </ToolScreen>
  );
}

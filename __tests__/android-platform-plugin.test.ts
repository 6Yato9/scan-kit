// plugins/with-android-platform.js: the Android app shortcuts must carry the
// same item types as the iOS quick actions (app.json UIApplicationShortcutItems),
// which lib/quick-actions.ts maps for both platforms.
import { QUICK_ACTION_TYPES } from '../lib/quick-actions';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../plugins/with-android-platform') as {
  SHORTCUTS: { id: string; type: string }[];
  shortcutsXml: (pkg: string) => string;
};
const appJson = require('../app.json') as {
  expo: { ios: { infoPlist: { UIApplicationShortcutItems: { UIApplicationShortcutItemType: string }[] } } };
};

jest.mock('react-native', () => ({ AppState: { addEventListener: jest.fn() } }));
jest.mock('expo', () => ({ requireOptionalNativeModule: () => null }));

test('one Android shortcut per iOS quick action, same types, same order', () => {
  const ios = appJson.expo.ios.infoPlist.UIApplicationShortcutItems.map(i => i.UIApplicationShortcutItemType);
  expect(plugin.SHORTCUTS.map(s => s.type)).toEqual(ios);
  for (const s of plugin.SHORTCUTS) expect(QUICK_ACTION_TYPES[s.type]).toBeDefined();
});

test('the shortcuts start the trampoline with the type as an extra', () => {
  const xml = plugin.shortcutsXml('com.example.app');
  expect(xml.match(/<shortcut\b/g)).toHaveLength(4);
  expect(xml).toContain('android:targetPackage="com.example.app"');
  expect(xml).toContain('android:targetClass="expo.modules.visionocr.QuickActionTrampolineActivity"');
  expect(xml).toContain('android:action="expo.modules.visionocr.QUICK_ACTION"');
  for (const s of plugin.SHORTCUTS) expect(xml).toContain(`<extra android:name="type" android:value="${s.type}" />`);
});

describe('release privacy (phase 6)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('../plugins/with-android-platform') as {
    releaseManifestXml: () => string;
    dataExtractionRulesXml: () => string;
    RELEASE_BLOCKED_PERMISSIONS: string[];
  };

  test('release builds declare no network access', () => {
    const xml = p.releaseManifestXml();
    for (const perm of ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE', 'android.permission.SYSTEM_ALERT_WINDOW']) {
      expect(xml).toContain(`<uses-permission android:name="${perm}" tools:node="remove" />`);
    }
    // Never a permission the app needs.
    expect(p.RELEASE_BLOCKED_PERMISSIONS).not.toContain('android.permission.CAMERA');
  });

  test('no data domain goes to a cloud backup or a device-to-device copy', () => {
    const xml = p.dataExtractionRulesXml();
    const section = (tag: string) => xml.split(`<${tag}>`)[1].split(`</${tag}>`)[0];
    for (const tag of ['cloud-backup', 'device-transfer']) {
      const body = section(tag);
      expect(body).not.toContain('<include');
      for (const d of ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref']) {
        expect(body).toContain(`<exclude domain="${d}" path="." />`);
      }
    }
  });

  test('release builds are minified and shrunk, for the two ARM ABIs only', () => {
    const app = require('../app.json') as { expo: { plugins: unknown[] } };
    const props = app.expo.plugins.find(pl => Array.isArray(pl) && pl[0] === 'expo-build-properties') as [string, { android: Record<string, unknown> }];
    expect(props[1].android).toMatchObject({
      enableMinifyInReleaseBuilds: true,
      enableShrinkResourcesInReleaseBuilds: true,
      buildArchs: ['arm64-v8a', 'armeabi-v7a'],
    });
  });
});

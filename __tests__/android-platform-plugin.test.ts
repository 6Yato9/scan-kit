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

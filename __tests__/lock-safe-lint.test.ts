/**
 * @jest-environment node
 */
// __tests__/lock-safe-lint.test.ts
// App Lock regression guard (r6 code review #1 / #2). The rules live in
// eslint-rules/lock-safe.js and run in `pnpm lint`; this test runs them too, so
// `pnpm test` also fails when a new call site presents native UI or navigates
// after an await without going through the lock-aware helpers.
//
// To allow a deliberate exception, add on the line before:
//   // eslint-disable-next-line lock-safe/<rule> -- <why it can't run while locked>
import * as fs from 'fs';
import * as path from 'path';
import { Linter, RuleTester } from 'eslint';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../eslint-rules/lock-safe');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsParser = require('@typescript-eslint/parser');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LOCK_SAFE_ALLOWLIST } = require('../eslint.config.js') as {
  LOCK_SAFE_ALLOWLIST: Record<string, string[]>;
};

const ROOT = path.resolve(__dirname, '..');
const languageOptions = {
  parser: tsParser,
  parserOptions: { ecmaFeatures: { jsx: true } },
  ecmaVersion: 2022 as const,
  sourceType: 'module' as const,
};

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions });

tester.run('native-presenter', plugin.rules['native-presenter'], {
  valid: [
    'await shareFile(uri, { signal });',
    'await printFile(uri);',
    'await Print.printToFileAsync({ html });', // renders off-screen, presents nothing
    "import { printToFileAsync } from 'expo-print';",
  ],
  invalid: [
    { code: 'await Sharing.shareAsync(uri);', errors: [{ messageId: 'call' }] },
    { code: 'Print.printAsync({ uri });', errors: [{ messageId: 'call' }] },
    { code: 'await MediaLibrary.saveToLibraryAsync(uri);', errors: [{ messageId: 'call' }] },
    { code: 'await MediaLibrary.createAssetAsync(uri);', errors: [{ messageId: 'call' }] },
    { code: 'Share.share({ message: text });', errors: [{ messageId: 'call' }] },
    { code: "import { shareAsync } from 'expo-sharing';", errors: [{ messageId: 'call' }] },
    // r7: Share under another name.
    { code: "import { Share as RNShare } from 'react-native';\nRNShare.share({ message: text });", errors: [{ messageId: 'call' }] },
    { code: "import * as RN from 'react-native';\nRN.Share.share({ message: text });", errors: [{ messageId: 'call' }] },
  ],
});

tester.run('navigation-after-await', plugin.rules['navigation-after-await'], {
  valid: [
    // A tap: nothing can be tapped while locked.
    'const onPress = () => router.back();',
    // Before any await.
    'async function f() { router.push("/a"); await save(); }',
    // Held until unlocked.
    'async function f() { await save(); navigateWhenUnlocked(() => router.replace("/viewer")); }',
    // A callback defined after an await (a toast's Undo button) is a later tap.
    'async function f() { await save(); toast.show("Saved", { onPress: () => router.replace("/v") }); }',
    // Not a router.
    'async function f() { await save(); history.back(); list.push(1); }',
    // An await in a nested function doesn't count for the outer one.
    'function f() { run(async () => { await x; }); router.back(); }',
    // r7: a JSX handler created after an await is still a tap.
    'async function f() { await load(); return <Button onPress={() => router.back()} />; }',
    // A timer set up before any await.
    'function f() { setTimeout(() => router.back(), 300); }',
    // A guarded timer callback.
    'async function f() { await save(); setTimeout(() => navigateWhenUnlocked(() => router.back()), 0); }',
    // An aliased router used before any await.
    'function f() { const r = router; r.back(); }',
    // A local function that only navigates through the guard.
    'async function f() { const done = () => navigateWhenUnlocked(() => router.back()); await save(); done(); }',
    // A local function that doesn't navigate.
    'async function f() { const done = () => setBusy(false); await save(); done(); save().then(done); }',
    // An action sheet from a tap.
    'function onMore() { ActionSheetIOS.showActionSheetWithOptions({ options }, i => pick(i)); }',
    // Destructured router method before any await.
    'function F() { const { back } = useRouter(); back(); }',
  ],
  invalid: [
    { code: 'async function f() { await save(); router.back(); }', errors: [{ messageId: 'afterAwait' }] },
    { code: 'const f = async () => { const id = await save(); router.replace({ pathname: "/viewer", params: { id } }); };', errors: [{ messageId: 'afterAwait' }] },
    { code: 'async function f() { router.push(await nextRoute()); }', errors: [{ messageId: 'afterAwait' }] },
    { code: 'async function f() { for (const p of pages) { router.push(p); await save(p); } }', errors: [{ messageId: 'afterAwait' }] },
    { code: 'async function f() { for await (const p of pages) { router.dismissTo(p); } }', errors: [{ messageId: 'afterAwait' }] },
    { code: 'save().then(() => router.back());', errors: [{ messageId: 'inCallback' }] },
    { code: 'save().finally(() => { navigation.navigate("Home"); });', errors: [{ messageId: 'inCallback' }] },
    // r7 holes, one fixture each.
    // setTimeout / requestAnimationFrame navigation after an await.
    { code: 'async function f() { await save(); setTimeout(() => router.back(), 0); }', errors: [{ messageId: 'deferred' }] },
    { code: 'async function f() { await save(); requestAnimationFrame(() => { router.replace("/viewer"); }); }', errors: [{ messageId: 'deferred' }] },
    { code: 'save().then(() => { setTimeout(() => router.back(), 0); });', errors: [{ messageId: 'deferred' }] },
    { code: 'async function f() { await save(); InteractionManager.runAfterInteractions(function () { router.push("/a"); }); }', errors: [{ messageId: 'deferred' }] },
    // Router aliases and destructuring.
    { code: 'async function f() { const r = router; await save(); r.back(); }', errors: [{ messageId: 'afterAwait' }] },
    { code: 'function F() { const r = useRouter(); const go = async () => { await save(); r.replace("/viewer"); }; }', errors: [{ messageId: 'afterAwait' }] },
    { code: 'async function f() { const { back } = router; await save(); back(); }', errors: [{ messageId: 'afterAwait' }] },
    { code: 'function F() { const { replace: go } = useRouter(); return async () => { await save(); go("/viewer"); }; }', errors: [{ messageId: 'afterAwait' }] },
    { code: 'async function f() { const go = router.push; await save(); go("/a"); }', errors: [{ messageId: 'afterAwait' }] },
    { code: "import { router as r } from 'expo-router';\nasync function f() { await save(); r.dismiss(); }", errors: [{ messageId: 'afterAwait' }] },
    { code: "import { useRouter as useR } from 'expo-router';\nfunction F() { const x = useR(); return async () => { await save(); x.back(); }; }", errors: [{ messageId: 'afterAwait' }] },
    // ActionSheetIOS after an await (its buttons aren't covered by the alert guard).
    { code: 'async function f() { await load(); ActionSheetIOS.showActionSheetWithOptions({ options }, pick); }', errors: [{ messageId: 'sheet' }] },
    { code: 'load().then(() => ActionSheetIOS.showActionSheetWithOptions({ options }, pick));', errors: [{ messageId: 'sheet' }] },
    // A named function that navigates, handed to a promise / timer or called late.
    { code: 'function done() { router.back(); }\nsave().then(done);', errors: [{ messageId: 'indirect' }] },
    { code: 'const done = () => router.back();\nsave().catch(done);', errors: [{ messageId: 'indirect' }] },
    { code: 'function F() { const done = useCallback(() => router.back(), []); save().then(done); }', errors: [{ messageId: 'indirect' }] },
    { code: 'save().then(router.back);', errors: [{ messageId: 'inCallback' }] },
    { code: 'async function f() { const done = () => router.back(); await save(); done(); }', errors: [{ messageId: 'indirect' }] },
    { code: 'async function f() { const close = () => router.back(); await save(); setTimeout(close, 300); }', errors: [{ messageId: 'indirect' }] },
    { code: 'async function f() { await save(); setTimeout(router.back, 300); }', errors: [{ messageId: 'indirect' }] },
    // Through two local functions.
    { code: 'function close() { router.back(); }\nfunction finish() { close(); }\nsave().then(finish);', errors: [{ messageId: 'indirect' }] },
  ],
});

/** Every source file the rules apply to (same globs as eslint.config.js). */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  ['app', 'components', 'contexts', 'lib'].forEach(d => walk(path.join(ROOT, d)));
  return out;
}

describe('the app source', () => {
  const files = sourceFiles();

  test('finds the source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test('has no unguarded native presentation or post-await navigation', () => {
    const linter = new Linter({ configType: 'flat' });
    const problems: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      const rules: Record<string, 'error' | 'off'> = {};
      for (const name of Object.keys(plugin.rules)) {
        rules[`lock-safe/${name}`] = (LOCK_SAFE_ALLOWLIST[name] ?? []).includes(rel) ? 'off' : 'error';
      }
      const messages = linter.verify(
        fs.readFileSync(file, 'utf8'),
        [{
          files: ['**/*.ts', '**/*.tsx'],
          languageOptions,
          plugins: { 'lock-safe': plugin },
          linterOptions: { reportUnusedDisableDirectives: 'off' },
          rules,
        }],
        rel,
      );
      for (const m of messages) {
        // Only this guard's findings (and parse failures); disable comments
        // for the expo config's other rules are none of its business.
        if (m.fatal || m.ruleId?.startsWith('lock-safe/')) problems.push(`${rel}:${m.line}:${m.column} ${m.message}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('a deliberate exception is allowed with a disable comment', () => {
    const linter = new Linter({ configType: 'flat' });
    const config = [{
      files: ['**/*.ts'],
      languageOptions,
      plugins: { 'lock-safe': plugin },
      rules: { 'lock-safe/navigation-after-await': 'error' as const },
    }];
    const code = (comment: string) =>
      `async function f() {\n  await save();\n${comment}  router.back();\n}\n`;
    expect(linter.verify(code(''), config, 'x.ts')).toHaveLength(1);
    expect(
      linter.verify(code('  // eslint-disable-next-line lock-safe/navigation-after-await -- runs before any lock can engage\n'), config, 'x.ts'),
    ).toHaveLength(0);
  });

  test('the helpers that may present still wait for the unlock themselves', () => {
    const share = fs.readFileSync(path.join(ROOT, 'lib/share.ts'), 'utf8');
    const photos = fs.readFileSync(path.join(ROOT, 'lib/photos.ts'), 'utf8');
    // Each native presenter is preceded, in its function, by whenUnlocked().
    for (const [src, call] of [
      [share, 'Sharing.shareAsync('],
      [share, 'Print.printAsync('],
      [share, 'Share.share('],
      [photos, 'MediaLibrary.saveToLibraryAsync('],
      [photos, 'MediaLibrary.requestPermissionsAsync('],
    ] as const) {
      const at = src.indexOf(call);
      expect(at).toBeGreaterThan(-1);
      const fnStart = src.lastIndexOf('export async function', at);
      expect(src.slice(fnStart, at)).toContain('await whenUnlocked()');
    }
  });
});

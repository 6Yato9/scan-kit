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
  ],
  invalid: [
    { code: 'async function f() { await save(); router.back(); }', errors: [{ messageId: 'afterAwait' }] },
    { code: 'const f = async () => { const id = await save(); router.replace({ pathname: "/viewer", params: { id } }); };', errors: [{ messageId: 'afterAwait' }] },
    { code: 'async function f() { router.push(await nextRoute()); }', errors: [{ messageId: 'afterAwait' }] },
    { code: 'async function f() { for (const p of pages) { router.push(p); await save(p); } }', errors: [{ messageId: 'afterAwait' }] },
    { code: 'async function f() { for await (const p of pages) { router.dismissTo(p); } }', errors: [{ messageId: 'afterAwait' }] },
    { code: 'save().then(() => router.back());', errors: [{ messageId: 'inCallback' }] },
    { code: 'save().finally(() => { navigation.navigate("Home"); });', errors: [{ messageId: 'inCallback' }] },
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

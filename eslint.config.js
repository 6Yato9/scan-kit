// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const lockSafe = require('./eslint-rules/lock-safe');

/**
 * Files that ARE the App Lock machinery and may call the native presenters /
 * navigate directly. Keep this list short; for a one-off exception use an
 * `// eslint-disable-next-line lock-safe/<rule> -- <reason>` comment instead
 * (see eslint-rules/lock-safe.js).
 */
const LOCK_SAFE_ALLOWLIST = {
  // The lock-aware wrappers themselves: they await whenUnlocked() first.
  // lib/text-actions.ts: the system New Event / New Contact forms, same pattern.
  'native-presenter': ['lib/share.ts', 'lib/photos.ts', 'lib/text-actions.ts'],
  // Pushes and pops the /lock route itself.
  'navigation-after-await': ['components/lock-gate.tsx', 'app/lock.tsx'],
};

module.exports = defineConfig([
  expoConfig,
  {
    // `.claude/worktrees/` holds agent worktree checkouts — full copies of the
    // project. Linting them double-reports every finding against stale copies.
    ignores: ['dist/*', '.claude/**'],
  },
  {
    // App Lock regression guard (eslint-rules/lock-safe.js).
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'contexts/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    plugins: { 'lock-safe': lockSafe },
    rules: {
      'lock-safe/native-presenter': 'error',
      'lock-safe/navigation-after-await': 'error',
    },
  },
  ...Object.entries(LOCK_SAFE_ALLOWLIST).map(([rule, files]) => ({
    files,
    rules: { [`lock-safe/${rule}`]: 'off' },
  })),
]);

module.exports.LOCK_SAFE_ALLOWLIST = LOCK_SAFE_ALLOWLIST;

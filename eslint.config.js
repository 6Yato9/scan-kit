// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // `.claude/worktrees/` holds agent worktree checkouts — full copies of the
    // project. Linting them double-reports every finding against stale copies.
    ignores: ['dist/*', '.claude/**'],
  },
]);

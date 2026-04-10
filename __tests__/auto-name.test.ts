// __tests__/auto-name.test.ts
import { autoName } from '../lib/auto-name';

test('generates name with Scan prefix and formatted date', () => {
  const date = new Date(2026, 3, 10); // April 10 2026 (month is 0-indexed)
  expect(autoName(date)).toBe('Scan Apr 10, 2026');
});

test('defaults to current date and matches pattern', () => {
  expect(autoName()).toMatch(/^Scan \w+ \d+, \d{4}$/);
});

// "Open in Scan Kit" from a cold start lands on /import, which replaces itself
// with the viewer. The root stack must still have the tabs under it, so closing
// the viewer goes Home instead of nowhere (critique H2).
import { Text } from 'react-native';
import { Stack } from 'expo-router';
import { renderRouter, screen, testRouter } from 'expo-router/testing-library';

// The real root layout pulls in the whole app; only its route settings matter here.
jest.mock('../lib/review-prompt', () => ({ recordWin: jest.fn(() => Promise.resolve()), maybeAskForReview: jest.fn(), noteAppOpened: jest.fn(() => Promise.resolve()), openStoreReviewPage: jest.fn() }));
jest.mock('@/contexts/scan-context', () => ({ ScanProvider: ({ children }: any) => children }));
jest.mock('@/contexts/theme-context', () => ({ ThemeProvider: ({ children }: any) => children, useTheme: () => ({ colors: {}, isDark: false }) }));
jest.mock('@/components/toast', () => ({ ToastProvider: ({ children }: any) => children }));
jest.mock('@/components/error-boundary', () => ({ ErrorBoundary: ({ children }: any) => children }));
jest.mock('@/components/filter-baker', () => ({ FilterBaker: () => null }));
jest.mock('@/components/bake-indicator', () => ({ BakeIndicator: () => null }));
jest.mock('@/components/lock-gate', () => ({ LockGate: ({ children }: any) => children }));
jest.mock('@/lib/bake', () => ({ bakePage: jest.fn() }));
jest.mock('@/lib/files', () => ({ garbageCollectOrphans: jest.fn() }));
jest.mock('@/lib/storage-layout', () => ({ ensureStorageLayout: jest.fn() }));
jest.mock('@/lib/storage', () => ({}));

import { unstable_settings } from '../app/_layout';

function page(name: string) {
  return function Page() {
    return <Text>{name}</Text>;
  };
}

function routes() {
  return {
    _layout: { default: () => <Stack />, unstable_settings },
    '(tabs)/_layout': () => <Stack />,
    '(tabs)/index': page('home'),
    import: page('import'),
    viewer: page('viewer'),
  };
}

test('the root layout anchors the stack on the tabs', () => {
  expect(unstable_settings).toEqual({ anchor: '(tabs)' });
});

test('a cold start on /import keeps Home under it, so the viewer can close', () => {
  const view = renderRouter(routes(), { initialUrl: '/import' });
  expect(view.getPathname()).toBe('/import');
  testRouter.replace('/viewer');
  expect(testRouter.canGoBack()).toBe(true);
  testRouter.back('/');
  expect(screen.getByText('home')).toBeTruthy();
});

test('without the anchor the same launch is a dead end (what H2 was)', () => {
  const { _layout, ...rest } = routes();
  renderRouter({ ...rest, _layout: { default: _layout.default } }, { initialUrl: '/import' });
  testRouter.replace('/viewer');
  expect(testRouter.canGoBack()).toBe(false);
});

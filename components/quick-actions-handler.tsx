// components/quick-actions-handler.tsx
// Runs home-screen quick actions (lib/quick-actions.ts has the policy). Mounted
// once in app/_layout.tsx, after LockGate: inside ScanProvider (it scans and
// imports like the in-app buttons) and outside the lock, which it waits for.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname, useRootNavigationState, useRouter } from 'expo-router';
import { useScan } from '@/contexts/scan-context';
import { useImportDocuments } from '@/components/use-import';
import { getAppLockEnabled, getOnboarded, getOnboardedSync } from '@/lib/storage';
import { isAppLocked, isNavigationHeld, navigateWhenUnlocked } from '@/lib/nav-guard';
import { isSystemUIOpen } from '@/lib/system-ui';
import { isCaptureSessionOpen } from '@/lib/capture-session';
import { noteNewDocument } from '@/lib/new-doc-note';
import {
  isOverlayPresented,
  isQuickActionStale,
  appStackRoutes,
  isViewerIdle,
  onlyViewerAboveTabs,
  listenForQuickActions,
  quickActionStep,
  waitForLockSettled,
  type QuickActionId,
  type QuickActionState,
} from '@/lib/quick-actions';

/** Cold start: let the first screen settle before presenting the camera or a picker over it. */
const COLD_START_SETTLE_MS = 300;

type Request = { action: QuickActionId; at: number };

export function QuickActionsHandler() {
  const router = useRouter();
  const pathname = usePathname();
  const rootState = useRootNavigationState();
  const navReady = !!rootState?.key;
  const { triggerScan, scanning, saving } = useScan();
  const { importImages, importFile } = useImportDocuments();
  const [request, setRequest] = useState<Request | null>(null);
  const [settled, setSettled] = useState(false);

  // Read fresh when a held action finally runs.
  // (Written after render, never during it: the React Compiler skips
  // components that write refs while rendering.)
  const live = useRef({ pathname, busy: scanning || saving, routes: appStackRoutes(rootState) });
  const run = useRef({ triggerScan, importImages, importFile });
  useLayoutEffect(() => {
    live.current = { pathname, busy: scanning || saving, routes: appStackRoutes(rootState) };
    run.current = { triggerScan, importImages, importFile };
  });

  useEffect(() => listenForQuickActions(action => setRequest({ action, at: Date.now() })), []);

  // App Lock's flag and the onboarding flag are read asynchronously on a cold
  // start; nothing may run before both are known.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      waitForLockSettled({ readEnabled: getAppLockEnabled, isLocked: isAppLocked }),
      getOnboardedSync() === null ? getOnboarded().catch(() => false) : Promise.resolve(),
      new Promise(r => setTimeout(r, COLD_START_SETTLE_MS)),
    ]).then(() => { if (!cancelled) setSettled(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!request || !navReady || !settled) return;
    if (isQuickActionStale(request.at)) {
      setRequest(null);
      return;
    }
    const state = (overlay: boolean | null): QuickActionState => ({
      onboarded: getOnboardedSync(),
      pathname: live.current.pathname,
      held: isNavigationHeld(),
      lockSettled: true,
      capturing: live.current.busy || isCaptureSessionOpen() || isSystemUIOpen(),
      overlay,
      idleViewer: isViewerIdle() && onlyViewerAboveTabs(live.current.routes),
    });
    // Held while locked; runs once unlocked and the lock screen has gone.
    return navigateWhenUnlocked(() => {
      const first = quickActionStep(request.action, state(null));
      // Onboarding / an import still on screen: this effect runs again when
      // the route changes.
      if (first.kind === 'wait') return;
      setRequest(null);
      if (first.kind === 'ignore') return;
      void (async () => {
        const step = quickActionStep(request.action, state(await isOverlayPresented()));
        if (step.kind !== 'run') return;
        const { triggerScan: scan, importImages: photos, importFile: file } = run.current;
        if (request.action === 'scan') {
          // Exactly the tab bar's Scan button (app/(tabs)/_layout.tsx).
          const id = await scan();
          if (id) noteNewDocument(id);
          if (id) navigateWhenUnlocked(() => router.push({ pathname: '/viewer', params: { id } }));
        } else if (request.action === 'import-photos') {
          await photos();
        } else if (request.action === 'import-file') {
          await file();
        } else if (step.over === 'idle-viewer') {
          // A plain viewer is closed first, exactly like its back button
          // (nothing in it is lost), then Files opens with search focused.
          navigateWhenUnlocked(() => router.dismissTo({ pathname: '/files', params: { search: '1' } }));
        } else {
          // Home's search button: Files with the search field focused.
          navigateWhenUnlocked(() => router.navigate({ pathname: '/files', params: { search: '1' } }));
        }
      })().catch(err => console.error('Quick action failed', err));
    });
  }, [request, navReady, settled, pathname, router]);

  return null;
}

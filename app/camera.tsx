// app/camera.tsx
// Scan Kit's document camera: the native preview (modules/vision-ocr
// DocumentCameraView) fills the whole screen, edge to edge, with every control
// floating over it on glass, followed by a review of the captured pages
// before anything is saved.
//
// Opened through a capture session (lib/capture-session.ts, via
// lib/tool-scan.ts scanPagesWithCamera) by the Scan button, the viewer's Add
// pages and Retake, and the camera-first tools. The screen hands the reviewed
// pages (photo + crop) back to the session when Save is tapped and closes; the
// caller saves them. Nothing is written to the user's documents here.
//
// Capture:
//  - The preview covers the screen aspect-fill (the feed is 3:4 upright, 4:3 on
//    an iPad turned sideways; the native view turns the feed and the photo with
//    the interface), so a strip at the sides (top and bottom on a turned iPad)
//    is photographed but not shown — the photo holds a little more, never less.
//    The native view draws the outline in its own, aspect-fill coordinates;
//    RN geometry over the preview uses the same rule (lib/camera-layout.ts).
//  - Floating chrome: close, flash and auto-capture at the top; one status pill
//    below them (the mode title and what to do now); the stack, the shutter
//    and Done at the bottom. The status bar is hidden while the camera shows.
//  - Auto-capture (remembered in Scan settings) fires once the page holds
//    steady; the shutter's ring fills with the native `stability`. Manual mode
//    hides the ring. Batch by default: each capture flies from where the page
//    was on screen into the stack at the bottom left (its badge counts them);
//    "Done" opens the review. The native view remembers the last shot across
//    the review, so the page still under the camera isn't taken twice while
//    the next sheet (even in the same spot) is; a retake re-arms it (rearm).
//  - The subject (page, card, board, book: lib/capture-session captureSubject)
//    names what the status line asks for; a card gets a guide frame, and the ID
//    card asks for the front, then the back.
//  - The system can pause the camera (another app takes it, iPad Split View,
//    heat): the preview says so and the shutter waits until it resumes.
//  - "Review each page" (Scan settings) opens the review after every capture;
//    a page limit (a retake: 1) opens it when reached.
// Review (components/capture-review.tsx): crop on the whole photo
// (components/crop-modal.tsx), rotate, retake, delete, reorder.
//
// App Lock / background: the camera runs only while this screen is focused,
// the app is active and unlocked (`active`); the native session also stops by
// itself in the background. Coming back to the app retries a camera that was
// refused (access just granted in Settings) or had failed. The lock covers this screen like any other (the
// /lock route above it, LockCoverScreen as a fallback); captured pages stay in
// this screen's state, so after unlocking the user carries on where they were.
//
// Files: see lib/capture-session.ts. Every photo and preview this screen sees
// is tracked; on close, everything not handed over is deleted.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  BackHandler,
  Easing,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeSyntheticEvent,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Directory, File, Paths } from 'expo-file-system';
import { useTheme } from '@/contexts/theme-context';
import { useAppLocked } from '@/components/lock-gate';
import {
  CameraMessage,
  CaptureStack,
  ChromePill,
  GlassIconButton,
  SHUTTER_HALO,
  STACK_H,
  STACK_W,
  ShutterButton,
  StatusPill,
  type StatusTone,
} from '@/components/camera-controls';
import { CaptureReview } from '@/components/capture-review';
import { CropModal } from '@/components/crop-modal';
import { movedOrder } from '@/components/thumbnail-strip';
import {
  DocumentCameraView,
  isDocumentCameraAvailable,
  type CameraCaptureEvent,
  type CameraDetectionEvent,
  type CameraErrorEvent,
  type CameraStateEvent,
  type DocumentCameraRef,
} from '@/modules/vision-ocr/src';
import {
  CARD_ASPECT,
  cameraPausedMessage,
  cameraStatus,
  captureSubject,
  cardSide,
  claimCaptureSession,
  endCaptureSession,
  initialGeometry,
  maxCornerDelta,
  NEW_PAGE_DELTA,
  setCaptureResult,
  type CapturedPage,
} from '@/lib/capture-session';
import { renderGeometry, type CropTarget } from '@/lib/page-source';
import { rotateGeometry, sameGeometry, type PageGeometry } from '@/lib/quad';
import { cameraTempUri, deleteTempFiles } from '@/lib/tool-scan';
import { getScanSettings, saveScanSettings, type ScanSettings } from '@/lib/storage';
import { notifyWarning, tapLight, tapMedium } from '@/lib/haptics';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { Radius, Spacing, Type } from '@/lib/theme';
import {
  CAMERA_CONTROLS,
  aspectFillRect,
  cameraChromeLayout,
  centredFrame,
  flyTransform,
  quadScreenRect,
  type Rect,
} from '@/lib/camera-layout';

type Flash = 'off' | 'auto' | 'on';
type CameraState = 'ready' | 'permission' | 'unavailable' | 'failed';

const FLASH_NEXT: Record<Flash, Flash> = { auto: 'on', on: 'off', off: 'auto' };
const FLASH_ICON = { auto: 'flash-outline', on: 'flash', off: 'flash-off-outline' } as const;
const FLASH_LABEL: Record<Flash, string> = { auto: 'Auto', on: 'On', off: 'Off' };

/** Long edge of the review's page previews. */
const PREVIEW_MAX_EDGE = 1400;
/** A manual capture's "Page N captured" stays this long. */
const CAPTURED_NOTE_MS = 2000;

/** Dev only: test photos in Caches/dev-camera feed the simulator's camera (it has none). */
function devPhotos(): string[] {
  if (!__DEV__) return [];
  try {
    const dir = new Directory(Paths.cache, 'dev-camera');
    if (!dir.exists) return [];
    return dir
      .list()
      .filter((f): f is File => f instanceof File && /\.(jpe?g|png|heic)$/i.test(f.uri))
      .map(f => f.uri)
      .sort();
  } catch {
    return [];
  }
}

function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

let pageSeq = 0;

/** Dev only: recent camera events for driving the simulator from a debugger (globalThis.__camLog). */
function devLog(entry: string): void {
  const g = globalThis as { __camLog?: string[] };
  g.__camLog = [...(g.__camLog ?? []).slice(-80), `${Date.now() % 100000}:${entry}`];
}

export default function CameraScreen() {
  const { session } = useLocalSearchParams<{ session?: string }>();
  const sessionId = typeof session === 'string' ? session : '';
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: W, height: H } = useWindowDimensions();
  const locked = useAppLocked();
  const focused = useIsFocused();
  const appActive = useAppActive();

  const [options] = useState(() => claimCaptureSession(sessionId));
  const maxPages = options?.maxPages && options.maxPages > 0 ? options.maxPages : Infinity;
  const doneLabel = options?.doneLabel ?? 'Save';
  const subject = captureSubject(options);

  // A stale route (no session: a dev reload) has nothing to do.
  useEffect(() => {
    if (options) return;
    return navigateWhenUnlocked(() => { if (router.canGoBack()) router.back(); });
  }, [options, router]);

  // ── Settings ──────────────────────────────────────────────────────────────
  const [settings, setSettings] = useState<ScanSettings | null>(null);
  useEffect(() => {
    let live = true;
    getScanSettings().then(
      s => { if (live) setSettings(s); },
      () => { if (live) setSettings({ quality: 'medium', autoCrop: true, defaultFilter: 'enhanced' }); },
    );
    return () => { live = false; };
  }, []);
  const autoCapture = settings?.autoCapture !== false;
  const flash: Flash = settings?.cameraFlash ?? 'auto';
  const reviewEachRef = useRef(false);
  reviewEachRef.current = settings?.reviewEachPage === true;
  const changeSettings = useCallback((patch: Partial<ScanSettings>) => {
    setSettings(s => (s ? { ...s, ...patch } : s));
    getScanSettings().then(s => saveScanSettings({ ...s, ...patch })).catch(() => {});
  }, []);

  // ── Pages and files ───────────────────────────────────────────────────────
  const [pages, setPagesState] = useState<CapturedPage[]>([]);
  const pagesRef = useRef<CapturedPage[]>([]);
  const setPages = useCallback((next: CapturedPage[]) => {
    pagesRef.current = next;
    setPagesState(next);
  }, []);
  const files = useRef(new Set<string>());
  const mounted = useRef(true);
  const closing = useRef(false);

  const discard = useCallback((uris: (string | null | undefined)[]) => {
    const list = uris.filter((u): u is string => !!u);
    list.forEach(u => files.current.delete(u));
    deleteTempFiles(list);
  }, []);
  const discardPage = useCallback((p: CapturedPage) => {
    discard([p.sourceUri, p.previewUri !== p.sourceUri ? p.previewUri : null]);
  }, [discard]);

  // Leaving: hand the reviewed pages to the caller, delete everything else.
  useEffect(() => {
    const tracked = files.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      const handed = endCaptureSession(sessionId);
      const keep = new Set((handed ?? []).map(p => p.sourceUri));
      deleteTempFiles([...tracked].filter(u => !keep.has(u)));
      tracked.clear();
    };
  }, [sessionId]);

  const [rendering, setRendering] = useState<ReadonlySet<string>>(new Set());
  const renderPreview = useCallback(async (key: string, sourceUri: string, geometry: PageGeometry) => {
    setRendering(r => new Set(r).add(key));
    let uri: string | null = null;
    try {
      uri = await renderGeometry(sourceUri, geometry, cameraTempUri('preview'), 0.8, PREVIEW_MAX_EDGE);
      files.current.add(uri);
      const latest = pagesRef.current.find(p => p.key === key);
      // Gone, closed, or changed again meanwhile (a newer render is coming).
      if (!mounted.current || !latest || !sameGeometry(latest.geometry, geometry)) {
        discard([uri]);
        return;
      }
      const old = latest.previewUri;
      setPages(pagesRef.current.map(p => (p.key === key ? { ...p, previewUri: uri } : p)));
      if (old && old !== latest.sourceUri) discard([old]);
    } catch (err) {
      console.error('Camera: preview', err);
      // Show the photo itself rather than nothing.
      const latest = pagesRef.current.find(p => p.key === key);
      if (mounted.current && latest && !latest.previewUri) {
        setPages(pagesRef.current.map(p => (p.key === key ? { ...p, previewUri: p.sourceUri } : p)));
      }
    } finally {
      if (mounted.current) {
        setRendering(r => {
          const next = new Set(r);
          next.delete(key);
          return next;
        });
      }
    }
  }, [discard, setPages]);

  // ── Modes ─────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'camera' | 'review'>('camera');
  const [index, setIndex] = useState(0);
  const [replaceIndex, setReplaceIndexState] = useState<number | null>(null);
  const replaceRef = useRef<number | null>(null);
  const setReplaceIndex = useCallback((i: number | null) => {
    replaceRef.current = i;
    setReplaceIndexState(i);
  }, []);
  const [cropKey, setCropKey] = useState<string | null>(null);

  // ── Camera ────────────────────────────────────────────────────────────────
  const camRef = useRef<DocumentCameraRef>(null);
  const available = isDocumentCameraAvailable() && !!DocumentCameraView;
  const [cameraState, setCameraState] = useState<CameraState>(available ? 'ready' : 'unavailable');
  const [cameraKey, setCameraKey] = useState(0);
  /** The system paused the camera (CameraStateEvent reason), or null. */
  const [paused, setPaused] = useState<string | null>(null);
  const [quad, setQuad] = useState<number[] | null>(null);
  const [capturing, setCapturing] = useState(false);
  const capturingRef = useRef(false);
  capturingRef.current = capturing;
  const [justCaptured, setJustCaptured] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stability = useRef(new Animated.Value(0)).current;
  const flashAnim = useRef(new Animated.Value(0)).current;

  const photos = useMemo(devPhotos, []);
  const [devIndex, setDevIndex] = useState(0);
  const [devJitter, setDevJitter] = useState(false);
  const simulatorImageUri = photos.length ? photos[devIndex % photos.length] : undefined;
  // Dev only: drive the still feed from a debugger (next sheet, hand-held jitter).
  useEffect(() => {
    if (!__DEV__ || !photos.length) return;
    const g = globalThis as { __camDev?: unknown };
    g.__camDev = { photo: (i: number) => setDevIndex(i), jitter: (on: boolean) => setDevJitter(on) };
    return () => { g.__camDev = undefined; };
  }, [photos.length]);

  const active = !!options && !!settings && focused && appActive && !locked
    && mode === 'camera' && !cropKey && cameraState === 'ready';

  // Paused or hidden: the next time it runs it starts from a clean state.
  useEffect(() => {
    if (active) return;
    setCapturing(false);
    setQuad(null);
    stability.setValue(0);
  }, [active, stability]);

  // Back in the app (from Settings, typically): a camera that was refused or
  // had failed gets another go with a fresh native view. Still refused, it
  // says so again.
  const cameraStateRef = useRef(cameraState);
  cameraStateRef.current = cameraState;
  useEffect(() => {
    if (!appActive) return;
    const st = cameraStateRef.current;
    if (st === 'permission' || st === 'failed') {
      setCameraState('ready');
      setCameraKey(k => k + 1);
    }
  }, [appActive]);
  // A new native view starts unpaused.
  useEffect(() => { setPaused(null); }, [cameraKey]);

  // A manual capture's note fades by itself; an automatic one stays until
  // the page is taken away (the camera waits for a new page).
  useEffect(() => {
    if (justCaptured === null || autoCapture) return;
    const t = setTimeout(() => setJustCaptured(null), CAPTURED_NOTE_MS);
    return () => clearTimeout(t);
  }, [justCaptured, autoCapture]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  // Auto-capture held until a new page is shown (see NEW_PAGE_DELTA): set
  // when returning from the review, where the page just taken is often still
  // under the camera.
  const [held, setHeldState] = useState(false);
  const heldRef = useRef(false);
  const setHeld = useCallback((v: boolean) => {
    heldRef.current = v;
    setHeldState(v);
  }, []);
  const liveQuad = useRef<number[] | null>(null);
  const shotQuad = useRef<number[] | null>(null);

  const onDetection = useCallback((e: NativeSyntheticEvent<CameraDetectionEvent>) => {
    const { quad: q, stability: s } = e.nativeEvent;
    if (__DEV__) devLog(`${q ? 'q' : '-'}${s.toFixed(2)}`);
    liveQuad.current = q;
    if (heldRef.current && (!q || !shotQuad.current || maxCornerDelta(q, shotQuad.current) > NEW_PAGE_DELTA)) {
      setHeld(false);
    }
    const holding = heldRef.current;
    setQuad(prev => (prev === null && q === null ? prev : q));
    if (!q) setJustCaptured(null);
    else if (s > 0.15 && !holding) setJustCaptured(null);
    Animated.timing(stability, { toValue: q && !holding ? s : 0, duration: 140, easing: Easing.linear, useNativeDriver: true }).start();
  }, [stability, setHeld]);

  const onCaptureStart = useCallback(() => {
    if (__DEV__) devLog('START');
    shotQuad.current = liveQuad.current;
    setCapturing(true);
    setNotice(null);
    tapMedium();
    flashAnim.setValue(0.85);
    Animated.timing(flashAnim, { toValue: 0, duration: 320, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [flashAnim]);

  // ── Layout ────────────────────────────────────────────────────────────────
  // The preview is the whole screen; the controls float over it, inside the
  // safe area (lib/camera-layout.ts).
  const chrome = cameraChromeLayout(W, H, insets);
  /** The top card of the stack (CaptureStack centres it in its hit box at the left of the bottom row). */
  const stackRect: Rect = {
    x: chrome.padLeft + 10,
    y: chrome.controlsY + (CAMERA_CONTROLS - STACK_H) / 2,
    w: STACK_W,
    h: STACK_H,
  };

  // The captured page flies from where it was on screen into the stack.
  type Flight = { key: string; uri: string; from: Rect; photo: Rect };
  const [flying, setFlying] = useState<Flight | null>(null);
  const fly = useRef(new Animated.Value(0)).current;
  const flyTo = useCallback((flight: Flight) => {
    const { key } = flight;
    setFlying(flight);
    fly.setValue(0);
    Animated.timing(fly, { toValue: 1, duration: 460, easing: Easing.bezier(0.2, 0.8, 0.2, 1), useNativeDriver: true }).start(() => {
      setFlying(f => (f?.key === key ? null : f));
    });
  }, [fly]);

  const onCapture = useCallback((e: NativeSyntheticEvent<CameraCaptureEvent>) => {
    setCapturing(false);
    const { sourceUri, width, height, quad: q } = e.nativeEvent;
    // Where the page was on screen: the photo has the feed's shape and is
    // shown aspect-fill like the preview. No outline: the whole screen.
    const photoAspect = width > 0 && height > 0 ? width / height : 3 / 4;
    const flight = {
      uri: sourceUri,
      from: quadScreenRect(q, photoAspect, W, H) ?? { x: 0, y: 0, w: W, h: H },
      photo: aspectFillRect(photoAspect, W, H),
    };
    if (__DEV__) devLog(`CAPTURE ${sourceUri.split('/').pop()}`);
    if (!mounted.current || closing.current) {
      deleteTempFiles([sourceUri]);
      return;
    }
    files.current.add(sourceUri);
    const { geometry, detected } = initialGeometry(q);
    const page: CapturedPage = { key: `page-${++pageSeq}`, sourceUri, width, height, geometry, detected, previewUri: null };
    const list = pagesRef.current;
    const r = replaceRef.current;
    if (r !== null && r < list.length) {
      // Retake from the review: the new photo takes the page's place.
      const next = list.slice();
      discardPage(next[r]);
      next[r] = page;
      setPages(next);
      setReplaceIndex(null);
      setIndex(r);
      setMode('review');
    } else {
      if (list.length >= maxPages) {
        discard([sourceUri]);
        return;
      }
      const next = [...list, page];
      setPages(next);
      if (next.length >= maxPages || reviewEachRef.current) {
        setIndex(next.length - 1);
        setMode('review');
      } else {
        setJustCaptured(next.length);
        flyTo({ key: page.key, ...flight });
      }
    }
    renderPreview(page.key, sourceUri, geometry);
  }, [W, H, discard, discardPage, flyTo, maxPages, renderPreview, setPages, setReplaceIndex]);

  const activeRef = useRef(false);
  activeRef.current = active;
  const onCameraError = useCallback((e: NativeSyntheticEvent<CameraErrorEvent>) => {
    const { code, capture } = e.nativeEvent;
    const wasCapturing = capturingRef.current;
    setCapturing(false);
    if (code === 'permission') setCameraState('permission');
    else if (code === 'unavailable') setCameraState('unavailable');
    // One shot failed, the camera keeps running: say so and let them try
    // again. A shot cut short by leaving the screen or the app isn't news.
    else if (capture || wasCapturing) {
      if (activeRef.current) setNotice('Couldn’t take the photo – try again');
    } else if (activeRef.current) setCameraState('failed');
  }, []);

  const onCameraState = useCallback((e: NativeSyntheticEvent<CameraStateEvent>) => {
    const { state, reason } = e.nativeEvent;
    if (__DEV__) devLog(`STATE ${state}${reason ? ` ${reason}` : ''}`);
    setPaused(state === 'paused' ? reason ?? 'other' : null);
    if (state === 'paused') {
      setCapturing(false);
      setQuad(null);
      stability.setValue(0);
    }
  }, [stability]);

  const shoot = useCallback(() => {
    if (!camRef.current || capturingRef.current) return;
    camRef.current.capture().catch((err: { code?: string }) => {
      setCapturing(false);
      if (err?.code === 'busy' || err?.code === 'not-running') return;
      notifyWarning();
      setNotice('Couldn’t take the photo – try again');
    });
  }, []);

  /** Newer native views remember the last shot across pauses (no JS hold needed) and can forget it. */
  const nativeRemembers = () => typeof camRef.current?.rearm === 'function';
  const rearmCamera = () => { camRef.current?.rearm?.().catch(() => {}); };

  // ── Actions ───────────────────────────────────────────────────────────────
  // Started by a tap, so this runs at once (the review's Save reaches it
  // through a prop the lock lint can't see is a tap).
  const closeScreen = () => {
    closing.current = true;
    navigateWhenUnlocked(() => router.back());
  };

  const handleClose = () => {
    if (replaceRef.current !== null) {
      // Cancels the retake: back to the review, page unchanged.
      setReplaceIndex(null);
      setMode('review');
      return;
    }
    const n = pagesRef.current.length;
    if (!n) {
      closeScreen();
      return;
    }
    Alert.alert(
      n === 1 ? 'Discard this page?' : `Discard ${n} pages?`,
      'The pages you captured won’t be saved.',
      [
        { text: 'Keep scanning', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: closeScreen },
      ],
    );
  };

  const handleSave = () => {
    const list = pagesRef.current;
    if (!list.length || closing.current) return;
    setCaptureResult(sessionId, list);
    closeScreen();
  };

  const openReview = (at = 0) => {
    if (!pagesRef.current.length) return;
    tapLight();
    setIndex(Math.min(at, pagesRef.current.length - 1));
    setMode('review');
  };

  const backToCamera = () => {
    // At the page limit, going back means taking this page again.
    if (pagesRef.current.length >= maxPages) {
      setReplaceIndex(index);
      setJustCaptured(null);
      setHeld(false);
      rearmCamera();
    } else {
      setJustCaptured(pagesRef.current.length);
      // The page just taken is often still under the camera. A native view
      // that remembers its last shot handles that itself (and still takes a
      // new sheet put in the same spot); an older one is held in JS.
      setHeld(!nativeRemembers());
    }
    setMode('camera');
  };

  const updateGeometry = (key: string, geometry: PageGeometry) => {
    const page = pagesRef.current.find(p => p.key === key);
    if (!page) return;
    setPages(pagesRef.current.map(p => (p.key === key ? { ...p, geometry } : p)));
    renderPreview(key, page.sourceUri, geometry);
  };

  const handleRotate = (i: number) => {
    const page = pagesRef.current[i];
    if (!page) return;
    tapLight();
    updateGeometry(page.key, rotateGeometry(page.geometry, 90));
  };

  const handleRetake = (i: number) => {
    setReplaceIndex(i);
    setJustCaptured(null);
    setHeld(false);
    // Retaking is often the same page again: let it be auto-captured.
    rearmCamera();
    setMode('camera');
  };

  const handleDelete = (i: number) => {
    const list = pagesRef.current;
    const page = list[i];
    if (!page) return;
    tapLight();
    discardPage(page);
    const next = list.filter((_, j) => j !== i);
    setPages(next);
    if (!next.length) {
      setIndex(0);
      setMode('camera');
    } else {
      setIndex(Math.min(i, next.length - 1));
    }
  };

  const handleReorder = (from: number, to: number) => {
    const list = pagesRef.current;
    const order = movedOrder(list.length, from, to);
    setPages(order.map(k => list[k]));
    setIndex(to);
  };

  // Android back button / gesture: the same as the screen's own back. The
  // crop editor (a Modal) handles it itself.
  const backPress = useRef<() => boolean>(() => false);
  backPress.current = () => {
    if (cropKey) return false;
    if (mode === 'review') backToCamera();
    else handleClose();
    return true;
  };
  useEffect(() => {
    if (!focused || locked) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => backPress.current());
    return () => sub.remove();
  }, [focused, locked]);

  const cropPage = cropKey ? pages.find(p => p.key === cropKey) ?? null : null;
  const cropTarget: CropTarget | undefined = useMemo(
    () => (cropPage ? { uri: cropPage.sourceUri, geometry: cropPage.geometry, hasSource: true, bytes: 0, md5: null } : undefined),
    // The editor reads its target when it opens; later edits come from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cropKey],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  const last = pages[pages.length - 1];
  const retaking = replaceIndex !== null;
  const side = cardSide(options, pages.length, replaceIndex);
  const modeTitle = side && options?.title
    ? `${options.title} – ${side}`
    : retaking
      ? (subject !== 'page' ? `Retake ${subject}` : pages.length > 1 ? `Retake page ${(replaceIndex ?? 0) + 1}` : 'Retake page')
      : options?.title ?? null;
  const status = notice ?? (cameraState === 'ready'
    ? cameraStatus({
      quad,
      stability: 0,
      autoCapture,
      capturing,
      justCaptured,
      guidance: options?.guidance,
      subject,
      side,
      paused: !!paused,
    })
    : '');
  const pausedMessage = paused ? cameraPausedMessage(paused) : null;
  // The pill speaks only while the camera runs; a pause or a missing camera
  // has its own full-screen message.
  const live = cameraState === 'ready' && !pausedMessage;
  const tone: StatusTone = notice ? 'warning' : !capturing && justCaptured !== null ? 'done' : 'normal';
  // A card's guide frame: ID-1 proportions, centred in the free middle of the screen.
  const showCardGuide = subject === 'card' && live && !quad && !capturing;
  const guide = centredFrame(chrome.middle, CARD_ASPECT, 0.85);
  /** Room for a full-screen message: between the top row and the bottom row. */
  const messageArea = { paddingTop: chrome.pillY, paddingBottom: H - chrome.controlsY };
  const Cam = DocumentCameraView;

  const path = flying ? flyTransform(flying.from, stackRect) : { dx: 0, dy: 0, scale: 1 };
  const flyScale = fly.interpolate({ inputRange: [0, 1], outputRange: [1, path.scale] });
  const flyX = fly.interpolate({ inputRange: [0, 1], outputRange: [0, path.dx] });
  const flyY = fly.interpolate({ inputRange: [0, 1], outputRange: [0, path.dy] });
  const flyOpacity = fly.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 1, 0] });

  return (
    <View style={[styles.root, { backgroundColor: colors.chrome }]}>
      {/* Hidden over the live camera only: the review, the lock screen above it and the screen behind keep theirs. */}
      <StatusBar style="light" hidden={mode === 'camera' && focused && !locked} animated />

      {/* Preview: the whole screen, under the status bar and the home indicator. */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.chrome }]}>
        {cameraState === 'ready' && Cam && settings && options ? (
          <Cam
            key={cameraKey}
            ref={camRef}
            style={StyleSheet.absoluteFill}
            autoCapture={autoCapture && !held}
            flash={flash}
            active={active}
            simulatorImageUri={simulatorImageUri}
            simulatorJitter={__DEV__ && devJitter ? 1 : 0}
            onDetection={onDetection}
            onCaptureStart={onCaptureStart}
            onCapture={onCapture}
            onCameraError={onCameraError}
            onCameraState={onCameraState}
          />
        ) : null}
        {showCardGuide && (
          <View pointerEvents="none" style={[styles.guide, { left: guide.x, top: guide.y, width: guide.w, height: guide.h }]}>
            <View style={[styles.guideCorner, styles.guideTL, { borderColor: colors.chromeText, shadowColor: colors.shadow }]} />
            <View style={[styles.guideCorner, styles.guideTR, { borderColor: colors.chromeText, shadowColor: colors.shadow }]} />
            <View style={[styles.guideCorner, styles.guideBR, { borderColor: colors.chromeText, shadowColor: colors.shadow }]} />
            <View style={[styles.guideCorner, styles.guideBL, { borderColor: colors.chromeText, shadowColor: colors.shadow }]} />
          </View>
        )}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.chromeText, opacity: flashAnim }]} />
      </View>

      {/* Full-screen messages: the camera paused, refused, missing or failed. */}
      {pausedMessage && cameraState === 'ready' && (
        <View style={[StyleSheet.absoluteFill, messageArea, { backgroundColor: colors.chrome }]}>
          <CameraMessage icon="pause-circle-outline" title={pausedMessage.title} text={pausedMessage.text} />
        </View>
      )}
      {cameraState === 'permission' && (
        <View style={[StyleSheet.absoluteFill, messageArea]}>
          <CameraMessage
            icon="camera-outline"
            title="Allow camera access"
            text="Scan Kit uses the camera to scan your documents. Photos stay on this device. Turn on Camera for Scan Kit in Settings."
            action={{ title: 'Open Settings', icon: 'settings-outline', onPress: () => { Linking.openSettings().catch(() => {}); } }}
          />
        </View>
      )}
      {cameraState === 'unavailable' && (
        <View style={[StyleSheet.absoluteFill, messageArea]}>
          <CameraMessage
            icon="videocam-off-outline"
            title="Camera not available"
            text="The camera can’t be used on this device right now. You can import photos of your documents instead."
          />
        </View>
      )}
      {cameraState === 'failed' && (
        <View style={[StyleSheet.absoluteFill, messageArea]}>
          <CameraMessage
            icon="camera-outline"
            title="Couldn’t start the camera"
            text="Something interrupted the camera. Try again in a moment."
            action={{ title: 'Try again', icon: 'refresh-outline', onPress: () => { setCameraState('ready'); setCameraKey(k => k + 1); } }}
          />
        </View>
      )}

      {/* Top row: close; flash and auto-capture while the camera runs. */}
      <View style={[styles.topRow, { top: chrome.topRowY, left: chrome.padLeft, right: chrome.padRight }]}>
        <GlassIconButton icon="close" size={24} accessibilityLabel={retaking ? 'Cancel retake' : 'Close camera'} onPress={handleClose} />
        {live ? (
          <View style={styles.topRight}>
            <ChromePill
              icon={FLASH_ICON[flash]}
              label={FLASH_LABEL[flash]}
              active={flash === 'on'}
              accessibilityLabel={`Flash: ${FLASH_LABEL[flash]}`}
              onPress={() => { tapLight(); changeSettings({ cameraFlash: FLASH_NEXT[flash] }); }}
            />
            <ChromePill
              icon={autoCapture ? 'scan-outline' : 'hand-left-outline'}
              label={autoCapture ? 'Auto-capture' : 'Manual'}
              active={autoCapture}
              accessibilityLabel={autoCapture ? 'Capture: automatic. Switch to manual' : 'Capture: manual. Switch to automatic'}
              onPress={() => { tapLight(); changeSettings({ autoCapture: !autoCapture }); }}
            />
          </View>
        ) : null}
      </View>

      {/* Status: one floating pill under the top row. */}
      <View pointerEvents="none" style={[styles.pillRow, { top: chrome.pillY, left: chrome.padLeft, right: chrome.padRight }]}>
        <StatusPill
          title={live ? modeTitle : null}
          text={live ? status : ''}
          tone={tone}
          maxWidth={Math.max(0, W - chrome.padLeft - chrome.padRight)}
        />
      </View>

      {/* Bottom row: the stack of captured pages, the shutter, Done. */}
      <View style={[styles.controls, { top: chrome.controlsY, height: CAMERA_CONTROLS, left: insets.left, right: insets.right }]}>
        <View style={[styles.side, styles.sideLeft]}>
          <CaptureStack
            uri={last ? last.previewUri ?? last.sourceUri : null}
            count={pages.length}
            onPress={() => (retaking ? handleClose() : openReview(pages.length - 1))}
          />
        </View>
        {cameraState === 'ready' ? (
          <ShutterButton
            onPress={shoot}
            disabled={!active || !!paused}
            busy={capturing}
            progress={stability}
            ring={autoCapture && !held}
          />
        ) : (
          <View style={styles.shutterSpace} />
        )}
        <View style={[styles.side, styles.sideRight]}>
          {pages.length > 0 && !retaking ? (
            <Pressable
              onPress={() => openReview(0)}
              accessibilityRole="button"
              accessibilityLabel={`Done, review ${pages.length === 1 ? '1 page' : `${pages.length} pages`}`}
              style={({ pressed }) => [styles.done, { backgroundColor: colors.accentFill, shadowColor: colors.shadow }, pressed && { opacity: 0.7 }]}
            >
              <Text style={[Type.subhead, styles.doneText, { color: colors.onAccent }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>
                Done
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {__DEV__ && photos.length > 0 && live && (
        <Pressable
          onPress={() => setDevIndex(i => i + 1)}
          onLongPress={() => setDevJitter(j => !j)}
          accessibilityRole="button"
          accessibilityLabel="Next test photo"
          accessibilityHint="Long press to toggle hand-held jitter"
          style={[styles.devChip, { left: chrome.padLeft, bottom: H - chrome.controlsY + Spacing.xs, backgroundColor: colors.scrim }]}
        >
          <Text style={[Type.caption, { color: colors.onScrim }]} numberOfLines={1}>
            {`Dev photo ${(devIndex % photos.length) + 1}/${photos.length}${devJitter ? ' + jitter' : ''}: ${decodeURIComponent((simulatorImageUri ?? '').split('/').pop() ?? '')}`}
          </Text>
        </Pressable>
      )}

      {flying && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.flying,
            {
              left: flying.from.x,
              top: flying.from.y,
              width: flying.from.w,
              height: flying.from.h,
              borderColor: colors.chromeText,
              opacity: flyOpacity,
              transform: [{ translateX: flyX }, { translateY: flyY }, { scale: flyScale }],
            },
          ]}
        >
          {/* The photo as the preview showed it, seen through the page's box. */}
          <Image
            source={{ uri: flying.uri }}
            style={{
              position: 'absolute',
              left: flying.photo.x - flying.from.x,
              top: flying.photo.y - flying.from.y,
              width: flying.photo.w,
              height: flying.photo.h,
            }}
          />
        </Animated.View>
      )}

      {mode === 'review' && (
        <CaptureReview
          pages={pages}
          index={Math.min(index, Math.max(0, pages.length - 1))}
          onSelect={setIndex}
          onBack={backToCamera}
          onSave={handleSave}
          doneLabel={doneLabel}
          onCrop={i => { const p = pagesRef.current[i]; if (p) setCropKey(p.key); }}
          onRotate={handleRotate}
          onRetake={handleRetake}
          onDelete={handleDelete}
          onReorder={handleReorder}
          canAddMore={pages.length < maxPages}
          rendering={rendering}
        />
      )}

      <CropModal
        visible={!!cropTarget}
        target={cropTarget}
        onCancel={() => setCropKey(null)}
        onDone={async geometry => {
          if (cropKey) updateGeometry(cropKey, geometry);
          setCropKey(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topRow: {
    position: 'absolute',
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  pillRow: { position: 'absolute', alignItems: 'center' },
  controls: { position: 'absolute', flexDirection: 'row', alignItems: 'center' },
  side: { flex: 1, justifyContent: 'center' },
  shutterSpace: { width: SHUTTER_HALO, height: SHUTTER_HALO },
  sideLeft: { alignItems: 'flex-start', paddingLeft: Spacing.gutter },
  sideRight: { alignItems: 'flex-end', paddingRight: Spacing.gutter },
  done: {
    height: 44,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  doneText: { fontWeight: '700' },
  flying: { position: 'absolute', overflow: 'hidden', borderWidth: 2, borderRadius: Radius.sm },
  guide: { position: 'absolute' },
  guideCorner: {
    position: 'absolute',
    width: 28,
    height: 28,
    opacity: 0.9,
    shadowOpacity: 0.5,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 0 },
  },
  guideTL: { left: 0, top: 0, borderLeftWidth: 3, borderTopWidth: 3, borderTopLeftRadius: Radius.sm },
  guideTR: { right: 0, top: 0, borderRightWidth: 3, borderTopWidth: 3, borderTopRightRadius: Radius.sm },
  guideBR: { right: 0, bottom: 0, borderRightWidth: 3, borderBottomWidth: 3, borderBottomRightRadius: Radius.sm },
  guideBL: { left: 0, bottom: 0, borderLeftWidth: 3, borderBottomWidth: 3, borderBottomLeftRadius: Radius.sm },
  devChip: {
    position: 'absolute',
    maxWidth: '80%',
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.sm,
  },
});

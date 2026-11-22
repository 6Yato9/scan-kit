# Scan Kit — briefing for agents working on this repo

Read this first. It replaces the scratchpad briefing that earlier rounds used
(scratchpads get wiped; this file doesn't).

## The product
A professional, CamScanner-class document scanner for iOS and (being ported)
Android. Hard constraints from the owner:
- **Fully on-device and free.** No cloud, no account, no network-dependent
  feature of any kind, no Google Play Services features on Android.
- **Professional UI.** Vector icons only (no emoji or text glyphs as icons),
  aligned, polished, light and dark mode, Dynamic Type caps like neighbours.
- **Updates must never break existing users' documents.** Never rename or
  remove a stored value; only add optional fields / new keys. Corrupt or
  partial stored data falls back to defaults without crashing.

## Stack and rules
- Expo SDK 54, RN 0.81.5 (new architecture), expo-router 6, TypeScript.
- **pnpm** (hoisted node_modules): `pnpm exec …`, never npm.
- **React Compiler is on**: use refs, not state, for guards; never write refs
  during render; read external stores through hooks (useSyncExternalStore).
- **WebViews that load app files must use `components/local-webview.tsx`**
  (iOS grants `<container>/Library/` — WebKit ignores a grant of the container
  root on devices; Android reads the app folder).
- **App Lock**: navigate with `navigateWhenUnlocked` (lint rule
  `eslint-rules/lock-safe.js`).
- Native code lives in `modules/vision-ocr` (ios/ Swift, android/ Kotlin) and
  `modules/system-chrome` (Android only). JS feature-checks every optional
  native function. Same JS contract on both platforms.
- PDF writes go through `lib/pdf-edit.ts` (`rewriteStoredPdf`: crash-safe
  atomic swap, byte-identical Undo). Password-protected PDFs use
  `lib/pdf-session.ts` (session-only unlock; nothing decrypted is persisted).
- Cross-platform UI helpers: `components/action-sheet.tsx` (iOS keeps
  ActionSheetIOS), `components/text-prompt.tsx` (iOS keeps Alert.prompt),
  `components/use-android-back.ts`.
- `ios/` and `android/` are generated (gitignored): config goes through
  `app.json` / config plugins (`plugins/`), never hand edits there.
- Keep the code style: header comments that explain *why*; small pure helpers
  with unit tests.

## Gates (all must pass before you report)
`pnpm exec tsc --noEmit` (0 errors) · `pnpm exec eslint .` (0 errors) ·
`pnpm exec jest` (all green) · Android: Gradle build clean + Kotlin tests.

## Building and testing
- **iOS native build** (only when native code changed), serialised with a lock:
  `LOCK=<scratchpad>/native.lock; until mkdir "$LOCK"; do sleep 15; done;`
  `(cd ios && LANG=en_US.UTF-8 pod install)` if pods changed;
  `xcodebuild -workspace ios/scankit.xcworkspace -scheme scankit -configuration Debug -sdk iphonesimulator -destination 'id=<udid>' -derivedDataPath ios/build -quiet build; rm -rf "$LOCK"`.
  App: `ios/build/Build/Products/Debug-iphonesimulator/ScanKit.app`.
- **iOS simulator**: iPhone 17 Pro `9C6ED96F-7C30-4B99-A2FF-06982291401E`
  (spares ScanKit A–D exist; use only the one you're assigned). The owner wants
  idle simulators shut down — shut yours down when you finish.
  The simulator camera is fed still photos from `Caches/dev-camera` in dev builds.
- **Android**: SDK at `~/Library/Android/sdk`, AVD `Pixel_6_API_36`
  (`~/Library/Android/sdk/emulator/emulator -avd Pixel_6_API_36 -no-snapshot-save &`),
  `pnpm exec expo prebuild --platform android`, `pnpm exec expo run:android`,
  drive with adb (`screencap`, `input`, `logcat`). `adb emu kill` when done.
- **Metro**: port 8081 (`nohup pnpm exec expo start --port 8081 > <scratchpad>/expo.log 2>&1 &`).
- **The simulator/emulator is more permissive than a device** (file sandbox,
  memory, camera, performance). Think about device behaviour explicitly and
  say in your report what only a real phone can prove. The owner tests on an
  iPhone 13 mini (iOS 26.6) through a dev build that loads JS from Metro.
- Put screenshots/evidence in the scratchpad folder you're given.

## Git and releases
- **Never commit, push, or run `eas build`.** The lead commits.
- Data safety and "defaults reproduce today's behaviour" are review blockers.

## Report
Keep it short (the brief gives a word limit): what you changed (files),
decisions you made, what you verified and how, what you couldn't verify.

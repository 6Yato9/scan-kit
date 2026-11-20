# Scan Kit for Android: porting plan

Status: research only. Nothing in the repo was changed. Written 2026-11-20 against `main` @ 3569db8.
Scope: Expo SDK 54, RN 0.81.5 (new arch), expo-router 6, pnpm (hoisted). Target: Pixel_6_API_36 emulator now, Google Play internal testing later.
Owner decisions this plan follows: our own CameraX camera with auto-capture; ML Kit text recognition bundled in the APK; PdfBox-Android (tom-roush) for PDF editing, encryption, forms and flattening; everything free and on the device; no network-dependent features.

---

## 0. What I found, in brief

* **The project already compiles for Android.** A prebuilt `android/` folder (gitignored, CNG) and a 82 MB debug APK from today (`android/app/build/outputs/apk/debug/app-debug.apk`, 06:02) are on disk. Autolinked: AsyncStorage, `@react-native-ml-kit/text-recognition`, `react-native-document-scanner-plugin`, gesture handler, reanimated, safe area, screens, webview, worklets and the Expo modules. `modules/vision-ocr` is **not** in it: `expo-module.config.json` declares `"platforms": ["apple"]`.
* **The JS was written to run without the native module.** Every native call is guarded by a presence check (`typeof VisionOcr?.fn === 'function'`; 60+ call sites, §1.3), so the Android port can light up features one function at a time. There are three exceptions. They are the main Phase 0 work (§3):
  1. `lib/tool-scan.ts:17` imports `react-native-document-scanner-plugin`, whose JS calls `TurboModuleRegistry.getEnforcing('DocumentScanner')` at import time. On Android that scanner is Google's Play-Services document scanner, which needs a model download, so it must be dropped. Once it is unlinked, that import throws at module load and the app crashes.
  2. Five `Alert.prompt` password prompts. They are iOS-only, and three of them have no platform guard, so on Android they silently do nothing.
  3. Eight `ActionSheetIOS` sites whose Android fallback is `Alert.alert` with up to N buttons. Android shows at most 3, so the rest are dropped.
* **PDF viewing is the hardest piece to match.** Android's WebView can't display a PDF (the current fallback at `app/viewer.tsx:1818` shows a blank page). `PdfRenderer` before API 35 draws neither annotations nor form appearances, and it can't open a password-protected PDF. Recommendation: render everything with a bundled PDFium (`io.legere:pdfiumandroid` 2.0.3, Apache-2.0). It can render annotations (`renderAnnot`) and open with a password (`newDocument(fd, password)`), so the viewer, thumbnails, rasterising and Fill & sign previews all use one renderer on every API level. Session-unlocked PDFs are already decrypted to a working copy by `lib/pdf-session.ts`, so even plain `PdfRenderer` could show those. The real gap is annotations and forms.
* **Page detection.** Vision runs **two** detectors (`DocumentGeometry.swift:115-169`): a learned document-segmentation model (`VNDetectDocumentSegmentationRequest`) and `VNDetectRectangles`, and keeps the larger plausible outline. Android has no bundled on-device equivalent of the segmentation model. Recommendation: OpenCV (Canny/adaptive threshold, contours, `approxPolyDP`) behind a `QuadDetector` interface. Port the plausibility filter, inset, homography, `AutoCaptureTracker` and `PageSignature` from Swift 1:1 as pure Kotlin. Perspective warp does **not** need OpenCV: `android.graphics.Matrix.setPolyToPoly` with 4 points is a projective map.
* **Data detection has no offline Android equivalent.** That covers NSDataDetector (dates, addresses) and NLTagger (names). ML Kit Entity Extraction downloads its models at run time, so it is excluded. Phones go to libphonenumber, emails and URLs to `android.util.Patterns`, dates to a new JS date finder. Addresses and person names get heuristics or are dropped (an owner decision).
* **Configuration traps already in the generated manifest:**
  * `RECORD_AUDIO` (from expo-camera) and `READ_MEDIA_IMAGES/VIDEO/AUDIO` (from expo-media-library). The latter trips Google Play's photo/video permission policy.
  * `allowBackup="true"`, so documents would go to Google Drive backup. That conflicts with "no cloud".
  * AsyncStorage's **6 MB** Android database cap, which the `androidStorageSize: 50` key in `app.json` does not change: that key isn't an expo-build-properties option and is ignored. Document records, including `ocrText`, live in AsyncStorage (`lib/storage.ts:281`).

---

## 1. Native inventory: `modules/vision-ocr`

### 1.1 Module shape and conventions the Android side must copy exactly

| Item | iOS (where) | Android requirement |
|---|---|---|
| Module name | `Name("VisionOcr")`, `VisionOcrModule.swift:19` | Same name; `expo-module.config.json` gets `"platforms": ["apple","android"]` and `"android": {"modules": ["expo.modules.visionocr.VisionOcrModule", "expo.modules.visionocr.QuickActionsModule"]}` |
| Views | `View(PdfDocumentView)` **first**, `View(DocumentCameraView)` **second** (`:24`, `:33`, comment at `:31`) | **Same order, from the very first Android build.** `requireNativeView('VisionOcr')` with no view name resolves to the first view (`src/PdfDocumentView.tsx:39`). `hasNativePdfView()` only checks that *some* view config exists (`:28-33`). If an early Android build registers only the camera view, the viewer mounts the camera in place of the PDF. Ship a stub `PdfDocumentView` that fires `onLoadError {message:'unreadable'}` until Phase 3. |
| Camera view name | `DocumentCameraView` (`src/DocumentCameraView.tsx:113-121` checks `getViewConfig('VisionOcr','DocumentCameraView')`) | The Kotlin class must be named `DocumentCameraView` (Expo derives the view name from the class). |
| URIs in | `file://` URIs, sometimes with `?v=` (stripped by callers and by `DocumentGeometry.path` / `components(separatedBy:"?")`), sometimes **percent-encoded** (e.g. `app/tools/business-card.tsx:174` passes `${dir}${encodeURIComponent(name)}`) | Parse with `Uri.parse(u.substringBefore('?')).path` (it decodes). Never strip `"file://"` by hand. |
| URIs out | `URL(fileURLWithPath:).absoluteString` → `file:///…` | `Uri.fromFile(file).toString()` → `file:///data/user/0/…`. **Not** `File.toURI()`, which gives `file:/data/…` with a single slash and breaks JS path keys (`lib/files.ts`, `app/import.tsx` `fileKey`). |
| Errors | `promise.reject(code, message)` with exact messages that JS matches by regex: `^locked$`, `^restricted$`, `^wrong-password$`, `^changed$`, `could not open`, `no pages` (`lib/pdf-edit.ts:202-209`, `lib/pdf-unrestrict.ts:143-147`, `lib/pdf-session.ts:270-272`, `lib/pdf-text.ts:86`) | Always `promise.reject(CodedException(code, message))` or `throw CodedException`. An uncaught Kotlin exception reaches JS as `"Call to function 'VisionOcr.x' has been rejected.\n→ Caused by: …"`, which fails every `^locked$`-style match. Wrap each function body in one `try/catch` that maps exceptions. |
| Threading | Everything on `DispatchQueue.global(.userInitiated)`; UI on main | `AsyncFunction … Coroutine` on `Dispatchers.IO` / `Default`; presenting and intents on main. One coroutine scope per module, cancelled in `OnDestroy`. |
| Optionality | Every function is optional in the TS type except `recognize` | **`lib/ocr.ts:31` uses `VisionOcr.recognize` whenever the module exists.** So the first Android module build must include `recognize`, or `ocr.ts` must check `typeof VisionOcr.recognize`. |

### 1.2 Functions: contract → Android implementation

Effort: S ≤ 2 days, M ≤ 1 week, L > 1 week (one developer, including on-device verification). Risk: Low / Med / High (behavioural parity).

#### Imaging and geometry

| Function | JS contract (args → result; errors) | Callers | Android implementation | Effort / risk |
|---|---|---|---|---|
| `recognize(uri)` | → `{ text, lines:[{text,left,top,width,height}] }`, line frames in **upright-image pixels**. Reading order: rows of boxes that overlap vertically ≥ 50% of the smaller height, top to bottom, cells left to right; row text joined with two spaces, rows with `\n` (`VisionOcrModule.swift:576-643`). Reject `ERR_VISION_OCR`. | `lib/ocr.ts:31` (every OCR: search index, searchable PDF, Extract text, Business card, text actions) | ML Kit `com.google.mlkit:text-recognition:16.0.1` (**bundled** model: the `com.google.mlkit:*` artifacts bundle, `play-services-mlkit-*` download). `InputImage.fromFilePath` applies EXIF; for > 12 MP decode subsampled to ~3000 px and scale the boxes back. Port the row grouping verbatim on ML Kit `Text.Line` boxes. Then **remove** `@react-native-ml-kit/text-recognition`: it pulls Chinese, Japanese, Korean and Devanagari models too (≈ 3.3 MB of `.fb` models in assets, one 11 MB `libmlkit_google_ocr_pipeline.so` per ABI in today's APK). | S / Med: accuracy is lower than Vision; ML Kit has **no Arabic or Cyrillic**; see §5 |
| `detectQuad(uri)` | → `number[8] \| null`: TL,TR,BR,BL normalised 0..1, top-left origin, upright, corners **inset 0.5 %** in page perspective (`DocumentGeometry.swift:225-241`); `null` below 15 % area or not plausible. Reject `ERR_IMAGE_READ`, `ERR_DETECT_QUAD`. | `lib/page-source.ts:126` → `components/crop-modal.tsx:247` (Detect), `components/use-import.ts:45`, `lib/add-pages.ts:69` | Decode upright at ≤ 2048 px (`BitmapFactory` `inSampleSize` + `ExifInterface` rotation). Then `QuadDetector.detect(bitmap, minArea = 0.15)` → port `plausible()` (area 0.15–0.985, convex clockwise, ≤ 2 corners on the border unless ≥ 0.8), `inset()` and `Homography` from Swift. | M (with the detector) / **High** (see detector comparison below) |
| `warpQuad(src, quad, out, quality, maxEdge)` | → `{uri,width,height}`. Validation is exact (`parseQuad`, `:207-223`): 8 finite values within −0.01..1.01, convex clockwise, area ≥ 0.0005, else `ERR_BAD_QUAD`; `ERR_BAD_ARGS` when `maxEdge < 1`; `ERR_IMAGE_READ`, `ERR_IMAGE_WRITE`, `ERR_WARP`. An axis-aligned upright quad is a **plain crop** (pixel-exact). A cyclic shift of the corners turns the output by 90° each step. Output size = max opposite edge lengths, capped at `maxEdge`. Decode only ~1.25× the needed pixels. | `lib/page-source.ts:191` (every saved camera/import page, crop and re-crop, retake) | Pure Android, no OpenCV: decode upright at `scale = min(1, 1.25·maxEdge / outLong)`; output `W×H`; `Matrix.setPolyToPoly(dst 4 pts → src 4 pts)` inverted, `Canvas.drawBitmap(src, matrix, Paint(FILTER_BITMAP_FLAG))`; then one high-quality downscale (`Bitmap.createScaledBitmap` in two halving steps, approximating Lanczos) to `maxEdge`; JPEG via `Bitmap.compress` + write to temp + `Os.rename`. Axis-aligned branch = `Bitmap.createBitmap(src, rect)`. | M / Low. Unit-test with the same corner-order fixtures as `__tests__/page-source.test.ts`. |
| `normalizeImage(src, out, maxEdge, quality)` | → `{uri,width,height}`, upright (EXIF baked in), never upscaled. **Byte-for-byte copy** when the source is a single-frame JPEG, orientation 1, ≤ `maxEdge`, ≤ 0.6 bytes/pixel (`reusableJPEGSize`, `:290-302`). Errors `ERR_BAD_ARGS`, `ERR_IMAGE_READ`, `ERR_NORMALIZE`. | `lib/page-source.ts:164` | `ExifInterface` for orientation and size; the same reuse rule; else subsampled decode + `Matrix.postRotate`/mirror + `compress`. HEIC/AVIF via `ImageDecoder` (API 28+), `BitmapFactory` below. Watch out for OOM on 48–200 MP photos: never decode at full size; `inSampleSize` to ≤ 2·maxEdge first. | S / Low |
| `detectDocument(uri, quality)` | → `{uri, detected}`: auto-crop on import, `minArea 0.30`, warp to `maxEdge 4096`, into `tmp/doc-<uuid>.jpg`; `{uri: input, detected:false}` when nothing found. Reject `ERR_DOC_DETECT`. | `lib/document-detect.ts:11`, `components/use-import.ts:66` | Composition of the two above. | S / tied to the detector |

**Rectangle / page detector: options compared**

| Option | What it is | APK cost | Quality vs iOS | Effort |
|---|---|---|---|---|
| **OpenCV** `org.opencv:opencv:4.12.0` (Maven Central, Apache-2.0; 5.1.0 also published) | Grey → blur → Canny + morphological close (plus an adaptive-threshold pass for low contrast) → `findContours` → `approxPolyDP` → largest convex quad; optional `cornerSubPix` refinement | The AAR is **117 MB** (all ABIs plus static libs). The per-ABI `libopencv_java4.so` is roughly 15–25 MB uncompressed (measure). Play's ABI splits mean users download one ABI. A slim build (core + imgproc only, as in `nihui/opencv-mobile`) is roughly 2–4 MB per ABI. | Good on contrasting backgrounds; worse than Vision's segmentation for a white page on a white or patterned desk, glare, or a shadow across an edge | M |
| Hand-written Kotlin | Downscale to 320–512 px, Sobel, non-max suppression, Hough lines, best 4-line quadrilateral | 0 | Achievable but needs tuning; this is where most of the risk sits | L |
| Learned segmentation (tflite: a document-segmentation model, e.g. a DocAligner-style heatmap model) | Nearest to `VNDetectDocumentSegmentationRequest` | ~1–5 MB model + LiteRT runtime (~1–2 MB) | Best on hard backgrounds | L, plus model **licence check** |
| ML Kit Document Scanner (`play-services-mlkit-document-scanner`) | Google's full scanner UI | n/a | n/a | **Excluded**: Play Services module download, own UI (that is what `react-native-document-scanner-plugin` uses on Android, `android/build.gradle:77`) |

Recommendation: OpenCV for v1, behind `interface QuadDetector { fun detect(luma: GrayImage, minArea: Float): List<Quad> }`, so a learned model can be added later as a second candidate. That mirrors iOS, which runs two detectors and keeps the larger plausible one. Start with the Maven AAR (fastest to prove); move to a slim core+imgproc build before Play if the size measurement says so. Restrict ABIs to `arm64-v8a`, `x86_64` (emulator) and optionally `armeabi-v7a`. The generated `gradle.properties` builds all four, including `x86`.

#### Camera view `DocumentCameraView` (DocumentCameraView.swift 1055 lines + AutoCaptureTracker.swift 322)

Contract (`src/DocumentCameraView.tsx`):
* **Props:** `autoCapture` (default true), `flash` `'off'|'on'|'auto'`, `torch`, `active` (false pauses; also stops in the background), `simulatorImageUri` (run the whole pipeline on a still; changing it keeps the detection state), `simulatorJitter` 0..1. Props are applied once per batch (`OnViewDidUpdateProps`).
* **Events:**
  * `onDetection {quad|null, stability 0..1, aspect}` at ~8 Hz (analysis at 15 fps, emit every 120 ms or when quad presence changes, `:106-107`, `:735-742`).
  * `onCaptureStart {}`.
  * `onCapture {sourceUri, width, height, quad|null}`: an upright JPEG q 0.92, long edge ≤ 4096, written to **`Caches/scanner-src/src-<ms>-<n>.jpg`**. The directory name is load-bearing: `lib/tool-scan.ts:31`, swept by `lib/files.ts:950`. The quad is detected on the still, falling back to the last steady live quad.
  * `onCameraError {code:'permission'|'unavailable'|'failed', message, capture?}`.
  * `onCameraState {state:'running'|'paused', reason?:'in-use'|'multitasking'|'pressure'|'other'}`.
* **Methods:** `capture()` resolves after `onCapture`; rejects `not-running`, `busy`, `failed`; 10 s timeout. `rearm()` forgets the last shot.

| Piece | Android |
|---|---|
| Session | **CameraX**. Align with expo-camera's `camerax_version = "1.5.0-rc01"` (`node_modules/expo-camera/android/build.gradle:18`), or force one version for both in Gradle. `Preview` in a `PreviewView` (`ScaleType.FILL_CENTER` = aspect fill, as iOS), `ImageAnalysis` (YUV_420_888, `STRATEGY_KEEP_ONLY_LATEST`, 4:3 `ResolutionSelector`, ~1280×960–1920×1440), `ImageCapture` (4:3, `CAPTURE_MODE_MAXIMIZE_QUALITY`, `flashMode`). Torch via `cameraControl.enableTorch`. |
| Lifecycle | `ExpoView` isn't a `LifecycleOwner`: give the view its own `LifecycleRegistry` driven by `active`, attach/detach and the activity's resume/pause (expo-camera does the same). |
| Upright / aspect | Analyse in sensor orientation using `imageInfo.rotationDegrees`, and rotate the **quad**, not the pixels, into upright portrait (cheap). `aspect = width/height` of the upright frame (0.75 in portrait). Portrait only (`app.json` `orientation: portrait`; the manifest has `screenOrientation="portrait"`). |
| Detection per frame | Y plane → `QuadDetector` (live `minArea 0.10`) → overlay smoothing (`α 0.45`, snap above 0.08, drop after 3 misses, `:707-719`) → `AutoCaptureTracker.update` (port 1:1; pure). Overlay drawn natively (a `View.onDraw` path in accent `#2BB5D1`, 20 % fill, 2 px stroke, 0.2 s fade) with the **same aspect-fill mapping** as `layerPoints` (`:799`) and `lib/camera-layout.ts`. |
| Steadiness | Sharpness: Laplacian variance on the Y plane inside the quad's bounding box, port of `:597-627`; unsteady below 0.6 × the decaying peak. Motion: `SensorManager` `TYPE_GYROSCOPE` (rad/s, threshold 0.35, same as iOS) and `TYPE_LINEAR_ACCELERATION` in **m/s²**. iOS `userAcceleration` is in g, so the threshold becomes 0.08 g ≈ **0.78 m/s²**. Focus hunting: CameraX doesn't expose it, so read `CaptureResult.CONTROL_AF_STATE` through `Camera2Interop.Extender(preview).setSessionCaptureCallback`; `PASSIVE_SCAN`/`ACTIVE_SCAN` = adjusting; the 0.8 s cap is kept. |
| `PageSignature` | Port 1:1 (24×32 grid, 6×6 samples, high-pass r 3, thresholds 0.85 / 0.5). Sample the Y plane through the **smoothed** quad. JVM unit tests share fixtures with Swift. |
| Close-up zoom | `LENS_INFO_MINIMUM_FOCUS_DISTANCE` is in **diopters** (1/m) through `Camera2CameraInfo`; convert to mm and apply the same A4-fill formula (`:449-460`) with `setZoomRatio` ≤ 1.6. |
| Interruptions | `cameraInfo.cameraState` LiveData: `ERROR_CAMERA_IN_USE` / `ERROR_MAX_CAMERAS_IN_USE` → `paused/in-use`; `ERROR_CAMERA_DISABLED`, `ERROR_DO_NOT_DISTURB_MODE_ENABLED` → `other`; `ERROR_CAMERA_FATAL_ERROR` → `onCameraError failed`; back to `OPEN` → `running`. `multitasking`: multi-window when not top-resumed (`onTopResumedActivityChanged`, API 29+). `pressure`: `PowerManager.addThermalStatusListener` ≥ `THERMAL_STATUS_SEVERE` (API 29+). |
| Permission | The JS side has none of its own on iOS (the view asks). On Android the view can't request permission without an Activity result: `appContext.permissions.askForPermissions(CAMERA)`, or let `app/onboarding.tsx:41` (expo-camera `useCameraPermissions`) and the camera screen do it; denied → `onCameraError permission`. Permanently denied → JS already opens Settings (`app/camera.tsx` uses `Linking`). |
| Still capture | `takePicture(OnImageCapturedCallback)` → JPEG bytes → EXIF rotation → subsampled decode to ≤ 4096 long edge → write q 0.92 (no EXIF orientation) → detect on a ≤ 2048 copy. 10 s timeout → `onCameraError {code:'failed', capture:true}`. |
| Still mode | `simulatorImageUri`: the same pipeline on a bitmap at 15 fps; jitter from the same PRNG (`:1040-1055`). **This is the main emulator test path.** |
| Effort / risk | **L / High.** CameraX vendor quirks, AF reporting and auto-capture "feel" can only be proven on real phones (§4). |

#### PDF engine (PDFKit → PdfBox-Android + PDFium)

Libraries:
* **PdfBox-Android** `com.tom-roush:pdfbox-android:2.0.27.0`: Apache-2.0, based on PDFBox 2.0.27, depends on BouncyCastle 1.72 (only needed for public-key security; R8 strips the rest). Call `PDFBoxResourceLoader.init(context)` once. Open large files with `MemoryUsageSetting.setupTempFileOnly()` so a 300-page scan doesn't OOM.
* **PDFium** `io.legere:pdfiumandroid:2.0.3`: Apache-2.0, maintained (pushed 2026-11-10; 3.x is alpha). Has `newDocument(pfd, password)` and `renderPageBitmap(…, renderAnnot)`. Used for **all rasterising**.
* **Permission bits.** JS persists and passes **PDFKit's `PDFAccessPermissions` bit layout**: bit0 printLow, 1 printHigh, 2 changeContent, 3 assemble, 4 copy, 5 accessibility, 6 comment, 7 fillForms (`PdfUnrestrict.swift:47-60`, `PdfProtector.swift:125-140`). Android must translate PDFBox's `AccessPermission` (the raw `/P` bits 3, 4, 5, 6, 9, 10, 11, 12) into that layout with the **same derivation** as `PdfPasswordCheck.permissionBits`. Unit-test the mapping in both directions.
* **Re-encryption.** Every writer that keeps protection writes an explicit `StandardProtectionPolicy(owner = random 64 chars, user = ""|known, perms)`, AES-256 (`keyLength 256`). Don't rely on PDFBox re-encrypting a loaded document implicitly. It then reads the result back and refuses it if any permission widened. Port `widenedPermissions` and the read-back checks; they are the safety net iOS relies on.

| Function | JS contract | Callers | Android (PdfBox unless noted) | Effort / risk |
|---|---|---|---|---|
| `pdfInfo(uri, password?)` | → `{pageCount, locked, encrypted, restricted, canAnnotate, canFillForms, formFields, annotations, signed, certified, xfa}`. The last eight are omitted while locked. `restricted` = encrypted, opened **without** a password, and assembly not allowed. `annotations` counts everything shown except Link/Popup. Reject `ERR_PDF_INFO` with "Could not open the PDF". | `lib/pdf-protect.ts:165,279`, `lib/pdf-fill.ts:381`, `lib/pdf-edit.ts:451,704,822`, `lib/pdf-session.ts:589`, `components/create-pdf/sources.ts:93` | `PDDocument.load(file, "")` → `InvalidPasswordException` = locked; retry with the password. `isEncrypted`; `currentAccessPermission`; widgets via `PDAcroForm.fieldTree`/page annots; `signed` = `/FT /Sig` with `/V`; `certified` = catalog `/Perms /DocMDP`; `xfa` = `acroForm.hasXFA()`. | S / Low |
| `pdfPermissions(uri, password?)` | → `{pageCount, encrypted, locked, passwordAccepted, permissions{8 bools}, ownerUnlocked?, userPassword?: bool\|null, permissionBits?}`. Unencrypted → all true. Reject `ERR_PDF_INFO`. | `lib/pdf-unrestrict.ts:164,274`, `lib/pdf-session.ts:394` | `ownerUnlocked = currentAccessPermission.isOwnerPermission`. `userPassword`: `StandardSecurityHandler` user-password check against `/U`,`/O`,`/P`,`/ID` (PDFBox exposes the algorithm; or port `PdfPasswordCheck`, `PdfProtector.swift:110-260`, which is plain crypto). `permissionBits` from raw `/P` (exact, not rounded up). | M / Med (owner vs user semantics are what `lib/pdf-session.ts` builds on) |
| `pdfPageTexts(uri, password?)` | → `string[]` per page, plus filled form values and Scan Kit fill-mark text (`/SKFill` key) appended (`PdfTools.swift:8-37`). Reject message `locked`. | `lib/pdf-text.ts:75` (search), `lib/pdf-edit.ts:289`, `lib/pdf-unrestrict.ts:189`, `lib/pdf-flatten.ts:110`, `lib/create-pdf-build.ts:338`, `app/settings/recovered-files.tsx:59` | `PDFTextStripper` with `setStartPage/EndPage` per page, `sortByPosition = true`. | S / Med: text extraction differs from PDFKit (spacing, ligatures); slower |
| `unlockPdf(in, out, password)` | → out URI; a faithful **unencrypted** copy (forms, annotations, bookmarks kept), verified: opens without a password, same page count. Reject message `wrong-password`. | `lib/pdf-session.ts:462,582`, `components/create-pdf/sources.ts:146` | `load(file, pw)` → `setAllSecurityToBeRemoved(true)` → `save(tmp)` → re-open and check → `Os.rename`. This is exactly the structural rewrite iOS works hard for (`PdfUnrestrict.swift` Rewriter): PdfBox gives it for free. | S / Low |
| `unrestrictPdf(in, out, password?)` | → `{pageCount, encrypted, method:'rewrite'\|'pdfkit'\|'permissions'}`. Reject `ERR_PDF_LOCKED`/`locked`, `ERR_PDF_PASSWORD`/`wrong-password`, `ERR_PDF_UNRESTRICT`. | `lib/pdf-unrestrict.ts:221,273` | As `unlockPdf`; always `method:'rewrite', encrypted:false`. Port the verification (same per-page text, annotations per page, field and bookmark counts). The page "look" comparison can reuse the PDFium render at 64 px. | S–M / Low |
| `protectPdf(in, out, password)` | → out URI; user = owner = password; verified locked and opening with it. Reject `ERR_PDF_PROTECT`. | `lib/pdf.ts:929`, `lib/pdf-edit.ts:449` | `StandardProtectionPolicy(pw, pw, AccessPermission())`, AES-256. Interop: a PDF protected on Android must open in iOS PDFKit, Acrobat and Chrome (AES-256 R6 is fine on all). | S / Low |
| `protectPdfKeeping(in, out, user, owner\|null, permBits)` | → out URI; keeps the open password, a separate random owner (or the given one), the author's bits minus `changeContent`; verified: locked, opens, same pages; with a random owner, opened as a **user** with nothing widened. Reject `ERR_PDF_PROTECT`. | `lib/pdf-edit.ts:450,506` | As above with `AccessPermission` built from the bits (inverse mapping). | S / Med (the bit mapping) |
| `pdfEditPages(in, out, sources[], rotations[], password?)` | → page count. `sources[i] ≥ 0` = input page (each at most once); `-(k+1)` = a blank page shaped like page k (media + crop box + rotation); `rotations` are multiples of 90 added to the page's own. Text stays selectable; bookmarks relinked; a deleted page's bookmark removed (or target cleared if it has children). Owner-only-encrypted docs are edited **in place**, keeping forms, labels, named destinations and protection; refused if assembly isn't allowed. Read back: page count, order, rotations; refuse if permissions widened. Reject `ERR_PDF_LOCKED`/`locked`, `ERR_PDF_RESTRICTED`/`restricted`, `ERR_PDF_EDIT` (`Bad page plan`, `Could not open the PDF` …). | `lib/pdf-edit.ts:399,703` (rotate, delete, reorder, insert blank, split, extract), `components/pdf-page-tools.tsx`, `components/scan-doc-tools.tsx` | PdfBox in place: `PDPageTree` remove / `insertBefore` / `add`, `page.rotation`. Blank = new `PDPage(mediaBox)` + `cropBox` + rotation. Bookmarks point at page **objects**, so moves keep them; walk the outline and drop items whose page left the tree. Then `settleNeedAppearances` = `acroForm.needAppearances = false` when every widget has `/AP /N`. | M / Med |
| `mergePdfs(in[], out)` | → out URI; pages keep size and text; a part that is encrypted and opened without a password but forbids assembly → `ERR_PDF_RESTRICTED` (message `restricted`); output encrypted with the **intersection** of the protected parts' permissions; verified. | `lib/pdf.ts:766`, `lib/pdf-edit.ts:819`, `lib/create-pdf-build.ts` | `PDFMergerUtility` with `MemoryUsageSetting.setupTempFileOnly()` (keeps AcroForms; name clashes are renamed), or `importPage` per page. Then protect with the intersection. | S–M / Med (merged forms with clashing field names) |
| `renderPdfPages(in, outDir, maxEdge)` | → `file://…/pdfpage-%03d.jpg` in page order; ~200 dpi capped at `maxEdge`; white background; `/Rotate` respected; crop box. Reject (`ERR_PDF_RENDER`) "This PDF is password protected" / "The PDF has no pages". **The file name pattern is load-bearing** (`lib/pdf-thumb.ts:197,220`). | `lib/pdf-thumb.ts:94,185`, `lib/convert-pdf.ts:118`, `components/create-pdf/sources.ts:111` | PDFium: `renderPageBitmap(…, renderAnnot = true)` into an ARGB bitmap pre-filled white → JPEG q 0.9. One page at a time, bitmap reused. | S / Low |
| `pdfFillInfo(uri)` | → `{pageCount, encrypted, canAnnotate, canFillForms, pages:[{crop,media,rotation}], fields:[…], signed, certified, xfa}`. Field `id = "page:annotationIndex"` (round-tripped to `pdfFill`); `name` fully qualified; `kind` text\|choice\|checkbox\|radio\|signature; `rect [x,y,w,h]` in PDF space before rotation; `readOnly`, `fontSize` (0 = auto), `label` (/TU), `value`, `multiline`, `maxLength`, `comb`, `align`, `options`, `list`, `on`, `onValue`. Reject `ERR_PDF_LOCKED`/`locked`, `ERR_PDF_FILL`. | `lib/pdf-fill.ts:500` → `app/pdf-fill.tsx`, `components/fill-page.tsx`, `lib/fill-session.ts` | `PDAcroForm` field tree → widgets → index in `page.annotations`. **The ids are platform-local**: PDFKit's annotation order can differ from `/Annots`, so they must never be shared across platforms; they aren't today. | M / Med |
| `pdfRenderPage(uri, index, out, maxEdge, hideFields)` | → `{uri,width,height}`; upright, crop box, white, q 0.88. `hideFields` hides **only widgets**; other annotations (earlier notes, signatures) still drawn. Reject `ERR_PDF_LOCKED`, `ERR_PDF_RENDER`. | `lib/pdf-fill.ts:533` | PDFium with `renderAnnot = true`. For `hideFields`, render from a scratch copy whose page `/Annots` has the widgets removed (PdfBox, in Caches), or set the hidden flag (`/F` bit 2) on the copy's widgets. | S–M / Low |
| `pdfFill(in, out, fields[], marks[])` | → page count. Fields `{id,name,kind,value?,on?}` (text and choice values go to **every widget of the name**). Marks `{page, rect, kind:'text'\|'check'\|'cross'\|'image', text?, fontSize?, color?, image?(base64 PNG)}` become **Stamp annotations with a non-empty `/AP /N`**, tagged `/SKFill <runId-n>`, drawn turned against `/Rotate`. Verified by re-parsing: every mark present with its appearance, else retry with **burn-in**. Owner-only-encrypted files keep their protection; needs `comment` for marks and `fillForms` for fields, else `restricted`. `ERR_PDF_CHANGED` (`changed`) when the form isn't what `pdfFillInfo` said. | `lib/pdf-fill.ts:599` → `app/pdf-fill.tsx` (Fill & sign) | Fields: `PDTextField.setValue` / `PDChoice.setValue` / `PDCheckBox.check()` / `PDRadioButton.setValue(onValue)`. PdfBox regenerates appearances (`AppearanceGeneratorHelper`), then `needAppearances = false`. **Fonts:** the form's `/DA` font is usually Helvetica/WinAnsi, which throws on any character outside Latin-1. Add a bundled Unicode TTF (Noto Sans, OFL) to `/DR` as `PDType0Font` (subset) and switch that field's `/DA` when needed. Marks: `PDAnnotationRubberStamp` + `PDAppearanceStream` written with `PDPageContentStream` (Type0 font subset for text; check/cross paths; image via `LosslessFactory.createFromImage`, which keeps alpha as an SMask), BBox/Matrix turned for `/Rotate`. | **L / High**: non-Latin text in fields and marks. PdfBox does **no Arabic shaping or bidi**; iOS gets that from CoreText. See §5. |
| `pdfFlatten(in, out)` | → page count; form values, signatures, added text, stamps and notes drawn into the page **as vector content**; links kept; same permissions; verified. Reject `locked`/`restricted`/`ERR_PDF_FLATTEN`. | `lib/pdf-flatten.ts:194`, `lib/pdf-fill.ts:421`, `app/tools/flatten.tsx`, `components/export-sheet.tsx` | `acroForm.flatten()` for widgets (after making sure appearances exist), then for each non-Link, non-Popup shown annotation: append its `/AP /N` as a form XObject to the page content (`PDPageContentStream(…, APPEND, true, true)`, transform from Rect/BBox/Matrix per spec §12.5.5), then remove the annotation. Port the "content differs" verification on the PDFium render. | M–L / Med |
| `pdfFillForceFallback(on)` | sync → bool; debug builds only. | tests | `BuildConfig.DEBUG`. | S |
| `replaceFile(src, dest)` | → dest URI; **atomic** rename (dest never missing or partial). Across volumes: copy to `.<name>.<uuid>.part` next to dest, then rename. Reject `ERR_REPLACE_FILE`. | `lib/pdf-edit.ts:304,490`, `lib/pdf-fill.ts:477` | `android.system.Os.rename(src, dest)` (rename(2); API 21+). **Not** `java.nio.file.Files.move(ATOMIC_MOVE)`: that needs API 26 and minSdk is 24 (`node_modules/react-native/gradle/libs.versions.toml`). Catch `ErrnoException` with `EXDEV` → `.part` copy + `fsync` + rename. All app storage is one volume (`/data/user/0/<pkg>/`), as on iOS. | S / Low |

#### Viewer view `PdfDocumentView`

Contract (`src/PdfDocumentView.tsx`): props `source` (file URI), `backgroundHex`, `initialPage` (applied once per load); events `onPageChange {page, count}` (zero-based) and `onLoadError {message}`, where `'locked'` = needs a password and anything else = unreadable. Behaviour (`PdfDocumentView.swift`): continuous vertical scroll, pinch zoom, fit-to-width, a user's zoom kept across relayouts unless fitted, page shadows, 16 pt page margins.

**Android:**
* A `FrameLayout` holding a `RecyclerView` (vertical, one item per page, aspect from the page size).
* A zoom container: a hand-written `ScaleGestureDetector` + matrix, or `com.otaliastudios:zoomlayout` (Apache-2.0).
* PDFium renders off the main thread into an LRU bitmap cache sized to ~1/8 of the heap. On zoom, re-render the visible pages at the new scale after the gesture ends (tiles at ≥ 3×). Elevation for shadows.
* `onPageChange` fires for the page under the vertical centre.
* `PdfPasswordException` → `locked`.

How a session-unlocked PDF is viewed: JS already passes `readablePdf.uri` = the **decrypted session copy** (`lib/pdf-session.ts` header, `app/viewer.tsx:1787`), so the view never needs the password. PDFium can open with a password anyway if that ever changes. Why not `PdfRenderer`: it can't open password-protected files before API 35, and the pre-35 `PdfRendererPreV` has no way to draw form widgets or annotations. A filled form or a Fill & sign result would look **empty**. Effort **L**, risk Med (smoothness and memory on low-end phones).

#### Files, sharing, system integration

| Function | Contract | Callers | Android | Effort / risk |
|---|---|---|---|---|
| `shareFiles(uris[], title?)` | One share sheet with several files; resolves when it's dismissed. **Only `lib/share.ts` may call it** (App Lock wrapper, `lib/share.ts:154`). | `lib/share.ts` → multi-page share as images | `Intent.ACTION_SEND_MULTIPLE`, `EXTRA_STREAM` = `ArrayList<Uri>` from a **FileProvider** declared in the module's own manifest (paths: `cache/`, `files/`), `ClipData` with every URI, `FLAG_GRANT_READ_URI_PERMISSION`, `Intent.createChooser(…, title)` via `startActivityForResult`; resolve in `OnActivityResult` (Android reports `RESULT_CANCELED` whatever the user chose; JS already treats every outcome alike). | S / Low |
| `copyIncomingFile(src, dest)` | Copies a system-provided file into the app; resolves dest URI; sets a fresh mtime. Reject `ERR_COPY_INCOMING`. | `app/import.tsx:55` | Accept `content://` **and** `file://`: `contentResolver.openInputStream(uri)` → temp → rename. Add **`incomingFileInfo(uri)` → `{name, mimeType, size}`** (`OpenableColumns.DISPLAY_NAME`/`SIZE`, `getType`). A content URI has no extension, so `importKindOf` (`lib/incoming-file.ts:10`) can't classify it without this. | S / Low |
| *(new)* incoming intents | iOS needs no native code: "Open in" arrives as a `file://` URL through expo-router `+native-intent` (`app/+native-intent.tsx:7` → `lib/incoming-file.ts:39`). | | Android: `ACTION_VIEW` with `content://` **does** reach `Linking` / `redirectSystemPath`, but `routeForIncomingUrl` only accepts `file://` (`lib/incoming-file.ts:27-44`), so it would route to `/`. `ACTION_SEND` / `SEND_MULTIPLE` (the share sheet) never reach Linking (`EXTRA_STREAM`). Add to the module: `OnCreate`/`OnNewIntent` read `intent.action`, data, `EXTRA_STREAM`; keep pending URIs; `takePendingIncomingFiles()` plus an `onIncomingFiles` event (the same pattern as QuickActions). In JS, accept `content://` in `routeForIncomingUrl` and support several files in `/import`. The read grant lasts only while the activity lives, so copy at once. | M / Med |
| Quick actions (`ScanKitQuickActions`) | `takePendingQuickAction()` → type string; event `onQuickAction {type}`; `isOverlayPresented()` → bool; types `com.6yato9.scan-kit.{scan,import-photos,import-file,search}` (`lib/quick-actions.ts:48-53`). Static items only, by design (App Lock privacy). | `components/quick-actions-handler.tsx` | **Static app shortcuts**: `res/xml/shortcuts.xml` (4 shortcuts, vector icons; each intent `android:action="com.sixyato9.scankit.QUICK_ACTION"`, `targetClass=MainActivity`, extra `type` = the same iOS type strings so the JS map is unchanged) plus `<meta-data android:name="android.app.shortcuts">` on MainActivity, both from a config plugin. Module reads the extra in `OnCreate` (cold) and `OnNewIntent` (warm; `launchMode=singleTask`). No echo problem. `isOverlayPresented`: Android has no view-controller stack; RN `<Modal>` and `Alert` are separate Dialog windows. Implement it in **JS** (a counter that `BottomSheet`, `CropModal`, `ReorderModal`, `DocPagePicker` and `alert-guard` increment) and have the native function return false. | S–M / Low |
| `writeVCard(fields, out)` | → out URI; vCard 3.0, photo folded at 75 octets. Reject `ERR_VCARD`. | `app/tools/business-card.tsx:168` | Hand-written serializer (≈ 80 lines). Pure Kotlin, so it can be unit-tested against the iOS output. | S / Low |
| `presentNewContact(fields)` | → `'saved'\|'cancelled'\|'denied'\|'unavailable'`. Only through `lib/text-actions.ts` (App Lock). | `lib/text-actions.ts:343`, Business card | `Intent(ContactsContract.Intents.Insert.ACTION)`, type `RawContacts.CONTENT_TYPE`; `NAME`, `COMPANY`, `JOB_TITLE`, `NOTES`; **more than 3 phones or emails, the URL, the address parts and the photo** go in `Insert.DATA` (`ArrayList<ContentValues>`: `Phone`, `Email`, `Website`, `StructuredPostal`, `Photo` ≤ 720 px JPEG, under the ~1 MB Binder limit); `finishActivityOnSaveCompleted = true`. `RESULT_OK` → saved, else cancelled; no handler → unavailable. Needs no permission. Manifest `<queries>` for the action (package visibility). | S / Low (OEM contacts apps differ in what they honour) |
| `presentEventEditor(title, startMs, endMs, allDay, notes?, location?)` | → same outcomes. | `lib/text-actions.ts:327` | `Intent(ACTION_INSERT, CalendarContract.Events.CONTENT_URI)` with `EXTRA_EVENT_BEGIN_TIME`/`END`/`ALL_DAY`, `TITLE`, `DESCRIPTION`, `EVENT_LOCATION`; no permission. **Calendar apps don't report saved vs cancelled** (Google Calendar returns `RESULT_CANCELED` either way). Add an outcome **`'unknown'`** and teach JS not to claim "Added". `<queries>` for the intent. No calendar app (stock emulator images may have none) → `unavailable`. | S / Low |
| `speak(text, lang?, rate?)` / `pauseSpeaking` / `resumeSpeaking` / `stopSpeaking`; events `onSpeechState {id, state}`, `onSpeechProgress {id, start, length}` (UTF-16) | One utterance at a time, ids on every event; stops when the app goes to the background; best voice per language, region first, never novelty voices; rate 0.1–1 of max. | `lib/read-aloud.ts` → Read aloud in text panels | `android.speech.tts.TextToSpeech`. `UtteranceProgressListener.onRangeStart` (API 26+) → progress, indices are UTF-16 (Java String), so ranges match JS. **TTS has no pause**: pause = `stop()` and remember the last word start; resume = speak the rest with an offset added to later ranges; state events emulated. Voice choice: `voices` filtered to `!isNetworkConnectionRequired` and without `KEY_FEATURE_NOT_INSTALLED` (offline only), same scoring by locale. Rate: Android's 1.0 = normal; map `rate` so 0.5 ≈ normal like iOS's default. Audio focus `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`, `USAGE_ASSISTANCE_ACCESSIBILITY` / `CONTENT_TYPE_SPEECH`. Stop in `OnActivityEntersBackground`. | M / Med: some devices have no offline voice for a language; the engine's own voice download is a system feature, not the app's |
| `detectData(text)` | → `[{type:'phone'\|'email'\|'url'\|'address'\|'date', text, range:[start,len] UTF-16, value, address?, date?, duration?, hasTime?, timeZone?}]`. JS post-filters strictly (`lib/text-actions.ts:59` `checkDetections`). | `lib/text-actions.ts:44` → `components/text-actions.tsx` chips, Business card | No offline Android equivalent of NSDataDetector. Phones: **libphonenumber** `PhoneNumberUtil.findNumbers(text, region, Leniency.VALID)` (Apache-2.0; `com.googlecode.libphonenumber:libphonenumber` or the Android-optimised `io.michaelrocks:libphonenumber-android`; roughly 1–2 MB, measure). Email/URL: `android.util.Patterns`. **Dates:** write a JS date finder (`lib/date-finder.ts`; numeric formats plus month names in en/fr/de/es/it/nl/pt; reuse `mentionsTime`) used on Android and as the iOS fallback; it is unit-testable in Jest. **Addresses:** none (Linkify `MAP_ADDRESSES` is deprecated and US-only). Either drop them on Android or add a postcode+street heuristic later. ML Kit Entity Extraction would cover dates and addresses but **downloads its models**, so it is excluded. | M / Med (dates); addresses = parity gap |
| `detectBarcodes(uri)` | → `[{symbology, payload, left, top, width, height}]`, normalised upright, sorted top to bottom, de-duplicated; names match expo-camera (`qr`, `ean13`, `upc_e`, `code128`, `code39`, `code93`, `itf14`, `itf`, `pdf417`, `aztec`, `datamatrix`). Reject `ERR_BARCODES`. | `lib/text-actions.ts:363` | ML Kit **`com.google.mlkit:barcode-scanning:17.3.0`**: bundled, and **already in the APK** through expo-camera (`node_modules/expo-camera/android/build.gradle:31`; `libbarhopper_v3.so` and `mlkit_barcode_models` are in today's APK), so it costs nothing. Decode upright ≤ 3000 px; map `Barcode.FORMAT_*`. | S / Low |
| `detectLanguage(text)` | → BCP-47 or null; first 4000 chars. | `lib/read-aloud.ts` (via Speech), JS | ML Kit **`com.google.mlkit:language-id:17.0.6`** (bundled); `"und"` → null. | S / Low |
| `nameEntities(text)` | → `{people, organizations, places}`. | `app/tools/business-card.tsx:80` (hints only, already optional) | No offline equivalent (Entity Extraction has no person names and downloads models anyway). **Leave it out**: `lib/business-card.ts` parses without hints. A layout heuristic (largest line near the top = name) can come later. | – / parity gap, low impact |

### 1.3 How the features map onto the functions (for test planning)

| User feature | Needs |
|---|---|
| Scan (camera, auto-capture, review, crop, save) | `DocumentCameraView`, `detectQuad`, `warpQuad`, `normalizeImage` |
| Import photo / file, Open with, share to Scan Kit | `detectQuad`/`detectDocument`, `normalizeImage`, `copyIncomingFile`, `incomingFileInfo`, intents |
| OCR, search, searchable PDF, Extract text | `recognize`, `pdfPageTexts` |
| View an imported PDF | `PdfDocumentView`, `pdfInfo`, `unlockPdf` (session), `renderPdfPages` (thumbnails) |
| PDF page tools (rotate, delete, reorder, blank, split, extract, merge) | `pdfEditPages`, `mergePdfs`, `replaceFile`, `pdfInfo`, `protectPdfKeeping` |
| Protect / Unlock / Remove restrictions | `protectPdf`, `protectPdfKeeping`, `pdfPermissions`, `unrestrictPdf`, `unlockPdf` |
| Fill & sign, Flatten | `pdfFillInfo`, `pdfRenderPage`, `pdfFill`, `pdfFlatten`, `replaceFile` |
| Convert PDF to pages, Create PDF from PDFs | `renderPdfPages`, `pdfInfo`, `unlockPdf` |
| Text actions, Business card, QR in image, Read aloud | `detectData`, `detectBarcodes`, `detectLanguage`, `nameEntities`, `speak…`, `presentEventEditor`, `presentNewContact`, `writeVCard` |
| Share pages as images | `shareFiles` |
| Quick actions | `ScanKitQuickActions` |

---

## 2. Third-party dependencies with native code (SDK 54)

| Package | Android in SDK 54? | Notes / action |
|---|---|---|
| `@react-native-async-storage/async-storage` 2.2.0 | Yes | **Default DB cap 6 MB** (`android/config.gradle:89-92`). A doc record holds `ocrText` (`types/document.ts:30`, written at `lib/storage.ts:281`), so a few hundred scanned pages fill it, and any single value > ~2 MB fails to read (SQLite CursorWindow). The `app.json` `expo-build-properties.android.androidStorageSize: 50` is **not a real option** and the generated `gradle.properties` doesn't contain it. Fix: a config plugin that writes `AsyncStorage_db_size_in_MB=…`; better, move `ocrText` out of AsyncStorage into per-document files (also good for iOS). |
| `@react-native-ml-kit/text-recognition` 2.0.0 | Yes (Android only, `react-native.config.js`) | Bundles Latin + CJK + Devanagari models. Keep it for Phase 0 OCR; **remove** once `VisionOcr.recognize` exists on Android (§1.2), unless the owner wants CJK/Devanagari, in which case add those exact ML Kit artifacts to our module. |
| `react-native-document-scanner-plugin` 2.0.4 | Android = `com.google.android.gms:play-services-mlkit-document-scanner:16.0.0` | **Violates "no Play Services downloads".** Exclude it on Android: `react-native.config.js` → `'react-native-document-scanner-plugin': { platforms: { ios: undefined, android: null } }`. Make `lib/tool-scan.ts:17` a lazy `require` inside `scanWithAppleScanner` (iOS only), because its JS calls `TurboModuleRegistry.getEnforcing` at import (`src/NativeDocumentScanner.ts`). Hide the "Apple document scanner" option on Android (`app/settings/scan-settings.tsx:42`; `lib/tool-scan.ts:52` must never return `'apple'` on Android). |
| `expo-camera` 17.0.10 | Yes (CameraX 1.5.0-rc01) | Used for `app/tools/qr.tsx` and the permission hook in `app/onboarding.tsx:41`. It adds **`RECORD_AUDIO`** (block it; iOS says the app doesn't use the microphone) and `play-services-code-scanner` (never called; it only downloads if `launchScanner` is used, so it's acceptable, but note it in the data-safety review). Align our CameraX version with it. |
| `expo-image-picker` 17 | Yes (Android Photo Picker, no permission) | Fine. Phase 0 camera fallback: `launchCameraAsync`. |
| `expo-document-picker` 14 | Yes (SAF; `copyToCacheDirectory: true` in all callers) | Fine. |
| `expo-media-library` 18.2.1 | Yes | The plugin adds `READ_MEDIA_IMAGES/VIDEO/AUDIO`, `READ_MEDIA_VISUAL_USER_SELECTED`, `READ/WRITE_EXTERNAL_STORAGE`, `requestLegacyExternalStorage`. Scan Kit only **saves** (`lib/photos.ts:34-45`, `writeOnly = true`), which needs no permission on API 33+ (`MediaLibraryModule.kt:286-315`). Set plugin `granularPermissions: []` and `android.blockedPermissions` for the `READ_MEDIA_*` ones; keep `WRITE_EXTERNAL_STORAGE` with `maxSdkVersion 28`. Otherwise Play's photo/video permission policy applies. |
| `expo-local-authentication` 17 | Yes (BiometricPrompt) | Works; see App Lock in §3. `faceIDPermission` is iOS-only. |
| `expo-print` 15 | Yes | `printToFileAsync` renders HTML in an Android WebView (`PrintPDFRenderTask.kt:48`, `loadDataWithBaseURL(null,…)`). The app embeds images as `data:` URIs (`lib/pdf.ts:62`), so file access isn't needed. **Verify** page size, zero margins, invisible OCR text layer (selectable in the output) and memory for 50+ page documents. Fallback if it misbehaves: build PDFs natively with PdfBox (images + invisible text), which is more deterministic. |
| `expo-sharing` 14 | Yes (FileProvider) | Fine; single file. |
| `expo-file-system` 19 | Yes | `Paths.document` = `/data/user/0/<pkg>/files/`, `Paths.cache` = `…/cache/`. `lib/storage-layout.ts:167-200` already falls back to Documents when the iOS Application Support shape is absent. `content://` handling is left to our native `copyIncomingFile`. |
| `expo-image-manipulator`, `expo-image`, `expo-crypto`, `expo-clipboard`, `expo-haptics`, `expo-linking`, `expo-constants`, `expo-font`, `expo-splash-screen`, `expo-status-bar`, `expo-system-ui`, `expo-web-browser` | Yes | Haptics are weaker on Android (VIBRATE is in the manifest). `expo-web-browser` opens Custom Tabs (needs a browser; `PAGE_SHEET` is ignored). |
| `expo-blur` 15 | Partial (Android needs `experimentalBlurMethod`) | Today both sites branch to a solid fill on Android (`app/(tabs)/_layout.tsx:154`, `components/camera-controls.tsx:35-36`). Keep the fill (cheaper; Android has no live material), or try `experimentalBlurMethod="dimezisBlurView"` on API 31+. |
| `expo-symbols` 1.0 | **iOS only** | `components/app-icon.tsx:101` already falls back to Ionicons. Better Android glyphs from `MaterialCommunityIcons` (in `@expo/vector-icons`, all verified in its glyph map): `signature` → `signature-freehand`, `rename` → `rename-outline`, `long-image` → `view-sequential-outline`, `watermark` → `watermark`, `id-card` → `card-account-details-outline`, `rotate-left` → `rotate-left`, `eraser` → `eraser`, `highlighter` → `marker`, `pen` → `pencil-outline`, `split` → `view-split-horizontal`, `initials` → `format-letter-case`. Add a `material` field to `SYMBOLS` and render `MaterialCommunityIcons` on Android (vector, matches the "no emoji, polished" rule). |
| `react-native-webview` 13.15 | Yes | See LocalWebView (§3). `onRenderProcessGone` is **required** on Android or a renderer crash kills the app. It's missing at `app/tools/long-image.tsx:284` and `app/tools/id-card.tsx:352`. |
| `react-native-gesture-handler`, `-reanimated` 4.1, `-worklets`, `-screens` 4.16, `-safe-area-context`, `react-native-draggable-flatlist` | Yes | `FullWindowOverlay` (react-native-screens) is iOS-only: on Android it **renders a plain in-flow `<View>` and warns** (`node_modules/react-native-screens/src/components/FullWindowOverlay.tsx:29-31`); see App Lock. |
| `jszip`, `react-native-web`, `@react-navigation/*` | JS | Fine. |
| `ActionSheetIOS`, `Alert.prompt` (RN core) | **iOS only** | Replace (§3). |

---

## 3. JS / UI audit (file:line → fix)

### 3.1 Blocking: crashes or dead controls

| Where | Problem | Fix |
|---|---|---|
| `lib/tool-scan.ts:17` | Top-level import of the document scanner (`getEnforcing`), which throws once it is unlinked on Android | Lazy `require` behind `Platform.OS === 'ios'`. |
| `lib/tool-scan.ts:51-57`, `app/settings/scan-settings.tsx:42-49` | Without the camera view, `cameraChoice()` returns `'apple'` and the Apple scanner can't run on Android | On Android: return `'scankit'` when the view exists; in Phase 0 a `'system'` path through `ImagePicker.launchCameraAsync` (pages as plain images, then `detectDocument` once it exists). Hide the Apple option. |
| `app/pdf-fill.tsx:284`, `app/tools/unrestrict.tsx:195`, `components/create-pdf/sources.ts:76` | `Alert.prompt` with **no platform guard**: a no-op on Android, so password entry silently never appears (and `sources.ts` returns a promise that never settles) | New `components/password-prompt.tsx`: `<Modal transparent statusBarTranslucent navigationBarTranslucent>`, `TextInput secureTextEntry autoFocus`, Cancel/Unlock, honours `alert-guard`/App Lock. Add a promise API `askPdfPassword({title, message})` and replace all five sites. |
| `app/viewer.tsx:1255` (+ guards at `:1300`, `:1586`) | Same prompt; Android hides "Enter password" and says to remove the password elsewhere | Use the new prompt; drop the `Platform.OS === 'ios'` guards. |
| `app/pdf-fill.tsx:644`, `app/viewer.tsx:876,1013,1423`, `app/tools/id-card.tsx:89`, `components/scan-doc-tools.tsx:190`, `components/text-actions.tsx:99`, `components/pdf-page-tools.tsx:405` | `ActionSheetIOS`; the Android fallbacks use `Alert.alert` with N buttons. **Android dialogs show at most 3 buttons** (neutral/negative/positive), so a choice field with 6 options or a phone chip with Call/Message/Copy/Add contact loses options. `destructive` and `isPreferred` are ignored. | New `components/action-sheet.tsx` built on the existing `BottomSheet` (title, message, rows with icons, a destructive style, Cancel). A promise API `chooseAction(...)`. Use it on Android (or on both, for one look). Add a lint rule: no `Alert.alert` with more than 3 buttons on Android. |
| `app/viewer.tsx:1818-1822` | PDF fallback is a WebView with `source={{uri: pdfUri}}`; Android WebView can't render PDFs (blank page) | Phase 0: an empty state ("Viewing PDFs arrives in the next build") with "Open with…" (`ACTION_VIEW` via `expo-sharing` / `Linking`) and Convert to pages hidden. Phase 3: native `PdfDocumentView`. |
| `components/lock-gate.tsx:72,388-390` | `FullWindowOverlay` on Android renders an **in-flow** View appended under the navigator, not over it, so the lock-over-picker and the privacy cover don't cover the app | Android: render `<View style={StyleSheet.absoluteFill}>` instead. On Android, native-stack modals are fragments in the same root view, so an absolute overlay at the root covers them; pickers are separate Activities and need no cover. |
| `app/tools/long-image.tsx:284`, `app/tools/id-card.tsx:352` | No `onRenderProcessGone` (only the iOS `onContentProcessDidTerminate`) | Add it (same handler). |

### 3.2 App Lock on Android (`components/lock-gate.tsx`, `lib/biometrics.ts`, `lib/system-ui.ts`)

* **No `inactive` state** (`lock-gate.tsx:300`). RN Android maps `onHostPause` to `'background'`. So:
  * The privacy cover never shows before the recents thumbnail is taken. **Fix:** a native `setRecentsPrivacy(on)` (`Activity.setRecentsScreenshotEnabled(false)` on API 33+; below that, `FLAG_SECURE`, which also blocks screenshots: an owner decision) toggled with App Lock.
  * **Every app-launched Activity locks the app:** share chooser, document picker, photo picker, the camera intent, Custom Tabs, the calendar and contacts intents, device-credential fallback on API ≤ 29. The user returns from "Share" to a lock screen. **Fix:** wrap all of them in `withSystemUI` (several aren't today: `shareFile`/`printFile`, `openWebLink`), and on Android, while `isSystemUIOpen()`, don't lock on `background`. Lock only on a real leave: a native `OnUserLeavesActivity` hook (Expo module lifecycle; fires on Home/Recents, not on our own `startActivity`), plus a time limit (lock if away > N s even while a picker is open).
* BiometricPrompt runs inside our Activity on API 30+ (no background trip). On API 28–29 the device-credential fallback is a separate Activity, so the lock → prompt → lock loop needs the "authenticating" guard (`isAuthenticating()` exists) to cover `background` too.
* Strings: `components/lock-gate.tsx:115-116`, `app/(tabs)/me.tsx:50-51,145`, `app/settings/help.tsx:40` say "Face ID / Touch ID / passcode". On Android: "Fingerprint / Face unlock / screen lock". `biometricKind()` maps `FACIAL_RECOGNITION`/`FINGERPRINT` correctly; only the labels change.
* `lib/biometrics.ts:90-93`: `fallbackLabel` is iOS-only; on Android, `cancelLabel` is ignored while device fallback is allowed. Fine. Add `promptSubtitle` on Android.
* The emulator can test it: enrol a fingerprint in Settings, then `adb -e emu finger touch 1`.

### 3.3 Back button, keyboard, edge-to-edge, modals

* **Hardware/gesture back** pops `fullScreenModal` routes on Android (`gestureEnabled:false` only stops the iOS swipe). Add `usePreventRemove`/`BackHandler`:
  * `app/camera.tsx`: route back through the existing discard confirm at `:528`; today, back drops the captured pages silently (the unmount at `:236-238` cleans up).
  * `app/annotate.tsx`, `app/pdf-fill.tsx` (unsaved fills), `components/crop-modal.tsx` (`onRequestClose={onCancel}` ok), `components/redact-editor.tsx`, `components/signature-pad.tsx`, `app/viewer.tsx` while `editTab !== null` or a sheet is open (back should close the sheet first).
  * Already handled: `app/lock.tsx:23`, `components/tool-ui.tsx:130`.
  * `app.json` has `predictiveBackGestureEnabled: false`. Keep it for now; enabling it needs the predictive-back opt-in work.
* **Keyboard:** with edge-to-edge (forced at targetSdk 35+; `edgeToEdgeEnabled: true`), `adjustResize` no longer resizes the root. `components/tool-ui.tsx:159` passes `behavior={undefined}` on Android, so inputs end up under the keyboard. Use `'padding'` on both (Expo's recommendation under edge-to-edge) and test every text input: rename, password prompt, recognised-text editor (`components/recognized-text.tsx:100-101` already uses `keyboardDid*`), Fill & sign fields. `components/bottom-sheet.tsx:150` uses `'height'` on Android; re-test.
* **Modals:** RN 0.81 `<Modal>` draws under the system bars only with `statusBarTranslucent` **and** `navigationBarTranslucent`. Add both to `components/bottom-sheet.tsx:145`, `components/reorder-modal.tsx:108`, `components/crop-modal.tsx:309`, `components/create-pdf/doc-page-picker.tsx:145` (`presentationStyle="pageSheet"` is iOS-only; on Android it becomes full screen, which needs safe-area padding), and the new prompt and action sheet. Otherwise insets are counted twice (`insets.bottom` + a bar strip).
* **Bottom sheet dismissal:** `components/bottom-sheet.tsx:101` (`if (Platform.OS !== 'ios') fireDismissed()`) relies on `onDismiss` being iOS-only. That's correct; keep it.
* **System bars:** dark chrome screens (camera, viewer) need light navigation-bar buttons. `expo-status-bar` only controls the status bar. With edge-to-edge the navigation bar is transparent with system-chosen contrast. Test 3-button navigation (insets.bottom = 48 dp): the floating tab bar (`app/(tabs)/_layout.tsx:140-146`) and camera controls must clear it.
* `components/app-switch.tsx:21,41`: an Android `Switch` already has its own branch. Check the visual match with the design (the user insists on polished, aligned UI).

### 3.4 Files, WebView, sharing, printing

* **`components/local-webview.tsx:88,103` + `lib/webview-access.ts:9`:**
  * `allowingReadAccessToURL` is iOS-only (ignored on Android).
  * `webviewReadRoot()` returns `<containerRoot>/Library/`, and `containerRoot()` (`lib/files.ts:809`) on Android is `/data/user/0/<pkg>/`. So **every** page image counts as "outside" and is **copied** into `cache/webview` for every bake, stamp or markup. It still works, but at an I/O and storage cost for every filter preview.
  * Fix: on Android the read root is `containerRoot()` (or `Paths.document` and `Paths.cache`). Android needs `allowFileAccess` (default false since API 30; it's passed already) plus `allowFileAccessFromFileURLs` and `allowUniversalAccessFromFileURLs` (passed; needed for an untainted canvas).
  * Re-verify `FilterBaker` (`components/filter-baker.tsx:112-146`: a 320×2 px, opacity 0.01 off-screen WebView): Android may throttle or not lay out a near-invisible WebView. If bakes stall, give it a real size behind content, or set `androidLayerType="software"` (to test).
* **Paths:** the app's absolute paths come from `expo-file-system` (`file:///data/user/0/…`), and the `/private/var` normalisation in `lib/webview-access.ts:22` and `app/import.tsx` `fileKey` is harmless. **`/data/user/0` vs `/data/data`** are the same directory under two spellings. Make native code return paths through `context.filesDir`/`cacheDir` (which use `/data/user/0`) so JS string comparisons match.
* **"Keep a copy in Files"** (`lib/files-copy.ts:83`): iOS-only by design (the Files app shows Documents). Android equivalent: a SAF folder chosen once (`ACTION_OPEN_DOCUMENT_TREE` + `takePersistableUriPermission`) and the same reconcile logic writing via `DocumentFile`. M effort, Phase 5 or later (owner decision). Until then the row stays hidden; `filesCopyAvailable()` already returns false.
* **Share/print:** `lib/share.ts` (expo-sharing, `Share`, `expo-print`) works. The `UTI` option is ignored; `mimeType` must be set on every call (audit `shareFile` callers for missing `mimeType`, e.g. ZIP `application/zip`). Printing opens the system print UI (an Activity, see the App Lock section).
* **Incoming files** (`app/+native-intent.tsx`, `lib/incoming-file.ts:27-44`, `app/import.tsx:47-75`): accept `content://` and ask native for name/MIME (§1.2). `isOwnInboxCopy` (`app/import.tsx:100+`) is iOS-only logic: on Android, never delete the source.
* **Gallery saving** (`lib/photos.ts`): fine with `writeOnly`, after the permission cleanup in §2.

### 3.5 Copy that says iPhone / iOS

`app/tools/timestamp.tsx:92` ("As on this iPhone"), `components/signature-pad.tsx:279` ("kept on this iPhone only"), `components/multi-share-sheet.tsx:243` ("free space on this iPhone"), `app/tools/create-pdf.tsx:443` ("from the Files app"), `app/(tabs)/me.tsx:36,108,229` (Files app, iOS Settings), `app/settings/help.tsx:40`, `app/settings/scan-settings.tsx:42`, `lib/text-actions.ts:301` (Safari view). Fix: a small `lib/platform-copy.ts` (`deviceNoun()` → "iPhone" / "iPad" / "phone" / "tablet"; `filesAppName()`; `unlockMethodLabel()`), plus a Jest test that greps user-facing strings for "iPhone|iOS|Face ID|Safari|Files app".

### 3.6 `app.json` / config gaps (Android)

| Gap | Fix |
|---|---|
| `android.permissions` lists only CAMERA, but the merged manifest also has `RECORD_AUDIO`, `READ_MEDIA_{IMAGES,VIDEO,AUDIO}`, `READ_MEDIA_VISUAL_USER_SELECTED`, `READ/WRITE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW` (debug), `INTERNET` (verified in `android/app/src/main/AndroidManifest.xml`) | `android.blockedPermissions`: `RECORD_AUDIO`, `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_AUDIO`, `READ_MEDIA_VISUAL_USER_SELECTED`, `READ_EXTERNAL_STORAGE`; media-library `granularPermissions: []`. `INTERNET`: needed by dev builds (Metro). For release, an owner question (§5): removing it via a release-only manifest (`tools:node="remove"`) makes "no network" provable, but check that nothing then breaks (WebView `file://` doesn't need it; Custom Tabs open in the browser's process). |
| `allowBackup="true"` (Expo default) | Documents and AsyncStorage would be included in Google auto-backup (Drive, ≤ 25 MB, so it silently fails for most users anyway). Set `android.allowBackup: false`, or `dataExtractionRules` that exclude `files/` and `databases/` (owner question: iOS includes them in device backups). |
| No intent filters | `android.intentFilters`: `VIEW` (`DEFAULT`, `BROWSABLE` off, data `mimeType: application/pdf` and `image/*`, schemes `content` and `file`), `SEND` and `SEND_MULTIPLE` with the same MIME types. Handled by the module (§1.2). |
| No app shortcuts | Config plugin `plugins/with-android-shortcuts.js`: `res/xml/shortcuts.xml`, 4 vector icons, `<meta-data android:name="android.app.shortcuts">` on MainActivity. |
| Package visibility | `<queries>` for `ACTION_INSERT` events (calendar), the contacts insert action, `ACTION_SEND` chooser, `geo:` (maps), `tel:`, `mailto:`, `sms:` (`lib/text-actions.ts` `openExternal`). |
| FileProvider for `shareFiles` | In the module's `AndroidManifest.xml` (`${applicationId}.visionocr.fileprovider`, paths cache + files). |
| `expo-build-properties` `androidStorageSize: 50` | Not an option, ignored. Replace with a `withGradleProperties` plugin setting `AsyncStorage_db_size_in_MB`, or move `ocrText` out (§2). |
| ABIs | `expo-build-properties` `android.buildArchs: ["arm64-v8a","x86_64"]` (plus `armeabi-v7a` if old 32-bit phones matter); drop `x86`. Cuts native libs by roughly half and build time. |
| Release size | `enableProguardInReleaseBuilds`, `enableShrinkResourcesInReleaseBuilds: true`; keep rules for PdfBox-Android (`-keep class com.tom_roush.**`, `-dontwarn org.bouncycastle.**`, `javax.xml`/`java.awt` stubs), ML Kit is fine, PDFium JNI keep. |
| Adaptive icon | Present (`assets/images/android-icon-{foreground,background,monochrome}.png`), background `#000000`. Check the safe zone (66 dp circle) and the themed (monochrome) icon on a Pixel. |
| `eas.json` | Add Android profiles: `development` (dev client APK), `preview` (APK, internal), `production` (`aab`, `autoIncrement` with `appVersionSource: remote`); `submit.production.android` (service-account JSON, track `internal`). The **first** upload of a new Play app must be done by hand in Play Console. Owner memory "iOS-only builds" (`--platform ios`) must change when Android starts. |
| `orientation: portrait` | Fine for phones; tablets letterbox. Android 16 ignores orientation locks on large screens (≥ 600 dp) for apps targeting 36: test on a tablet or foldable emulator. |
| Splash, `userInterfaceStyle: automatic`, `scheme: scankit` | Fine. |

---

## 4. Phased plan (the app stays runnable throughout)

Rules for every phase:
* Features light up only when their native function exists (the existing presence checks).
* Each native function lands **with** JVM unit tests (pure logic) and an instrumented smoke test.
* Jest stays green (`pnpm test`).
* Emulator: `Pixel_6_API_36` (arm64 image on Apple silicon). Also keep an **API 30 or 31** emulator for older behaviour: no `setRecentsScreenshotEnabled`, the `PdfRenderer` gap, BiometricPrompt fallback.
* Build locally with `pnpm exec expo run:android`; EAS `development` profile for others.

### Phase 0: builds and runs, native features off (≈ 1.5–2 weeks)

1. Exclude `react-native-document-scanner-plugin` on Android; make its import lazy; hide the Apple scanner option. `scanPagesWithCamera` on Android → system camera (`launchCameraAsync`) until Phase 2.
2. `components/password-prompt.tsx` (5 sites) and `components/action-sheet.tsx` (8 sites).
3. LockGate: Android absolute overlay instead of `FullWindowOverlay`; don't lock while app-launched Activities are open (wrap `shareFile`, `printFile`, `openWebLink`, `openExternal` in `withSystemUI`); Android labels.
4. LocalWebView read root on Android; `onRenderProcessGone` in long-image and id-card.
5. Back-button guards (camera discard, annotate, pdf-fill, viewer edit/sheets); `KeyboardAvoidingView` `padding`; `statusBarTranslucent` + `navigationBarTranslucent` on every `<Modal>`.
6. `AppIcon` Android glyph map (MaterialCommunityIcons); `lib/platform-copy.ts`.
7. `app.json`: `blockedPermissions`, media-library `granularPermissions: []`, `allowBackup` decision, `buildArchs`, AsyncStorage size plugin; `eas.json` Android profiles.
8. Viewer: PDF placeholder + "Open with…" instead of the blank WebView.

**Acceptance (emulator):**
* Cold start → onboarding → Home with no red box.
* Import a photo (Photo Picker) and a PDF (Files) → document saved; image viewer, filters (WebView bake), markup, sign, watermark, long image, ID card all work.
* OCR via the existing ML Kit package: search finds a word.
* Export a searchable PDF and share it (Gmail on the emulator, or "Files").
* App Lock: enable it, background via Home → returns locked; enrolled emulator fingerprint unlocks; sharing a file does **not** lock on return.
* Hardware back on camera, annotate and Fill & sign asks before discarding.
* A password-protected PDF shows the new password prompt (the unlock itself still says unavailable).
* The merged manifest has no `RECORD_AUDIO` or `READ_MEDIA_*`.
* `pnpm test` passes.

**Needs a real phone:** none of these features yet; on-device performance smoke only.

### Phase 1: native module skeleton, OCR, image plumbing, intents (≈ 1.5 weeks)

* Add Android to `expo-module.config.json`. Kotlin module `VisionOcr` with the **stub `PdfDocumentView` registered first**.
* `recognize` (ML Kit Latin, bundled, row ordering), then remove `@react-native-ml-kit/text-recognition` (or keep the extra scripts per the owner's answer).
* `normalizeImage`, `warpQuad` (Matrix.setPolyToPoly), `replaceFile` (`Os.rename`), `copyIncomingFile` + `incomingFileInfo`, incoming intents (`VIEW`/`SEND`/`SEND_MULTIPLE`), `shareFiles` (FileProvider), quick actions (shortcuts plugin + `ScanKitQuickActions`), `detectBarcodes`, `detectLanguage`, `writeVCard`.

**Acceptance (emulator):**
* OCR line boxes overlay the right words on a rotated (EXIF 6) photo.
* Crop with a perspective quad (manual corners) gives the same output size and orientation as iOS for the shared fixtures; the corner-order rotation works.
* `adb shell am start -a android.intent.action.VIEW -d content://… -t application/pdf` imports the PDF.
* Share an image from Photos/Files to Scan Kit → imported.
* Long-press the icon → 4 shortcuts → each runs the policy in `lib/quick-actions.ts`.
* "Share pages as images" opens one chooser with N files.
* A QR in a scanned page shows its chip.

**Real phone:** share-to-app from OEM apps (WhatsApp, Gmail, Samsung My Files), whose content URIs differ.

### Phase 2: camera, detection, auto-capture (≈ 3–4 weeks, the largest user value)

* `QuadDetector` (OpenCV) + ported `plausible`/`inset`/`Homography`; `detectQuad`, `detectDocument`.
* `DocumentCameraView` with CameraX, still mode (`simulatorImageUri`, `simulatorJitter`), `AutoCaptureTracker` + `PageSignature` ports, sharpness/motion/AF steadiness, flash/torch, interruptions, close-up zoom, `capture()`/`rearm()`.
* Wire the camera choice to `'scankit'` on Android.

**Acceptance (emulator):**
* JVM tests: tracker and signature give the same decisions as Swift on recorded quad/time sequences (export fixtures from the iOS harness).
* Still mode with the dev photos (`app/camera.tsx` `devPhotos()`, Caches/dev-camera): the overlay hugs the page; auto-capture fires after ~1 s; changing the still to another sheet re-arms; the same sheet doesn't fire twice; jitter 0.5 still captures within ~2 s.
* Emulator **virtual scene** camera (Extended controls → Camera → Virtual scene; put a document image on the table or wall): live detection, a manual shutter, `onCapture` file in `cache/scanner-src`, review → crop → save → OCR.
* Detect in the crop modal and auto-crop on import return sensible quads for the 13-photo test set (≥ 11/13 within 1.5 % of the iOS corners: a target to agree with the owner).

**Real phone only:**
* Focus behaviour (AF state reporting varies by vendor), motion thresholds, flash/torch, low light, glare.
* Auto-capture "feel" and false fires.
* Thermal pause, camera in use by another app.
* 48–200 MP sensors (memory).
* Samsung, Xiaomi and Pixel CameraX quirks; at least one Samsung mid-range phone and one Pixel.

### Phase 3: PDF reading (≈ 3 weeks)

* PDFium + PdfBox in the module. `PdfDocumentView` (replaces the stub), `pdfInfo`, `pdfPageTexts`, `renderPdfPages`, `unlockPdf`, `pdfPermissions`.
* Password-prompt flows end to end (`lib/pdf-session.ts`), thumbnails (`lib/pdf-thumb.ts`), Convert to pages, Create PDF from PDFs, search indexing of imported PDFs.

**Acceptance (emulator)** on a test corpus (keep it in the repo under `__fixtures__/pdf/`, see §5):
* Plain, scanned, 300-page, rotated pages, mixed sizes.
* AcroForm filled (radio, choice, comb) **must show its values**; Fill & sign output from iOS **must show its stamps**.
* Owner-only restricted (bank statement style).
* User-password RC4-128, AES-128 and AES-256.
* Signed, certified, XFA.
* Broken xref (repairs or "Couldn't open").

For each file: viewer pages, zoom, the `initialPage` jump after edits, `onPageChange` counter, thumbnails, text search, Convert to pages; protected ones prompt, unlock for the session, view the decrypted copy, the session ends on background with App Lock.

**Real phone:** scroll and zoom smoothness and memory on a 3–4 GB RAM phone; large scanned PDFs.

### Phase 4: PDF tools (≈ 4–5 weeks)

`pdfEditPages`, `mergePdfs`, `protectPdf`, `protectPdfKeeping`, `unrestrictPdf`, `pdfFillInfo`, `pdfRenderPage`, `pdfFill` (+ burn-in fallback), `pdfFlatten`. Port every "read back and refuse" check and `widenedPermissions`.

**Acceptance (emulator):** for each tool on the corpus:
* Output opens in Scan Kit and in Chrome's PDF viewer on the emulator.
* `qpdf --check` passes (run on the Mac via `adb pull`).
* Permissions never widen (`qpdf --show-encryption` before and after).
* Bookmarks are kept and relinked.
* A form filled on Android shows correctly in Acrobat Reader, in **iOS Scan Kit** (round-trip through AirDrop or email) and in Preview.
* Protect → open on iOS with the password.
* Unrestrict → no `/Encrypt`.
* Flatten → no widgets, values visible, text selectable.
* Fill with é, ü, ß (WinAnsi), Ł, Ș (outside WinAnsi, needs the Type0 fallback), and Arabic (expected limitation, §5).

**Real phone:** performance on big merges; OEM PDF viewers honouring `/NeedAppearances`.

### Phase 5: text actions and extras (≈ 2–3 weeks)

* `detectData` (libphonenumber, Patterns) + `lib/date-finder.ts` (JS, both platforms) + the address decision.
* `speak…` (TTS with emulated pause), `presentEventEditor` (+ `'unknown'` outcome in JS), `presentNewContact`.
* Recents privacy (`setRecentsScreenshotEnabled` / `FLAG_SECURE`).
* Optional: "Keep a copy" via SAF, navigation-bar polish, predictive back.

**Acceptance (emulator):**
* Chips for phone, email, URL and date on fixture pages in en/fr/de.
* Read aloud highlights words, pause/resume continues from the word, leaving the app stops it.
* Add to calendar opens the Calendar insert screen (install Google Calendar on the emulator, or verify `unavailable` copy without one).
* New contact opens prefilled (photo, 4 phones).
* Recents shows a blank card with App Lock on.

**Real phone:** TTS voices actually installed, OEM calendar and contacts apps.

### Phase 6: release hardening and Play internal testing (≈ 1–2 weeks)

* R8 rules, size budget (target: AAB download ≤ 40 MB per ABI; measure after OpenCV, PDFium, PdfBox, ML Kit).
* Crash-free run of the full Jest-equivalent manual checklist.
* Data-safety form ("no data collected or shared"), privacy policy URL (Play requires one for CAMERA).
* Content rating, app signing (Play App Signing), first manual upload, then `eas submit --platform android --profile production` to the internal track.
* Test on 3+ real phones via internal testing (Pixel, Samsung, one low-end Android 10/11).

Rough total: **16–20 developer-weeks**, with Phase 2 (camera) and Phase 4 (fill/flatten) the most likely to overrun.

---

## 5. Risks and open questions for the owner

### Biggest risks

1. **Page detection quality.** Vision's learned segmentation is better than any classic CV pipeline on low-contrast backgrounds. OpenCV may need a learned model later (model licence, size). Auto-capture "feel" can't be proven on the emulator.
2. **PDF fidelity of PdfBox-Android.**
   * Form appearance generation uses the form's fonts and breaks on characters outside WinAnsi unless a Unicode font is substituted.
   * **No complex-script shaping**: Arabic or Hebrew typed into a field or a Fill & sign text mark comes out unjoined, left-to-right. iOS (CoreText) gets it right.
   * Text extraction differs from PDFKit's; large files are slow and memory-hungry.
3. **The viewer must draw annotations and forms.** `PdfRenderer` before API 35 can't. That forces PDFium (≈ 4–6 MB per ABI, a JNI library). Without it, filled forms and Fill & sign results look empty on most phones.
4. **App Lock on Android lifecycle.** No `inactive` state; every picker or share is a `background`; recents thumbnails can't be covered from JS. This needs native help, and it is the most likely source of "it locks me out after sharing" or "my document shows in Recents" bugs.
5. **Storage limits.** AsyncStorage's 6 MB Android cap and 2 MB per-value read limit with `ocrText` in document records. This is data loss or a crash for heavy users unless fixed in Phase 0.
6. **APK/AAB size.** ML Kit OCR (≈ 11 MB `.so` + models per ABI), OpenCV (15–25 MB unslimmed), PDFium, PdfBox + BouncyCastle, on top of RN's ~45 MB of native libs per ABI. Today's debug APK, with all four ABIs, is 82 MB.
7. **Parity gaps by design:**
   * No address detection and no person-name hints offline.
   * The calendar can't report "saved".
   * TTS has no real pause.
   * OCR script coverage: ML Kit has Latin, Chinese, Devanagari, Japanese and Korean, but **no Arabic, Cyrillic, Thai or Greek**.

### Questions

1. **OCR languages:** Latin only (smallest), or also Chinese, Japanese, Korean, Devanagari (+≈ 3.3 MB of models; one shared pipeline `.so`)? Is the missing Arabic/Cyrillic OCR acceptable for v1? There's no bundled offline alternative of comparable quality (Tesseract via tess-two/tesseract4android is offline but much weaker and slower).
2. **Detector:** accept OpenCV's size (or fund a slim OpenCV build), or invest in a hand-written or learned detector?
3. **PDFium for rendering** (recommended), or accept that filled forms and stamps don't show in the viewer on Android < 15?
4. **Arabic/Hebrew in Fill & sign:** accept unjoined text, render non-Latin marks as images (not selectable), or implement shaping (ICU4J `ArabicShaping` + bidi; partial)?
5. **Backups:** `allowBackup=false` (documents never leave the device, matching "no cloud") vs. device-to-device transfer only (`dataExtractionRules`: exclude cloud backup, allow device transfer)?
6. **Recents privacy below Android 13:** use `FLAG_SECURE` (it also blocks screenshots while App Lock is on), or accept a visible thumbnail there?
7. **Release `INTERNET` permission:** remove it from release builds to make "fully offline" verifiable?
8. **minSdk:** keep 24 (Android 7), or raise to 26 or 28 (simpler file APIs, `ImageDecoder`, fewer test targets)? Recommended: 26.
9. **"Keep a copy in Files"** on Android (a SAF folder), and the Apple-scanner setting row: drop on Android, or replace with "System camera"?
10. **ABIs:** ship `armeabi-v7a` (old 32-bit phones) or only `arm64-v8a`? x86_64 is needed for the emulator only.
11. **Test devices:** which real phones are available for Phase 2 (camera) sign-off? At least one Samsung and one Pixel is recommended.
12. **Shared test corpus:** may PDFs and photos for detection and PDF tests be committed (no personal data) so iOS and Android are checked against the same files?

### Sources (library facts checked on the web)
- PdfBox-Android releases / Maven coordinates: https://github.com/TomRoush/PdfBox-Android/releases , https://central.sonatype.com/artifact/com.tom-roush/pdfbox-android
- Android PdfRenderer pre-V and API 35 changes: https://developer.android.com/reference/android/graphics/pdf/PdfRendererPreV , https://developer.android.com/sdk/api_diff/35/changes/android.graphics.pdf.PdfRenderer , https://www.nutrient.io/blog/open-pdf-android/
- PdfiumAndroidKt (io.legere:pdfiumandroid): https://github.com/johngray1965/PdfiumAndroidKt , https://central.sonatype.com/artifact/io.legere/pdfiumandroid
- OpenCV on Maven Central: https://central.sonatype.com/artifact/org.opencv/opencv , listing https://repo1.maven.org/maven2/org/opencv/opencv/
- ML Kit versions: Google Maven metadata (`dl.google.com/dl/android/maven2/com/google/mlkit/{text-recognition,language-id,barcode-scanning}`): text-recognition 16.0.1, language-id 17.0.6, barcode-scanning 17.3.0.
- Vision text-recognition languages (not confirmed for Arabic): https://developer.apple.com/documentation/vision/recognizetextrequest/supportedrecognitionlanguages

---

## Phase 1 status (2026-11-20)

Implemented in `modules/vision-ocr/android/` (Kotlin, Expo Modules API) with the iOS JS contracts: `recognize`, `warpQuad`, `normalizeImage`, `replaceFile`, `copyIncomingFile` (content:// and file://), `incomingFileInfo` (new, Android only), `shareFiles` (FileProvider `${applicationId}.visionocr.fileprovider`), `detectLanguage` (bundled ML Kit language ID), and the `ScanKitQuickActions` module. No views are registered yet, so `PdfDocumentView`/`DocumentCameraView` stay null in JS and the phase-0 PDF placeholder remains.

**OCR engines (owner decision: on-device, no Play Services).** ML Kit Latin (bundled model) reads every page. ML Kit skips script it can't read instead of misreading it, so Arabic is detected from *unread ink*: glyph-sized dark strokes on paper-bright background outside every ML Kit line (`OcrLayout.ink`), at least 0.3 % of the page and a fifth of the ink ML Kit read; a large share of misread-looking ML Kit lines also triggers it, and an Arabic device language lowers both bars. Only then does Tesseract (tessdata_fast `ara`, 1.4 MB) run, on a copy at 1800 px with ML Kit's clean lines painted white. Merge: ML Kit wins wherever it read a clean line; Tesseract lines are kept when they are ≥ 60 % Arabic letters with confidence ≥ 0.6. Rows read right to left when mostly Arabic. Known limit: Arabic-Indic digits are often misread (tessdata_best did no better on them, at 12.6 MB).

**Other decisions.** `react-native-document-scanner-plugin` and `@react-native-ml-kit/text-recognition` are no longer linked on Android (`react-native.config.js`); Scan on Android shows "Camera coming soon on Android" with Import photos until phase 2. "Share to Scan Kit" (`SEND`/`SEND_MULTIPLE`) is rewritten natively into the VIEW URL that `+native-intent` handles; several images become one document. ML Kit's Firelog usage telemetry is cut off (the datatransport backend registry is removed from the manifest). `plugins/with-android-platform.js` writes the app shortcuts and `AsyncStorage_db_size_in_MB=512`; `app.json` sets `allowBackup: false`, `blockedPermissions`, intent filters and `minSdkVersion 26`.

Still to do from phase 1: `detectBarcodes`, `writeVCard`, `detectData` natively (the JS fallback already finds phones, emails and links on Android; dates need the planned JS date finder), and real-phone checks of share-to-app from OEM apps.

## Phase 2 status (2026-11-20)

Implemented in `modules/vision-ocr/android/` with the iOS JS contracts:

* **`DocumentCameraView`** (`DocumentCameraView.kt`): CameraX 1.5.0-rc01 (the version expo-camera already ships, so no second copy) with Preview (`PreviewView`, FILL_CENTER), ImageAnalysis (Y plane at 1280×960, analysed upright through `rotationDegrees` without copying the frame) and ImageCapture, all 4:3. Same props, events, `capture()` / `rearm()`, 10 s watchdog, captures as upright JPEG q 0.92 ≤ 4096 px in `cache/scanner-src/src-<ms>-<n>.jpg` with the outline detected on the still. Native outline overlay (`OutlineOverlay.kt`, same aspect-fill mapping). The view is its own `LifecycleOwner` (RESUMED only while `active`, attached, activity resumed, permission granted and not thermally throttled). Permission is asked once per run (iOS asks only while undetermined); refused → `onCameraError permission`. CameraX camera-state errors → `onCameraState paused in-use/other` or `failed`; thermal ≥ SEVERE → `paused pressure`. Steadiness: Laplacian sharpness, gyroscope + linear acceleration (0.35 rad/s, 0.78 m/s²), `CONTROL_AF_STATE` scanning with the 0.8 s cap. Close-up zoom from `LENS_INFO_MINIMUM_FOCUS_DISTANCE`. Still mode (`simulatorImageUri`, `simulatorJitter`, SplitMix jitter) as on iOS.
* **Page detection: no OpenCV.** `PageDetector.kt` is pure Kotlin (JVM-tested): Canny edges → regions without edges (two closings) plus Otsu bright regions → convex hull → largest inscribed quad *and* the hull's four longest sides extended (restores a corner under a thumb) → sub-pixel line refinement on the gradient → judged on edge support, quad-shape, sheet shape (aspect ≥ 0.2, corners within 45° of square) and iOS's `plausible()`; largest wins, inset 0.5 %. On the 19 shared test photos it is within 0.4 % of iOS Vision's corners (19/19 within 1.5 %), and within 0.3 % of ground truth on 17 synthetic hard cases (low contrast, rotated 30°, out of frame, occluded corner, textured/text backgrounds, blur + noise, low light). APK cost: none (OpenCV's AAR would add a 23.5 MB arm64 / 15.6 MB armv7 / 55.8 MB x86_64 `libopencv_java4.so`). A learned segmentation model can still be added behind it later.
* `AutoCaptureTracker.kt` / `PageSignature` are line-for-line ports; a JVM test replays a 260-frame script and must match the Swift tracker's output frame for frame (`ParityFixture.kt`, recorded from `AutoCaptureTracker.swift`).
* `detectQuad`, `detectDocument` (import auto-crop, output in `cache/page-source/doc-<UUID>.jpg`), `hasCamera` (Android only).
* `PdfDocumentView` placeholder registered first (keeps the default-view slot); JS treats Android as having no PDF view until phase 3.
* JS: Android always uses Scan Kit's camera (no Apple choice in Scan settings); a device without a camera, or a build without the view, offers Import photos ("No camera on this device"). The camera screen's back button/gesture goes through the same close / discard path.

Verified on the Pixel 6 API 36 emulator (virtual-scene camera posed over gRPC with a document poster, and the still mode): see the phase-2 report. Needs a real phone: focus/AF reporting, real hand motion, flash/torch, low light and glare, thermal pause, camera taken by another app, frame-time on mid/low-end phones (the debug build analyses a frame in ~55 ms on the emulator), and vendor CameraX quirks.

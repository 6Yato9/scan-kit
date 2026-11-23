# Scan Kit for Android: releasing to Google Play

What the project already does for a release build, and what only the owner can
do in Play Console. Written 2026-11-22 (phase 6 of `docs/android-port-plan.md`).
Nothing here has been submitted; no `eas build` / `eas submit` has been run.

---

## 1. What a production build is

`eas build --platform android --profile production` builds the **release**
variant as an **AAB** (`eas.json` → `build.production.android.buildType:
"app-bundle"`), with:

* **versionCode** managed by EAS (`cli.appVersionSource: "remote"` +
  `autoIncrement: true`): every production build gets the next code; app.json
  carries no `versionCode` on purpose (it would be ignored). `version`
  (1.0.0) in app.json is the user-visible versionName. To start from a given
  number: `eas build:version:set --platform android`.
* **R8** (code shrinking + obfuscation) and **resource shrinking** on
  (`expo-build-properties` → `enableMinifyInReleaseBuilds`,
  `enableShrinkResourcesInReleaseBuilds`). Keep rules for the libraries that
  need them live in `modules/vision-ocr/android/consumer-rules.pro` (PdfBox's
  optional BouncyCastle / JP2 references, PDFium, Tesseract + Leptonica JNI).
  ML Kit, CameraX, PdfBox (SecurityHandler reflection) and the Expo modules
  ship their own consumer rules.
* **ABIs:** `arm64-v8a` and `armeabi-v7a` only (`buildArchs`). No x86/x86_64:
  Apple-silicon emulators are arm64 and no Play phone needs x86. Every arm64
  native library is 16 KB page aligned (Play's requirement for apps targeting
  Android 15+; checked with `llvm-readelf -l`).
* **Target SDK 36, min SDK 26** (Android 8.0).
* **Signing:** EAS creates and keeps the *upload* key on the first production
  build (answer "Generate a new Android Keystore" → yes). Google holds the
  *app signing* key (Play App Signing, the default for new apps).

### Size (measured on the 2026-11-22 build with bundletool 1.18.1)

| Device | Download from Play | On the phone (APKs) |
|---|---|---|
| arm64-v8a (almost every phone since 2017) | **31.7 MB** | 72.8 MB |
| armeabi-v7a (old 32-bit phones) | **28.8 MB** | 56.9 MB |

Largest pieces per arm64 phone: ML Kit text recognition 11 MB of native code,
React Native 5.9 MB, Tesseract 5.0 MB + Leptonica 2.9 MB (Arabic OCR), ML Kit
barcodes 4.9 MB (shared with the QR tool), PDFium 4.7 MB, the JS bundle 4.5 MB,
Hermes 2.1 MB. Uncompressed native libraries are stored page-aligned (not
compressed) in the APK, which is why the install size is about twice the
download.

---

## 2. Permissions in the release manifest

| Permission | Why | Play form |
|---|---|---|
| `CAMERA` | Scanning documents and the QR tool. Photos stay in the app. | Ordinary runtime permission, no declaration form |
| `USE_BIOMETRIC`, `USE_FINGERPRINT` | App Lock | none |
| `VIBRATE` | Haptic feedback | none |
| `WRITE_EXTERNAL_STORAGE` (`maxSdkVersion 28`) | "Save to Photos" on Android 8–9 only | none |

**Not** in release builds (removed by `plugins/with-android-platform.js`):
`INTERNET`, `ACCESS_NETWORK_STATE` (nothing in the app uses the network;
Android itself now guarantees it can't), `SYSTEM_ALERT_WINDOW` (React Native
debug overlay), `RECORD_AUDIO`, every `READ_MEDIA_*` / `READ_EXTERNAL_STORAGE`
(photos come through the system photo picker, which needs no permission). Debug
builds keep `INTERNET` because they load JavaScript from Metro.

The one extra entry, `com.zerohorizon.scan.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`,
is an app-private signature permission AndroidX adds; it grants nothing.

---

## 3. Privacy behaviour worth knowing for the store listing

* **No backup, no device-to-device copy.** `allowBackup="false"` stops Google
  Drive backup; from Android 12 that flag no longer stops the copy made when a
  new phone is set up, so `dataExtractionRules` exclude every data domain from
  both (`res/xml/scankit_data_extraction_rules.xml`). Documents leave the
  phone only when the user exports or shares them. Why not allow the transfer:
  the document index (AsyncStorage) and the page files would be copied
  separately with no check that both arrive (a half-copied library looks like
  lost documents); the copy would arrive without the App Lock that protected
  it; and a cable-less transfer is restored from the Google account's cloud
  backup, which "fully on the device" rules out. The help text should tell
  users to export their documents (Settings → Export all documents) before
  changing phones.
* **App Lock:** the Recents card is blank while App Lock is on (Android 13+:
  `setRecentsScreenshotEnabled(false)`). Screenshots are never blocked (owner
  decision 2026-11-23), so there is no `FLAG_SECURE`, and on Android 8–12 the
  Recents card can show the last screen. Picking a photo or
  file, sharing, printing, opening a web link in the in-app browser and adding
  to Calendar / Contacts don't ask to unlock afterwards (they are another
  app's screen on Android); leaving the app does, and so does coming back
  from one of those screens more than 2 minutes later.
* **No usage telemetry.** ML Kit's Firelog logging is cut off in the manifest,
  and Play Services is never asked to download the Google code scanner
  (`com.google.mlkit.vision.DEPENDENCIES` removed).

---

## 4. What the owner does in Play Console (once)

1. **Create the app.** Play Console → *Create app*: name "Scan Kit", default
   language, App, Free. Accept the declarations.
2. **Store listing.** Short and full description, icon 512×512, feature
   graphic 1024×500, at least 2 phone screenshots.
3. **Privacy policy URL** (required for every app, and for the camera
   permission). It can be one short page: Scan Kit collects no data, has no
   account, makes no network connections, and keeps documents on the phone.
4. **App content** answers (Policy → App content):
   * **Data safety:** "Does your app collect or share any of the required
     user data types?" → **No**. (With no collection, the encryption-in-transit
     and deletion questions don't apply.) Everything is processed on the
     device: OCR, page detection and PDF tools run locally and the release
     build has no network permission.
   * **Ads:** No ads.
   * **App access:** All functionality is available without special access
     (no login).
   * **Content rating** (IARC questionnaire): category *Utility, Productivity,
     Communication or Other*; answer **No** to violence, sexuality, language,
     controlled substances, gambling, user-to-user interaction / sharing
     content with other users inside the app, location sharing and digital
     purchases. Expected rating: Everyone / PEGI 3 / USK 0.
   * **Target audience:** 13+ (or 18+). Not "children", so the Families policy
     doesn't apply.
   * News app: No. Health, financial, government declarations: none.
     Permissions declarations: none needed (no SMS, call log, location,
     all-files access or photo/video permission).
5. **Internal testing track:** Testing → Internal testing → *Testers*: create
   an email list with the testers' Google accounts, copy the opt-in link.
6. **First release by hand** (the Play API can't create an app's first
   release): build once with
   `eas build --platform android --profile production`, download the `.aab`
   from the EAS build page, then Testing → Internal testing → *Create new
   release* → upload it → release notes → *Save* → *Review release* →
   *Start rollout to Internal testing*. Play App Signing is enabled on this
   first upload.
7. **Service account for `eas submit`:**
   1. Google Cloud console (any project) → IAM & Admin → Service accounts →
      *Create service account* (no roles needed) → Keys → *Add key* → JSON.
   2. Play Console → Users and permissions → *Invite new users* → the
      service account's email → App permissions: Scan Kit → *Release apps to
      testing tracks* (and *View app information*) → Invite.
   3. Save the JSON as `credentials/play-service-account.json` in the project
      (the folder is gitignored; `eas.json` → `submit.production.android.serviceAccountKeyPath`).
      Alternatively upload it to EAS (`eas credentials --platform android` →
      Google Service Account) and delete that line from `eas.json`.

## 5. Every later release

```sh
eas build --platform android --profile production --auto-submit
# or, for a build that already exists:
eas submit --platform android --profile production --latest
```

`submit.production.android` sends it to the **internal** track as a
**draft** (`releaseStatus: "draft"`): open Play Console → Internal testing →
the draft → *Review release* → *Start rollout*. (Draft is also the only status
the API accepts while the app itself is still a draft in Play Console.) When
the app is ready for more people, change `track` to `alpha` (closed testing)
or `production`, and `releaseStatus` to `completed`.

## 6. Checked on the emulator, and what still needs real phones

The release build (R8 + resource shrinking, no INTERNET) was installed on the
Pixel 6 API 36 emulator and run through import + OCR (English and Arabic),
the camera, the image viewer and WebView filters, PDF viewing and
session unlock, every PDF tool, Fill & sign, export and share, App Lock,
shortcuts, text actions and read aloud. Real phones are still needed for:
camera focus/auto-capture feel, OEM share targets and calendar/contacts apps,
TTS voices, App Lock on Android 8–12 (screen-lock fallback as a separate
screen), and performance on low-end devices (Play's pre-launch
report on the internal track covers part of this).

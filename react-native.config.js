// Native packages kept out of a platform's build.
//  - Google ML Kit (@react-native-ml-kit/text-recognition): out of iOS, which
//    uses Apple Vision (its frameworks ship no arm64-simulator slice and add
//    ~20 MB), and out of Android too since the Android side of
//    modules/vision-ocr reads text itself (bundled ML Kit Latin + Tesseract
//    Arabic). The package bundled Chinese, Japanese, Korean and Devanagari
//    models as well. It is no longer used anywhere and can be removed from
//    package.json.
//  - react-native-document-scanner-plugin: iOS only (Apple's VisionKit
//    scanner). Its Android side is Google's Play-Services document scanner,
//    which downloads its model through Play Services: never linked on Android
//    (lib/tool-scan.ts only loads it on iOS).
module.exports = {
  dependencies: {
    '@react-native-ml-kit/text-recognition': {
      platforms: { ios: null, android: null },
    },
    'react-native-document-scanner-plugin': {
      platforms: { android: null },
    },
  },
};

// Native packages kept out of a platform's build.
//  - react-native-document-scanner-plugin: iOS only (Apple's VisionKit
//    scanner). Its Android side is Google's Play-Services document scanner,
//    which downloads its model through Play Services: never linked on Android
//    (lib/tool-scan.ts only loads it on iOS).
module.exports = {
  dependencies: {
    'react-native-document-scanner-plugin': {
      platforms: { android: null },
    },
  },
};

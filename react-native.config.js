// iOS uses Apple Vision for OCR (modules/vision-ocr). Google ML Kit stays on
// Android only: its iOS frameworks ship no arm64-simulator slice, which made the
// app impossible to build for Apple-silicon simulators, and they add ~20 MB.
module.exports = {
  dependencies: {
    '@react-native-ml-kit/text-recognition': {
      platforms: { ios: null },
    },
  },
};

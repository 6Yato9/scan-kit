# Release builds (R8) of the app that uses this module.
# PdfBox-Android: public-key security (BouncyCastle) is left out on purpose
# (android/build.gradle); its references to it are never executed.
-dontwarn org.bouncycastle.**
-dontwarn com.gemalto.jp2.**
-dontwarn javax.xml.bind.**
# PdfiumAndroidKt: Guava is left out (only its page caches use it, never called).
-dontwarn com.google.common.**
-keep class io.legere.pdfiumandroid.** { *; }
# Tesseract4Android ships no consumer rules, and its JNI code finds Java
# classes, fields (mNativeData, ...) and callbacks (onProgressValues) by name:
# renamed or stripped members crash Arabic OCR with NoSuchFieldError.
-keep class com.googlecode.tesseract.android.** { *; }
-keep class com.googlecode.leptonica.android.** { *; }

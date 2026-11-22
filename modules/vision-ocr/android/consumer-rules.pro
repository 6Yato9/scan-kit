# Release builds (R8) of the app that uses this module.
# PdfBox-Android: public-key security (BouncyCastle) is left out on purpose
# (android/build.gradle); its references to it are never executed.
-dontwarn org.bouncycastle.**
-dontwarn com.gemalto.jp2.**
-dontwarn javax.xml.bind.**
# PdfiumAndroidKt: Guava is left out (only its page caches use it, never called).
-dontwarn com.google.common.**
-keep class io.legere.pdfiumandroid.** { *; }

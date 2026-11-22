package expo.modules.visionocr

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import java.io.File

/**
 * Save to Photos on Android 10+ through MediaStore, which needs no permission
 * for an app adding its own images. expo-media-library insists on
 * WRITE_EXTERNAL_STORAGE below Android 13, which this app declares only up to
 * Android 9 (maxSdkVersion 28: no storage prompt on newer phones), so on
 * Android 10–12 its save was refused. Android 8–9 still go through
 * expo-media-library (lib/photos.ts) with that permission.
 */
object PhotoLibrary {
  fun save(context: Context, path: String): String {
    if (Build.VERSION.SDK_INT < 29) throw VisionFailure("ERR_SAVE_PHOTO", "Needs Android 10")
    val file = File(path)
    if (!file.isFile) throw VisionFailure("ERR_SAVE_PHOTO", "No such image")
    val ext = file.extension.lowercase()
    val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)?.takeIf { it.startsWith("image/") } ?: "image/jpeg"
    val resolver = context.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
      put(MediaStore.MediaColumns.MIME_TYPE, mime)
      put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Scan Kit")
      // Hidden from other apps until it is whole.
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val item = resolver.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values)
      ?: throw VisionFailure("ERR_SAVE_PHOTO", "Could not add the image to Photos")
    try {
      val out = resolver.openOutputStream(item) ?: throw VisionFailure("ERR_SAVE_PHOTO", "Could not write the image")
      out.use { o -> file.inputStream().use { it.copyTo(o) } }
      resolver.update(item, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
    } catch (e: Exception) {
      runCatching { resolver.delete(item, null, null) }
      if (e is VisionFailure) throw e
      throw VisionFailure("ERR_SAVE_PHOTO", e.message ?: "Could not save the image")
    }
    return item.toString()
  }
}

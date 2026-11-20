package expo.modules.visionocr

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import org.json.JSONArray
import java.io.File

/** FileProvider of shareFiles (its own subclass, so it never clashes with another library's). */
class VisionOcrFileProvider : FileProvider()

/**
 * Files other apps hand to Scan Kit ("Open with", "Share to"), and files Scan
 * Kit hands to them.
 */
object IncomingFiles {
  /**
   * Copies a system-provided file into the app: content:// (another app's
   * provider: Files, Gmail, WhatsApp…) or file://. The read grant of a
   * content URI only lasts while our activity lives, so callers copy at once.
   */
  fun copy(context: Context, sourceUri: String, destUri: String): String {
    val dest = File(ImageFiles.pathOf(destUri))
    val src = resolve(sourceUri)
    try {
      ImageFiles.writeAtomically(dest) { out ->
        val input = when (src.scheme?.lowercase()) {
          "content" -> context.contentResolver.openInputStream(src)
          "file", null -> File(ImageFiles.pathOf(sourceUri)).inputStream()
          else -> null
        } ?: throw VisionFailure("ERR_COPY_INCOMING", "Bad file URL")
        input.use { it.copyTo(out) }
      }
    } catch (e: VisionFailure) {
      throw e
    } catch (e: Exception) {
      throw VisionFailure("ERR_COPY_INCOMING", e.message ?: "Could not copy the file")
    }
    // A fresh modification date: the startup sweep ages staged files by it.
    dest.setLastModified(System.currentTimeMillis())
    return ImageFiles.uriOf(dest)
  }

  /** { name, mimeType, size } of an incoming content:// or file:// URI (null fields when unknown). */
  fun info(context: Context, uri: String): Map<String, Any?> {
    val u = resolve(uri)
    var name: String? = null
    var size: Long? = null
    var mime: String? = null
    if (u.scheme.equals("content", ignoreCase = true)) {
      try {
        context.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
          if (c.moveToFirst()) {
            val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val si = c.getColumnIndex(OpenableColumns.SIZE)
            if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
            if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
          }
        }
      } catch (_: Exception) {
      }
      mime = try { context.contentResolver.getType(u) } catch (_: Exception) { null }
      if (name == null) name = u.lastPathSegment?.substringAfterLast('/')
    } else {
      val f = File(ImageFiles.pathOf(uri))
      name = f.name
      if (f.isFile) size = f.length()
    }
    if (mime == null || mime == "application/octet-stream") {
      val ext = name?.substringAfterLast('.', "")?.lowercase().orEmpty()
      MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)?.let { mime = it }
    }
    // The type the sending app declared on its intent, then the file's own
    // first bytes (a provider that reports neither name nor type).
    if (mime == null || mime == "application/octet-stream") mime = synchronized(incoming) { incoming[u] } ?: mime
    if (mime == null || mime == "application/octet-stream" || mime == "*/*") sniff(context, u)?.let { mime = it }
    return mapOf("name" to name, "mimeType" to mime, "size" to size?.toDouble())
  }

  /**
   * The URIs that arrived on intents, with the MIME type the sender declared.
   * A content URI must be opened exactly as it was granted, but the string
   * that comes back from JS may have had its escapes decoded on the way
   * through the router ("primary%3APictures%2Fa.jpg" -> "primary:Pictures/a.jpg"),
   * which is another URI to the provider: `resolve` maps it back.
   */
  private val incoming = LinkedHashMap<Uri, String?>()

  fun remember(uri: Uri, type: String?) = synchronized(incoming) {
    incoming.remove(uri)
    incoming[uri] = type
    while (incoming.size > 64) incoming.remove(incoming.keys.first())
  }

  fun resolve(uri: String): Uri {
    synchronized(incoming) {
      for (u in incoming.keys.reversed()) {
        val s = u.toString()
        if (s == uri || Uri.decode(s) == uri || Uri.decode(s) == Uri.decode(uri)) return u
      }
    }
    return Uri.parse(uri)
  }

  private fun sniff(context: Context, u: Uri): String? = try {
    val head = ByteArray(12)
    val n = (if (u.scheme.equals("content", true)) context.contentResolver.openInputStream(u) else File(ImageFiles.pathOf(u.toString())).inputStream())
      ?.use { it.read(head) } ?: 0
    when {
      n >= 4 && head[0] == '%'.code.toByte() && head[1] == 'P'.code.toByte() && head[2] == 'D'.code.toByte() && head[3] == 'F'.code.toByte() -> "application/pdf"
      n >= 3 && head[0] == 0xFF.toByte() && head[1] == 0xD8.toByte() && head[2] == 0xFF.toByte() -> "image/jpeg"
      n >= 4 && head[0] == 0x89.toByte() && head[1] == 'P'.code.toByte() && head[2] == 'N'.code.toByte() && head[3] == 'G'.code.toByte() -> "image/png"
      n >= 12 && String(head, 4, 4, Charsets.US_ASCII) == "ftyp" -> "image/heic"
      n >= 12 && String(head, 0, 4, Charsets.US_ASCII) == "RIFF" && String(head, 8, 4, Charsets.US_ASCII) == "WEBP" -> "image/webp"
      else -> null
    }
  } catch (_: Exception) {
    null
  }

  /** The share chooser for several of the app's own files (ACTION_SEND_MULTIPLE through our FileProvider). */
  fun shareIntent(context: Context, uris: List<String>, title: String?): Intent {
    val authority = "${context.packageName}.visionocr.fileprovider"
    val files = uris.map { File(ImageFiles.pathOf(it)) }.filter { it.isFile }
    if (files.isEmpty()) throw VisionFailure("ERR_SHARE_FILES", "No files")
    val contentUris = ArrayList(files.map { FileProvider.getUriForFile(context, authority, it) })
    val types = files.map { mimeOf(it.name) }.toSet()
    val type = when {
      types.size == 1 -> types.first()
      types.all { it.startsWith("image/") } -> "image/*"
      else -> "*/*"
    }
    val send = Intent(if (contentUris.size == 1) Intent.ACTION_SEND else Intent.ACTION_SEND_MULTIPLE).apply {
      setType(type)
      if (contentUris.size == 1) putExtra(Intent.EXTRA_STREAM, contentUris[0])
      else putParcelableArrayListExtra(Intent.EXTRA_STREAM, contentUris)
      // Every URI in the ClipData too, so the read grant covers all of them.
      clipData = android.content.ClipData.newUri(context.contentResolver, files[0].name, contentUris[0]).also { clip ->
        for (i in 1 until contentUris.size) clip.addItem(android.content.ClipData.Item(contentUris[i]))
      }
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    return Intent.createChooser(send, title).apply { addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
  }

  private fun mimeOf(name: String): String =
    MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

  // ── Share to Scan Kit ──────────────────────────────────────────────────────

  /**
   * Turns "Share to Scan Kit" (ACTION_SEND / SEND_MULTIPLE, files in
   * EXTRA_STREAM) into the VIEW intent React Native's Linking reports, so it
   * reaches expo-router's +native-intent like "Open with" does:
   *  - one file  -> VIEW <content://…> (app/import.tsx imports it);
   *  - several   -> VIEW scankit://import?uris=<JSON array> (imported together).
   * Called before React Native reads the intent (ReactActivityLifecycleListener
   * runs ahead of the delegate). The read grants stay with the activity.
   */
  fun rewriteShareIntent(intent: Intent?) {
    if (intent == null) return
    if (intent.action == Intent.ACTION_VIEW) {
      val data = intent.data
      val type = intent.type
      if (data != null && !data.scheme.equals("scankit", true)) remember(data, type)
      return
    }
    val streams: List<Uri> = when (intent.action) {
      Intent.ACTION_SEND -> listOfNotNull(streamExtra(intent))
      Intent.ACTION_SEND_MULTIPLE -> streamListExtra(intent)
      else -> return
    }.filter { it.scheme.equals("content", true) || it.scheme.equals("file", true) }
    if (streams.isEmpty()) return
    streams.forEach { remember(it, intent.type) }
    intent.action = Intent.ACTION_VIEW
    if (streams.size == 1) {
      intent.setDataAndType(streams[0], intent.type)
    } else {
      val list = JSONArray()
      streams.forEach { list.put(it.toString()) }
      intent.data = Uri.parse("scankit://import?uris=" + Uri.encode(list.toString()))
    }
  }

  @Suppress("DEPRECATION")
  private fun streamExtra(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri

  @Suppress("DEPRECATION")
  private fun streamListExtra(intent: Intent): List<Uri> =
    (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)) ?: emptyList()
}

package expo.modules.visionocr

import android.content.Context
import android.os.Build
import android.text.SpannableString
import android.text.style.URLSpan
import android.text.util.Linkify
import android.util.Log
import android.view.textclassifier.TextClassificationManager
import android.view.textclassifier.TextClassifier
import android.view.textclassifier.TextLinks

/**
 * Phone numbers, email addresses, links and postal addresses in a page's text
 * (TextActions.detectData on iOS, which uses NSDataDetector). Everything runs
 * on the device:
 *
 * - Phones, emails and links: the platform's Linkify. Its phone finder is the
 *   system copy of libphonenumber (the device's region decides how a number
 *   without a country code is read, as NSDataDetector does), and its email and
 *   web patterns are android.util.Patterns. No library added to the APK.
 * - Postal addresses: the system text classifier (TextClassifier, API 28+;
 *   on-device models shipped with the OS, the same engine that underlines an
 *   address in a text selection). It's a system service, not Google Play
 *   Services, and it never goes to the network. Phones without one (or with
 *   the no-op classifier) simply report no addresses. Android has no address
 *   parser, so `address` carries no parts: JS uses the matched text.
 * - Dates are found in JS (lib/date-finder.ts) on Android, where no system
 *   API returns a parsed date for a span of text.
 *
 * Result shape and units match iOS: { type, text, range: [start, length],
 * value } with UTF-16 offsets (a Kotlin String index is a JS string index).
 */
object TextData {
  private const val TAG = "VisionOcr"

  fun detect(context: Context, text: String): List<Map<String, Any>> {
    if (text.isBlank()) return emptyList()
    val found = ArrayList<Found>()
    found += linkified(text)
    found += addresses(context, text)
    return tidy(found, text).map { it.toMap(text) }
  }

  data class Found(val type: String, val start: Int, val end: Int, val value: String) {
    fun toMap(source: String): Map<String, Any> = mapOf(
      "type" to type,
      "text" to source.substring(start, end),
      "range" to listOf(start, end - start),
      "value" to value,
    )
  }

  private fun linkified(text: String): List<Found> {
    val s = SpannableString(text)
    try {
      if (!Linkify.addLinks(s, Linkify.PHONE_NUMBERS or Linkify.EMAIL_ADDRESSES or Linkify.WEB_URLS)) return emptyList()
    } catch (e: Exception) {
      Log.w(TAG, "detectData: linkify failed", e)
      return emptyList()
    }
    return s.getSpans(0, s.length, URLSpan::class.java).mapNotNull { span ->
      val start = s.getSpanStart(span)
      val end = s.getSpanEnd(span)
      if (start < 0 || end <= start) null else fromUrl(span.url, text.substring(start, end), start, end)
    }
  }

  /**
   * A Linkify span's URL as a detection: "tel:…" is a phone number (its value
   * the number as written, like NSDataDetector's), "mailto:…" an email, an
   * http(s) URL a link (Linkify adds "http://" to "www.example.com", as iOS does).
   */
  fun fromUrl(url: String, matched: String, start: Int, end: Int): Found? {
    val lower = url.lowercase()
    return when {
      lower.startsWith("tel:") -> Found("phone", start, end, matched.trim())
      lower.startsWith("mailto:") -> {
        val address = try {
          java.net.URLDecoder.decode(url.substring(7), "UTF-8")
        } catch (_: Exception) {
          url.substring(7)
        }
        Found("email", start, end, address)
      }
      // Scheme and host lower-cased: OCR mixes case ("wwW.Acme.com"), which
      // means nothing in a host name but looks wrong in a contact.
      lower.startsWith("http://") || lower.startsWith("https://") ->
        Found("url", start, end, Regex("^[^:]+://[^/?#]*").replace(url) { it.value.lowercase() })
      else -> null
    }
  }

  private fun addresses(context: Context, text: String): List<Found> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return emptyList()
    return try {
      val manager = context.getSystemService(TextClassificationManager::class.java) ?: return emptyList()
      val classifier = manager.textClassifier
      if (classifier === TextClassifier.NO_OP) return emptyList()
      val input = text.take(classifier.maxGenerateLinksTextLength.coerceAtLeast(0))
      val config = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        TextClassifier.EntityConfig.Builder()
          .setIncludedTypes(listOf(TextClassifier.TYPE_ADDRESS))
          .includeTypesFromTextClassifier(false)
          .build()
      } else {
        @Suppress("DEPRECATION")
        TextClassifier.EntityConfig.createWithExplicitEntityList(listOf(TextClassifier.TYPE_ADDRESS))
      }
      val request = TextLinks.Request.Builder(input).setEntityConfig(config).build()
      classifier.generateLinks(request).links.mapNotNull { link ->
        val start = link.start
        val end = link.end
        val isAddress = (0 until link.entityCount).any { link.getEntity(it) == TextClassifier.TYPE_ADDRESS }
        if (!isAddress || start < 0 || end > input.length || end <= start) {
          null
        } else {
          val matched = input.substring(start, end)
          if (plausibleAddress(matched)) Found("address", start, end, matched) else null
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "detectData: text classifier failed", e)
      emptyList()
    }
  }

  /** A street address has a number and at least two words besides it ("12 Rue de Rivoli"). */
  fun plausibleAddress(s: String): Boolean {
    if (!s.any { it.isDigit() }) return false
    val words = s.split(Regex("[\\s,]+")).count { w -> w.any { it.isLetter() } }
    return words >= 2
  }

  /**
   * In reading order, without overlaps: where two detections overlap the
   * longer one wins (an address keeps its house number rather than losing it
   * to a phone match), and `text` is what the range covers.
   */
  fun tidy(found: List<Found>, text: String): List<Found> {
    val kept = ArrayList<Found>()
    for (f in found.sortedWith(compareByDescending<Found> { it.end - it.start }.thenBy { it.start })) {
      if (f.start < 0 || f.end > text.length || f.end <= f.start) continue
      if (kept.any { f.start < it.end && f.end > it.start }) continue
      kept.add(f)
    }
    return kept.sortedBy { it.start }
  }
}

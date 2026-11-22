package expo.modules.visionocr

import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * A vCard 3.0 of a contact read off a business card (ContactCard.writeVCard
 * on iOS). The text is the same, line for line, as what iOS writes
 * (CNContactVCardSerialization plus Scan Kit's PHOTO; captured from iOS 26.5):
 * CRLF lines, UTF-8 without CHARSET, no folding except PHOTO, N always, FN
 * only for a person's name, ORG as "company;department", the first EMAIL,
 * TEL and ADR marked pref, URLs as itemN.URL with the home-page label, no
 * NOTE (Apple's serializer leaves notes out), PHOTO last, folded at 75
 * octets. Only PRODID names the app and platform that wrote it.
 */
object VCard {
  const val PRODID = "-//Scan Kit//Android//EN"

  /** The card's text for `f` (the JS ContactFields), `photoBase64` = a JPEG's base64 or null. */
  fun build(f: Map<String, Any?>, photoBase64: String?): String {
    fun str(k: String) = (f[k] as? String)?.trim() ?: ""
    fun list(k: String) = ((f[k] as? List<*>) ?: emptyList<Any?>()).mapNotNull { (it as? String)?.trim() }.filter { it.isNotEmpty() }
    val lines = ArrayList<String>()
    lines += "BEGIN:VCARD"
    lines += "VERSION:3.0"
    lines += "PRODID:$PRODID"

    val prefix = str("namePrefix")
    val given = str("givenName")
    val middle = str("middleName")
    val family = str("familyName")
    val suffix = str("nameSuffix")
    lines += "N:" + listOf(family, given, middle, prefix, suffix).joinToString(";") { esc(it) }
    val full = listOf(prefix, given, middle, family, suffix).filter { it.isNotEmpty() }.joinToString(" ")
    if (full.isNotEmpty()) lines += "FN:" + esc(full)

    val org = str("organizationName")
    val dept = str("departmentName")
    if (org.isNotEmpty() || dept.isNotEmpty()) lines += "ORG:" + esc(org) + ";" + esc(dept)
    val title = str("jobTitle")
    if (title.isNotEmpty()) lines += "TITLE:" + esc(title)

    list("emails").forEachIndexed { i, e ->
      lines += "EMAIL;type=INTERNET;type=WORK" + (if (i == 0) ";type=pref" else "") + ":" + esc(e)
    }

    val phones = ((f["phones"] as? List<*>) ?: emptyList<Any?>()).mapNotNull { p ->
      val m = p as? Map<*, *> ?: return@mapNotNull null
      val number = (m["number"] as? String)?.trim().orEmpty()
      if (number.isEmpty()) null else number to (m["label"] as? String)
    }
    phones.forEachIndexed { i, (number, label) ->
      val type = when (label) {
        "mobile" -> "type=CELL;type=VOICE"
        "fax" -> "type=WORK;type=FAX"
        "main" -> "type=MAIN"
        else -> "type=WORK;type=VOICE"
      }
      lines += "TEL;" + type + (if (i == 0) ";type=pref" else "") + ":" + esc(number)
    }

    val addresses = ((f["addresses"] as? List<*>) ?: emptyList<Any?>()).mapNotNull { a ->
      val m = a as? Map<*, *> ?: return@mapNotNull null
      fun part(k: String) = (m[k] as? String) ?: ""
      val street = part("street")
      val city = part("city")
      val postal = part("postalCode")
      val country = part("country")
      // iOS keeps an address only when one of these is there.
      if (street.isEmpty() && city.isEmpty() && postal.isEmpty() && country.isEmpty()) null
      else listOf("", "", street, city, part("state"), postal, country)
    }
    addresses.forEachIndexed { i, parts ->
      lines += "ADR;type=WORK" + (if (i == 0) ";type=pref" else "") + ":" + parts.joinToString(";") { esc(it) }
    }

    list("urls").forEachIndexed { i, u ->
      val item = "item${i + 1}"
      lines += "$item.URL" + (if (i == 0) ";type=pref" else "") + ":" + esc(u)
      lines += "$item.X-ABLabel:_\$!<HomePage>!\$_"
    }

    val sb = StringBuilder()
    for (l in lines) sb.append(l).append("\r\n")
    if (!photoBase64.isNullOrEmpty()) sb.append(foldedPhoto(photoBase64))
    sb.append("END:VCARD\r\n")
    return sb.toString()
  }

  /** "PHOTO;ENCODING=b;TYPE=JPEG:" + base64, folded at 75 octets (continuations start with a space), CRLF. */
  fun foldedPhoto(b64: String): String {
    val sb = StringBuilder("PHOTO;ENCODING=b;TYPE=JPEG:")
    var line = sb.length
    for (ch in b64) {
      if (line >= 75) {
        sb.append("\r\n ")
        line = 1
      }
      sb.append(ch)
      line += 1
    }
    sb.append("\r\n")
    return sb.toString()
  }

  /** vCard 3.0 text escaping (RFC 2426 §4): backslash, newline, comma and semicolon. */
  fun esc(s: String): String {
    val sb = StringBuilder(s.length)
    var i = 0
    while (i < s.length) {
      when (val c = s[i]) {
        '\\' -> sb.append("\\\\")
        ';' -> sb.append("\\;")
        ',' -> sb.append("\\,")
        '\r' -> {
          sb.append("\\n")
          if (i + 1 < s.length && s[i + 1] == '\n') i++
        }
        '\n' -> sb.append("\\n")
        else -> sb.append(c)
      }
      i++
    }
    return sb.toString()
  }

  /** The contact photo as iOS makes it: upright, long edge ≤ 720 px, JPEG at 0.8. Null when there's none or it can't be read. */
  fun photoJpeg(f: Map<String, Any?>, maxEdge: Int = 720): ByteArray? {
    val uri = (f["imageUri"] as? String)?.takeIf { it.isNotBlank() } ?: return null
    return try {
      val bitmap = ImageFiles.decodeUpright(ImageFiles.pathOf(uri), maxEdge)
      try {
        ByteArrayOutputStream().use { out ->
          bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, out)
          out.toByteArray()
        }
      } finally {
        bitmap.recycle()
      }
    } catch (_: Throwable) {
      null
    }
  }

  fun write(f: Map<String, Any?>, out: File) {
    val photo = photoJpeg(f)?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
    val text = build(f, photo)
    out.parentFile?.mkdirs()
    ImageFiles.writeAtomically(out) { it.write(text.toByteArray(Charsets.UTF_8)) }
  }
}

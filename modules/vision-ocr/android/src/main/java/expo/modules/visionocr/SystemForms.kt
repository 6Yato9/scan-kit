package expo.modules.visionocr

import android.content.ContentValues
import android.content.Intent
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds

/**
 * The system "new event" and "new contact" screens, prefilled
 * (EventEditor.swift / ContactCard.swift on iOS). Nothing is written by Scan
 * Kit: the user reviews and saves in the Calendar or Contacts app, so no
 * calendar or contacts permission is needed.
 *
 * Outcomes (the JS PresentOutcome):
 * - Contacts: the editor answers RESULT_OK with the new contact when it was
 *   saved (finishActivityOnSaveCompleted brings the user straight back), so
 *   "saved" / "cancelled" as on iOS.
 * - Calendar: calendar apps don't report whether the event was added (Google
 *   Calendar answers RESULT_CANCELED either way), so anything but RESULT_OK is
 *   "unknown": JS then neither confirms "Added" nor shows an error.
 * - No app for the screen: "unavailable".
 */
object SystemForms {
  const val EVENT_REQUEST = 7312
  const val CONTACT_REQUEST = 7313

  fun eventIntent(title: String, startMs: Double, endMs: Double, allDay: Boolean, notes: String?, location: String?): Intent {
    val begin = startMs.toLong()
    val end = maxOf(begin, endMs.toLong())
    return Intent(Intent.ACTION_INSERT).apply {
      data = CalendarContract.Events.CONTENT_URI
      putExtra(CalendarContract.Events.TITLE, title)
      putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin)
      putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
      putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, allDay)
      if (!notes.isNullOrBlank()) putExtra(CalendarContract.Events.DESCRIPTION, notes)
      if (!location.isNullOrBlank()) putExtra(CalendarContract.Events.EVENT_LOCATION, location)
    }
  }

  fun eventOutcome(resultCode: Int): String = if (resultCode == android.app.Activity.RESULT_OK) "saved" else "unknown"

  fun contactOutcome(resultCode: Int): String = if (resultCode == android.app.Activity.RESULT_OK) "saved" else "cancelled"

  /**
   * ACTION_INSERT for a raw contact with every field as data rows
   * (Intents.Insert.DATA), so labels, several phones, emails, sites,
   * addresses, the structured name and the photo all arrive as on iOS.
   */
  fun contactIntent(f: Map<String, Any?>, photo: ByteArray?): Intent {
    val rows = contactRows(f).mapTo(ArrayList()) { it.toContentValues() }
    if (photo != null) {
      rows.add(ContentValues().apply {
        put(ContactsContract.Data.MIMETYPE, CommonDataKinds.Photo.CONTENT_ITEM_TYPE)
        put(CommonDataKinds.Photo.PHOTO, photo)
      })
    }
    return Intent(ContactsContract.Intents.Insert.ACTION).apply {
      type = ContactsContract.RawContacts.CONTENT_TYPE
      putParcelableArrayListExtra(ContactsContract.Intents.Insert.DATA, rows)
      // The note goes in as a row too; NAME/COMPANY extras keep editors that ignore DATA useful.
      displayName(f)?.let { putExtra(ContactsContract.Intents.Insert.NAME, it) }
      (f["organizationName"] as? String)?.trim()?.takeIf { it.isNotEmpty() }?.let { putExtra(ContactsContract.Intents.Insert.COMPANY, it) }
      // Google Contacts' quick editor ignores address rows in DATA but reads
      // this extra (the full editors merge it with the same row, not twice).
      formattedAddress(f)?.let {
        putExtra(ContactsContract.Intents.Insert.POSTAL, it)
        putExtra(ContactsContract.Intents.Insert.POSTAL_TYPE, CommonDataKinds.StructuredPostal.TYPE_WORK)
      }
      putExtra("finishActivityOnSaveCompleted", true)
    }
  }

  /** The first address on one line ("1 Market St, 94105 San Francisco, CA, United States"), or null. */
  fun formattedAddress(f: Map<String, Any?>): String? {
    val a = ((f["addresses"] as? List<*>)?.firstOrNull() as? Map<*, *>) ?: return null
    fun part(k: String) = (a[k] as? String)?.trim()?.replace(Regex("\\s*\\n\\s*"), ", ") ?: ""
    val cityLine = listOf(part("postalCode"), part("city")).filter { it.isNotEmpty() }.joinToString(" ")
    val parts = listOf(part("street"), cityLine, part("state"), part("country")).filter { it.isNotEmpty() }
    if (part("street").isEmpty() && part("city").isEmpty() && part("postalCode").isEmpty() && part("country").isEmpty()) return null
    return parts.joinToString(", ")
  }

  private fun displayName(f: Map<String, Any?>): String? {
    val parts = listOf("namePrefix", "givenName", "middleName", "familyName", "nameSuffix")
      .mapNotNull { (f[it] as? String)?.trim()?.takeIf { s -> s.isNotEmpty() } }
    return parts.joinToString(" ").takeIf { it.isNotEmpty() }
  }

  /** One data row: its MIME type and columns (pure, so it can be tested without Android). */
  data class Row(val mime: String, val values: Map<String, Any>) {
    fun toContentValues(): ContentValues = ContentValues().apply {
      put(ContactsContract.Data.MIMETYPE, mime)
      for ((k, v) in values) {
        when (v) {
          is Int -> put(k, v)
          else -> put(k, v.toString())
        }
      }
    }
  }

  fun contactRows(f: Map<String, Any?>): List<Row> {
    fun str(k: String) = (f[k] as? String)?.trim() ?: ""
    fun list(k: String) = ((f[k] as? List<*>) ?: emptyList<Any?>()).mapNotNull { (it as? String)?.trim() }.filter { it.isNotEmpty() }
    val rows = ArrayList<Row>()
    val name = linkedMapOf<String, Any>()
    fun putName(col: String, k: String) { str(k).takeIf { it.isNotEmpty() }?.let { name[col] = it } }
    putName(CommonDataKinds.StructuredName.PREFIX, "namePrefix")
    putName(CommonDataKinds.StructuredName.GIVEN_NAME, "givenName")
    putName(CommonDataKinds.StructuredName.MIDDLE_NAME, "middleName")
    putName(CommonDataKinds.StructuredName.FAMILY_NAME, "familyName")
    putName(CommonDataKinds.StructuredName.SUFFIX, "nameSuffix")
    if (name.isNotEmpty()) rows += Row(CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE, name)

    val org = linkedMapOf<String, Any>()
    str("organizationName").takeIf { it.isNotEmpty() }?.let { org[CommonDataKinds.Organization.COMPANY] = it }
    str("departmentName").takeIf { it.isNotEmpty() }?.let { org[CommonDataKinds.Organization.DEPARTMENT] = it }
    str("jobTitle").takeIf { it.isNotEmpty() }?.let { org[CommonDataKinds.Organization.TITLE] = it }
    if (org.isNotEmpty()) {
      org[CommonDataKinds.Organization.TYPE] = CommonDataKinds.Organization.TYPE_WORK
      rows += Row(CommonDataKinds.Organization.CONTENT_ITEM_TYPE, org)
    }

    for (p in (f["phones"] as? List<*>) ?: emptyList<Any?>()) {
      val m = p as? Map<*, *> ?: continue
      val number = (m["number"] as? String)?.trim().orEmpty()
      if (number.isEmpty()) continue
      val type = when (m["label"] as? String) {
        "mobile" -> CommonDataKinds.Phone.TYPE_MOBILE
        "fax" -> CommonDataKinds.Phone.TYPE_FAX_WORK
        "main" -> CommonDataKinds.Phone.TYPE_MAIN
        else -> CommonDataKinds.Phone.TYPE_WORK
      }
      rows += Row(CommonDataKinds.Phone.CONTENT_ITEM_TYPE, linkedMapOf(CommonDataKinds.Phone.NUMBER to number, CommonDataKinds.Phone.TYPE to type))
    }
    for (e in list("emails")) {
      rows += Row(CommonDataKinds.Email.CONTENT_ITEM_TYPE, linkedMapOf(CommonDataKinds.Email.ADDRESS to e, CommonDataKinds.Email.TYPE to CommonDataKinds.Email.TYPE_WORK))
    }
    for (u in list("urls")) {
      rows += Row(CommonDataKinds.Website.CONTENT_ITEM_TYPE, linkedMapOf(CommonDataKinds.Website.URL to u, CommonDataKinds.Website.TYPE to CommonDataKinds.Website.TYPE_HOMEPAGE))
    }
    for (a in (f["addresses"] as? List<*>) ?: emptyList<Any?>()) {
      val m = a as? Map<*, *> ?: continue
      fun part(k: String) = (m[k] as? String)?.trim() ?: ""
      val values = linkedMapOf<String, Any>()
      part("street").takeIf { it.isNotEmpty() }?.let { values[CommonDataKinds.StructuredPostal.STREET] = it }
      part("city").takeIf { it.isNotEmpty() }?.let { values[CommonDataKinds.StructuredPostal.CITY] = it }
      part("state").takeIf { it.isNotEmpty() }?.let { values[CommonDataKinds.StructuredPostal.REGION] = it }
      part("postalCode").takeIf { it.isNotEmpty() }?.let { values[CommonDataKinds.StructuredPostal.POSTCODE] = it }
      part("country").takeIf { it.isNotEmpty() }?.let { values[CommonDataKinds.StructuredPostal.COUNTRY] = it }
      // As iOS: an address needs a street, city, postcode or country.
      if (values.keys.none { it != CommonDataKinds.StructuredPostal.REGION }) continue
      values[CommonDataKinds.StructuredPostal.TYPE] = CommonDataKinds.StructuredPostal.TYPE_WORK
      rows += Row(CommonDataKinds.StructuredPostal.CONTENT_ITEM_TYPE, values)
    }
    str("note").takeIf { it.isNotEmpty() }?.let {
      rows += Row(CommonDataKinds.Note.CONTENT_ITEM_TYPE, linkedMapOf(CommonDataKinds.Note.NOTE to it))
    }
    return rows
  }
}

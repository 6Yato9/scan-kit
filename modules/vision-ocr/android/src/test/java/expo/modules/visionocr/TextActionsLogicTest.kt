package expo.modules.visionocr

import com.google.mlkit.vision.barcode.common.Barcode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Phase 5: the pure parts of text actions, read aloud, contacts and merge naming. */
class VCardTest {
  /** The cards iOS 26.5 writes for the same fields (ContactCard.writeVCard), PRODID aside. */
  private fun ios(vararg lines: String) =
    (listOf("BEGIN:VCARD", "VERSION:3.0", "PRODID:${VCard.PRODID}") + lines + "END:VCARD").joinToString("") { "$it\r\n" }

  private val a: Map<String, Any?> = mapOf(
    "givenName" to "Sarah", "familyName" to "Mitchell", "organizationName" to "Acme Corp", "jobTitle" to "Sales Director",
    "phones" to listOf(
      mapOf("number" to "+1 (415) 555-0132", "label" to "work"),
      mapOf("number" to "+1 415 555 0199", "label" to "mobile"),
      mapOf("number" to "+1 415 555 0100", "label" to "fax"),
      mapOf("number" to "+1 415 555 0111", "label" to "main"),
    ),
    "emails" to listOf("sarah@acme.com", "s.mitchell@example.org"),
    "urls" to listOf("https://acme.com", "www.example.org"),
    "addresses" to listOf(mapOf("street" to "1 Market St\nSuite 200", "city" to "San Francisco", "state" to "CA", "postalCode" to "94105", "country" to "United States")),
    "note" to "Met at expo; follow up, re: pricing\\discount",
  )

  @Test fun fullCardMatchesIos() {
    assertEquals(
      ios(
        "N:Mitchell;Sarah;;;",
        "FN:Sarah Mitchell",
        "ORG:Acme Corp;",
        "TITLE:Sales Director",
        "EMAIL;type=INTERNET;type=WORK;type=pref:sarah@acme.com",
        "EMAIL;type=INTERNET;type=WORK:s.mitchell@example.org",
        "TEL;type=WORK;type=VOICE;type=pref:+1 (415) 555-0132",
        "TEL;type=CELL;type=VOICE:+1 415 555 0199",
        "TEL;type=WORK;type=FAX:+1 415 555 0100",
        "TEL;type=MAIN:+1 415 555 0111",
        "ADR;type=WORK;type=pref:;;1 Market St\\nSuite 200;San Francisco;CA;94105;United States",
        "item1.URL;type=pref:https://acme.com",
        "item1.X-ABLabel:_\$!<HomePage>!\$_",
        "item2.URL:www.example.org",
        "item2.X-ABLabel:_\$!<HomePage>!\$_",
      ),
      VCard.build(a, null),
    )
  }

  @Test fun namePartsAndUnicodeMatchIos() {
    val b = mapOf(
      "namePrefix" to "Dr.", "givenName" to "Zoë", "middleName" to "Ana", "familyName" to "Ørsted-Łukasz", "nameSuffix" to "PhD",
      "departmentName" to "R&D", "organizationName" to "Société Générale", "phones" to listOf(mapOf("number" to "06 12 34 56 78")),
    )
    assertEquals(
      ios(
        "N:Ørsted-Łukasz;Zoë;Ana;Dr.;PhD",
        "FN:Dr. Zoë Ana Ørsted-Łukasz PhD",
        "ORG:Société Générale;R&D",
        "TEL;type=WORK;type=VOICE;type=pref:06 12 34 56 78",
      ),
      VCard.build(b, null),
    )
  }

  @Test fun companyOnlyAndEmptyMatchIos() {
    assertEquals(
      ios("N:;;;;", "ORG:Only Company Ltd;", "EMAIL;type=INTERNET;type=WORK;type=pref:info@only.co"),
      VCard.build(mapOf("organizationName" to "Only Company Ltd", "emails" to listOf("info@only.co")), null),
    )
    val empty = ios("N:;;;;")
    assertEquals(empty, VCard.build(emptyMap(), null))
    assertEquals(empty, VCard.build(mapOf("givenName" to "  ", "phones" to listOf(mapOf("number" to "  ")), "emails" to listOf(" ")), null))
    // 87 bytes on iOS, whose PRODID is "-//Apple Inc.//iPhone OS 26.5//EN".
    assertEquals(87 - "-//Apple Inc.//iPhone OS 26.5//EN".length + VCard.PRODID.length, empty.toByteArray().size)
  }

  @Test fun photoIsFoldedLikeIos() {
    val b64 = "A".repeat(48 + 74 * 195 + 20)
    val card = VCard.build(a, b64)
    val lines = card.split("\r\n")
    val at = lines.indexOfFirst { it.startsWith("PHOTO;ENCODING=b;TYPE=JPEG:") }
    assertEquals(lines.size - 2, at + 197) // PHOTO, 196 continuations (as in the iOS sample), END, ""
    assertEquals(75, lines[at].length)
    assertTrue(lines.subList(at + 1, at + 196).all { it.length == 75 && it.startsWith(" ") })
    assertEquals(21, lines[at + 196].length)
    assertEquals("END:VCARD", lines[at + 197])
  }

  @Test fun escapesStructuredText() {
    assertEquals("a\\;b\\,c\\\\d\\ne\\nf", VCard.esc("a;b,c\\d\r\ne\nf"))
  }
}

class TextDataTest {
  @Test fun mapsLinkifySpans() {
    assertEquals(TextData.Found("phone", 4, 20, "+1 415 555 0132"), TextData.fromUrl("tel:+14155550132", "+1 415 555 0132 ", 4, 20))
    assertEquals("anna.b+tag@example.com", TextData.fromUrl("mailto:anna.b%2Btag@example.com", "anna.b+tag@example.com", 0, 22)!!.value)
    assertEquals("http://www.example.org", TextData.fromUrl("http://www.example.org", "www.example.org", 0, 15)!!.value)
    assertEquals("url", TextData.fromUrl("https://acme.com/x", "https://acme.com/x", 0, 18)!!.type)
    assertEquals("http://www.acme.com/Path?Q=1", TextData.fromUrl("http://wwW.Acme.com/Path?Q=1", "wwW.Acme.com/Path?Q=1", 0, 21)!!.value)
    assertNull(TextData.fromUrl("geo:0,0?q=x", "x", 0, 1))
  }

  @Test fun addressesNeedANumberAndWords() {
    assertTrue(TextData.plausibleAddress("1600 Amphitheatre Parkway, Mountain View"))
    assertTrue(TextData.plausibleAddress("12 rue de Rivoli"))
    assertFalse(TextData.plausibleAddress("Mountain View"))
    assertFalse(TextData.plausibleAddress("94105"))
  }

  @Test fun tidyKeepsTheLongerOfOverlapsInOrder() {
    val text = "Call 1600 Main Street 94105 or mail a@b.co"
    val found = listOf(
      TextData.Found("phone", 5, 9, "1600"),
      TextData.Found("address", 5, 27, "1600 Main Street 94105"),
      TextData.Found("email", 36, 42, "a@b.co"),
      TextData.Found("url", 40, 99, "bad range"),
    )
    assertEquals(listOf("address", "email"), TextData.tidy(found, text).map { it.type })
  }
}

class BarcodesTest {
  @Test fun namesMatchIos() {
    assertEquals("qr", Barcodes.symbologyName(Barcode.FORMAT_QR_CODE))
    assertEquals("datamatrix", Barcodes.symbologyName(Barcode.FORMAT_DATA_MATRIX))
    assertEquals("upc_e", Barcodes.symbologyName(Barcode.FORMAT_UPC_E))
    assertEquals("ean13", Barcodes.symbologyName(Barcode.FORMAT_EAN_13))
    assertEquals("code128", Barcodes.symbologyName(Barcode.FORMAT_CODE_128))
    assertEquals("pdf417", Barcodes.symbologyName(Barcode.FORMAT_PDF417))
  }

  @Test fun topToBottomWithoutDuplicates() {
    val codes = listOf(
      Barcodes.Code("qr", "B", 0.1, 0.6, 0.2, 0.2),
      Barcodes.Code("qr", "A", 0.1, 0.1, 0.2, 0.2),
      Barcodes.Code("qr", "B", 0.5, 0.7, 0.2, 0.2),
      Barcodes.Code("ean13", "B", 0.9, 0.95, 0.3, 0.3),
    )
    val out = Barcodes.tidy(codes)
    assertEquals(listOf("A", "B", "B"), out.map { it.payload })
    assertEquals(listOf("qr", "qr", "ean13"), out.map { it.symbology })
    // Clamped into the image.
    assertEquals(0.1, out[2].width, 1e-9)
    assertEquals(0.05, out[2].height, 1e-9)
  }
}

class SpeechTextTest {
  @Test fun chunksCoverTheTextBySentence() {
    val text = "First sentence. Second one!  Third?\nA line\nlast words"
    val chunks = SpeechText.chunks(text)
    assertEquals(listOf("First sentence. ", "Second one!  ", "Third?\n", "A line\n", "last words"), chunks.map { text.substring(it.start, it.start + it.length) })
    var at = 0
    for (c in chunks) { assertEquals(at, c.start); at += c.length }
    assertEquals(text.length, at)
  }

  @Test fun longSentencesAreCutAtSpaces() {
    val text = (1..120).joinToString(" ") { "word$it" }
    val chunks = SpeechText.chunks(text, 100)
    assertTrue(chunks.all { it.length <= 100 })
    assertEquals(text, chunks.joinToString("") { text.substring(it.start, it.start + it.length) })
    assertTrue(chunks.dropLast(1).all { text[it.start + it.length - 1] == ' ' })
    // Decimal points and abbreviations without a following space don't end a sentence.
    assertEquals(1, SpeechText.chunks("Pay 3.50 euros").size)
  }

  @Test fun picksAnOfflineVoiceForTheLanguage() {
    val voices = listOf(
      SpeechText.VoiceOption("fr-ca-net", "fr-CA", 500, network = true, notInstalled = false),
      SpeechText.VoiceOption("fr-ca", "fr-CA", 400, network = false, notInstalled = false),
      SpeechText.VoiceOption("fr-fr", "fr-FR", 300, network = false, notInstalled = false),
      SpeechText.VoiceOption("fr-be-missing", "fr-BE", 500, network = false, notInstalled = true),
      SpeechText.VoiceOption("en-us", "en-US", 400, network = false, notInstalled = false),
    )
    assertEquals("fr-fr", SpeechText.bestVoice(voices, "fr", "US")!!.name) // home region
    assertEquals("fr-ca", SpeechText.bestVoice(voices, "fr", "CA")!!.name) // the user's region
    assertEquals("fr-ca", SpeechText.bestVoice(voices, "fr-CA", "FR")!!.name) // exact tag
    assertNull(SpeechText.bestVoice(voices, "de", "DE"))
    assertNull(SpeechText.bestVoice(voices.filter { it.name == "fr-be-missing" }, "fr-BE", "BE"))
  }
}

class SystemFormsTest {
  @Test fun contactRowsCarryEveryField() {
    val rows = SystemForms.contactRows(
      mapOf(
        "givenName" to "Sarah", "familyName" to " Mitchell ", "organizationName" to "Acme", "jobTitle" to "CEO",
        "phones" to listOf(mapOf("number" to "1", "label" to "mobile"), mapOf("number" to "2", "label" to "fax"), mapOf("number" to "3", "label" to "main"), mapOf("number" to "4"), mapOf("number" to " ")),
        "emails" to listOf("a@b.co", ""), "urls" to listOf("acme.com"),
        "addresses" to listOf(mapOf("street" to "1 Main St", "city" to "Town"), mapOf("state" to "CA")),
        "note" to "hello",
      ),
    )
    val byMime = rows.groupBy { it.mime }
    assertEquals(4, byMime["vnd.android.cursor.item/phone_v2"]!!.size)
    assertEquals(listOf(2, 4, 12, 3), byMime["vnd.android.cursor.item/phone_v2"]!!.map { it.values["data2"] }) // mobile, work fax, main, work
    assertEquals("Mitchell", byMime["vnd.android.cursor.item/name"]!!.single().values["data3"])
    assertEquals(1, byMime["vnd.android.cursor.item/email_v2"]!!.size)
    assertEquals(1, byMime["vnd.android.cursor.item/postal-address_v2"]!!.size) // a region alone isn't an address (as iOS)
    assertEquals("CEO", byMime["vnd.android.cursor.item/organization"]!!.single().values["data4"])
    assertEquals("hello", byMime["vnd.android.cursor.item/note"]!!.single().values["data1"])
  }

  @Test fun outcomes() {
    assertEquals("saved", SystemForms.contactOutcome(-1))
    assertEquals("cancelled", SystemForms.contactOutcome(0))
    assertEquals("saved", SystemForms.eventOutcome(-1))
    assertEquals("unknown", SystemForms.eventOutcome(0))
  }
}

class MergeNamesTest {
  @Test fun renamesLikeIos() {
    // Second part: "name", "agree", "a" clash with the first.
    val used = setOf("name", "agree", "a", "other")
    assertEquals(mapOf("name" to "name_2", "agree" to "agree_2", "a" to "a_2"), PdfMergeNames.renames(listOf("name", "agree", "a", "fresh"), used))
    // Third part with both "name" and "name_2", after the second's renames.
    val used3 = used + setOf("name_2", "agree_2", "a_2", "fresh")
    assertEquals(mapOf("name" to "name_3", "name_2" to "name_2_2"), PdfMergeNames.renames(listOf("name", "name_2"), used3))
    // A part's own names are never taken by a rename.
    assertEquals(mapOf("x" to "x_3"), PdfMergeNames.renames(listOf("x", "x_2"), setOf("x")))
    assertTrue(PdfMergeNames.renames(listOf("p", "q"), setOf("r")).isEmpty())
  }
}

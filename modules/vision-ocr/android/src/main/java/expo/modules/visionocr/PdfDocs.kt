package expo.modules.visionocr

import android.content.Context
import android.graphics.Bitmap
import android.system.Os
import com.tom_roush.pdfbox.cos.COSArray
import com.tom_roush.pdfbox.cos.COSBase
import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.cos.COSNull
import com.tom_roush.pdfbox.cos.COSObject
import com.tom_roush.pdfbox.cos.COSStream
import com.tom_roush.pdfbox.cos.COSString
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException
import com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy
import com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.destination.PDNamedDestination
import java.io.File
import java.io.IOException
import java.security.SecureRandom
import java.util.IdentityHashMap
import java.util.UUID

/** A PDF tool refused or failed; `message` is what JS matches ("locked", "restricted", "changed", …). */
class PdfFail(message: String) : Exception(message)

/**
 * What the PDF tools share (port phase 4): opening with or without a
 * password, keeping an owner-password PDF's protection when it is written
 * back, the read-back checks, and the structural clean-ups (/NeedAppearances,
 * references to removed pages).
 *
 * Protection, compared with iOS (PdfEditor.keepProtectionOptions): PDFKit
 * only reports permissions through getters that round some up ("document
 * changes" whenever forms, comments or assembly are allowed), so iOS clears
 * that derived bit before writing. PdfBox reads the file's /P itself, so here
 * the author's eight permission bits are written back exactly as they were
 * (revision 2 files, whose bits 9-12 are reserved, with what their coarse bits
 * allow spelled out), under a new random owner password, AES-256. Every
 * writer reads its result back and refuses it if a permission widened.
 */
object PdfDocs {
  const val LOCKED = "locked"
  const val RESTRICTED = "restricted"
  const val CHANGED = "changed"
  const val WRONG_PASSWORD = "wrong-password"
  val GOTO: COSName = COSName.getPDFName("GoTo")
  val LINK: COSName = COSName.getPDFName("Link")

  /** An opened document; `withPassword` when it needed `password` to open. */
  class Opened(val doc: PDDocument, val withPassword: Boolean)

  /**
   * Opens `file`, with `password` when it needs one. Throws [PdfFail]
   * "locked" when it needs a password that wasn't given or doesn't open it,
   * "Could not open the PDF" when it can't be read.
   */
  fun open(context: Context, file: File, password: String?): Opened {
    try {
      PdfEngine.loadBox(context, file, "")?.let { return Opened(it, false) }
      if (!password.isNullOrEmpty()) PdfEngine.loadBox(context, file, password)?.let { return Opened(it, true) }
    } catch (e: PdfFail) {
      throw e
    } catch (e: Throwable) {
      throw PdfFail("Could not open the PDF")
    }
    throw PdfFail(LOCKED)
  }

  /** Opens with "" only (Fill & sign, flatten): a PDF that needs a password is "locked". */
  fun openUnlocked(context: Context, file: File): PDDocument = open(context, file, null).doc

  /** (P, R) of an encrypted document, or null. */
  fun protection(doc: PDDocument): Pair<Int, Int>? {
    if (!doc.isEncrypted) return null
    val enc = doc.encryption ?: return null
    return enc.permissions to enc.revision
  }

  /** What the document's opener may do, as PDFAccessPermissions bits (all for an unencrypted one or the owner). */
  fun allowed(doc: PDDocument): Int {
    if (!doc.isEncrypted) return PdfPermissionBits.ALL
    if (doc.currentAccessPermission.isOwnerPermission) return PdfPermissionBits.ALL
    val (p, r) = protection(doc) ?: return PdfPermissionBits.ALL
    return PdfPermissionBits.fromP(p, r)
  }

  /** AccessPermission with exactly the meaningful /P bits of `p` (reserved bits as revision 6 wants them). */
  fun accessPermission(p: Int): AccessPermission = AccessPermission().apply {
    setCanPrint(PdfPermissionBits.isSet(p, 3))
    setCanModify(PdfPermissionBits.isSet(p, 4))
    setCanExtractContent(PdfPermissionBits.isSet(p, 5))
    setCanModifyAnnotations(PdfPermissionBits.isSet(p, 6))
    setCanFillInForm(PdfPermissionBits.isSet(p, 9))
    setCanExtractForAccessibility(PdfPermissionBits.isSet(p, 10))
    setCanAssembleDocument(PdfPermissionBits.isSet(p, 11))
    setCanPrintFaithful(PdfPermissionBits.isSet(p, 12))
  }

  private val random = SecureRandom()
  private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

  /** 64 random letters and digits: an owner password nobody knows (as iOS's two UUIDs). */
  fun randomOwnerPassword(): String =
    buildString { repeat(64) { append(ALPHABET[random.nextInt(ALPHABET.length)]) } }

  /** AES-256 (revision 6) with `owner`, `user` ("" = opens without one) and the /P bits `p`. */
  fun policy(owner: String, user: String, p: Int): StandardProtectionPolicy =
    StandardProtectionPolicy(owner, user, accessPermission(p)).apply { encryptionKeyLength = 256 }

  /**
   * Before writing a document edited in place: one opened with its password
   * is written without one (the app re-protects it in JS); an owner-password
   * one keeps its exact permissions under a new random owner password.
   * Returns the source (P, R) the result must not widen, or null.
   */
  fun keepProtection(opened: Opened): Pair<Int, Int>? {
    val doc = opened.doc
    if (!doc.isEncrypted) return null
    if (opened.withPassword) {
      doc.isAllSecurityToBeRemoved = true
      return null
    }
    val source = protection(doc) ?: return null
    doc.protect(policy(randomOwnerPassword(), "", PdfPermissionBits.effectiveP(source.first, source.second)))
    return source
  }

  /**
   * null when `written` (opened) is at least as protected as `source` (P, R):
   * still encrypted and no permission turned on. Else what widened.
   */
  fun widened(source: Pair<Int, Int>?, written: PDDocument): String? {
    source ?: return null
    val now = protection(written) ?: return "encryption removed"
    return PdfPermissionBits.widened(source.first, source.second, now.first, now.second)
  }

  /** A temp file next to `output` for writing before the read-back. */
  fun tempNextTo(output: File, tag: String): File {
    output.parentFile?.mkdirs()
    return File(output.parentFile, ".$tag-${UUID.randomUUID()}.pdf")
  }

  /** Puts the verified `tmp` at `output` in one rename. */
  fun accept(tmp: File, output: File) {
    output.delete()
    Os.rename(tmp.path, output.path)
  }

  /** Loads a written file to check it ("" or `password`); null when it doesn't open. */
  fun reload(context: Context, file: File, password: String = ""): PDDocument? = try {
    PdfEngine.loadBox(context, file, password)
  } catch (e: InvalidPasswordException) {
    null
  } catch (e: Throwable) {
    null
  }

  // ── /NeedAppearances (PdfStructure.settleNeedAppearances) ────────────────

  /** The catalog's /AcroForm dictionary, without PdfBox's form fix-ups. */
  fun acroFormDict(doc: PDDocument): COSDictionary? =
    doc.documentCatalog.cosObject.getDictionaryObject(COSName.ACRO_FORM) as? COSDictionary

  /** True when every visible widget has a normal appearance for its current state. */
  fun everyWidgetHasAppearance(doc: PDDocument): Boolean {
    for (page in doc.pages) {
      val annots = page.cosObject.getDictionaryObject(COSName.ANNOTS) as? COSArray ?: continue
      for (i in 0 until annots.size()) {
        val a = annots.getObject(i) as? COSDictionary ?: continue
        if (a.getCOSName(COSName.SUBTYPE) != COSName.WIDGET) continue
        if (a.getInt(COSName.F, 0) and 2 != 0) continue // hidden
        if (!hasNormalAppearance(a)) return false
      }
    }
    return true
  }

  /** The annotation has /AP /N for its state ("Off" may have none: nothing is drawn). */
  fun hasNormalAppearance(a: COSDictionary): Boolean {
    val ap = a.getDictionaryObject(COSName.AP) as? COSDictionary ?: return false
    val n = ap.getDictionaryObject(COSName.N) ?: return false
    if (n is COSStream) return true
    val states = n as? COSDictionary ?: return false
    val state = a.getCOSName(COSName.AS) ?: return false
    return state.name == "Off" || states.getDictionaryObject(state) is COSStream
  }

  /**
   * A form whose every widget has an appearance is written with
   * /NeedAppearances false, so readers that honour the flag (poppler, pdf.js,
   * Android viewers) draw the appearances as written instead of rebuilding
   * them (a chosen radio button blank, a choice showing its first option).
   * Returns true when it changed the flag.
   */
  fun settleNeedAppearances(doc: PDDocument): Boolean {
    val form = acroFormDict(doc) ?: return false
    if (!form.getBoolean(COSName.NEED_APPEARANCES, false)) return false
    if (!everyWidgetHasAppearance(doc)) return false
    form.setBoolean(COSName.NEED_APPEARANCES, false)
    return true
  }

  // ── Destinations ──────────────────────────────────────────────────────────

  /** The page dictionary a destination (array, name, string or { /D … }) goes to, or null. */
  fun destinationPage(doc: PDDocument, dest: COSBase?, depth: Int = 0): COSDictionary? {
    if (depth > 4) return null
    val d = if (dest is COSObject) dest.getObject() else dest
    return when (d) {
      is COSArray -> (if (d.size() > 0) d.getObject(0) else null) as? COSDictionary
      is COSDictionary -> destinationPage(doc, d.getDictionaryObject(COSName.D), depth + 1)
      is COSName, is COSString -> try {
        val named = if (d is COSName) PDNamedDestination(d) else PDNamedDestination(d as COSString)
        doc.documentCatalog.findNamedDestinationPage(named)?.page?.cosObject
      } catch (e: Throwable) {
        null
      }
      else -> null
    }
  }

  /** Where an annotation or outline item goes: its /Dest, or its GoTo action's /D. */
  fun linkTarget(doc: PDDocument, d: COSDictionary): COSDictionary? {
    d.getDictionaryObject(COSName.DEST)?.let { return destinationPage(doc, it) }
    val action = d.getDictionaryObject(COSName.A) as? COSDictionary ?: return null
    if (action.getCOSName(COSName.S) != GOTO) return null
    return destinationPage(doc, action.getDictionaryObject(COSName.D))
  }

  // ── Removing pages for good ──────────────────────────────────────────────

  /**
   * After pages left the page tree: nothing may still reach them, or their
   * content would be written into the file although they were deleted.
   * Bookmarks to them are removed (or, with sub-entries, lose their target),
   * links and named destinations to them are removed, their form fields'
   * widgets leave the form (and fields left with no widget), and any other
   * reference to them (structure tree, article beads, calculation order) is
   * replaced by null.
   */
  fun forgetPages(doc: PDDocument, deleted: List<COSDictionary>, kept: List<COSDictionary>) {
    if (deleted.isEmpty()) return
    val gone = IdentityHashMap<COSBase, Boolean>()
    for (p in deleted) gone[p] = true
    val keptAnnots = IdentityHashMap<COSBase, Boolean>()
    for (p in kept) {
      val annots = p.getDictionaryObject(COSName.ANNOTS) as? COSArray ?: continue
      for (i in 0 until annots.size()) annots.getObject(i)?.let { keptAnnots[it] = true }
    }
    // The deleted pages' own annotations (widgets with their values included).
    for (p in deleted) {
      val annots = p.getDictionaryObject(COSName.ANNOTS) as? COSArray ?: continue
      for (i in 0 until annots.size()) {
        val a = annots.getObject(i) ?: continue
        if (keptAnnots[a] == null) gone[a] = true
      }
    }
    fun isGone(page: COSDictionary?) = page != null && gone[page] != null

    // Bookmarks.
    (doc.documentCatalog.cosObject.getDictionaryObject(COSName.OUTLINES) as? COSDictionary)?.let { root ->
      pruneOutline(doc, root, ::isGone)
      recount(root, isRoot = true, depth = 0)
    }
    // Links on the pages that stay.
    for (p in kept) {
      val annots = p.getDictionaryObject(COSName.ANNOTS) as? COSArray ?: continue
      var i = annots.size() - 1
      while (i >= 0) {
        val a = annots.getObject(i) as? COSDictionary
        if (a != null && a.getCOSName(COSName.SUBTYPE) == LINK && isGone(linkTarget(doc, a))) {
          annots.remove(i)
          gone[a] = true
        }
        i--
      }
    }
    // Named destinations.
    val catalog = doc.documentCatalog.cosObject
    (catalog.getDictionaryObject(COSName.DESTS) as? COSDictionary)?.let { dests ->
      for (key in dests.keySet().toList()) {
        if (isGone(destinationPage(doc, dests.getDictionaryObject(key)))) dests.removeItem(key)
      }
    }
    ((catalog.getDictionaryObject(COSName.NAMES) as? COSDictionary)?.getDictionaryObject(COSName.DESTS) as? COSDictionary)
      ?.let { pruneNameTree(doc, it, ::isGone, 0) }
    // Form fields.
    acroFormDict(doc)?.let { form ->
      (form.getDictionaryObject(COSName.FIELDS) as? COSArray)?.let { pruneFields(it, gone, 0) }
      (form.getDictionaryObject(COSName.CO) as? COSArray)?.let { co ->
        var i = co.size() - 1
        while (i >= 0) {
          val f = co.getObject(i)
          if (f == null || gone[f] != null) co.remove(i)
          i--
        }
      }
    }
    // Anything else that still points at them.
    scrub(doc.document.trailer, gone)
  }

  private fun pruneOutline(doc: PDDocument, node: COSDictionary, isGone: (COSDictionary?) -> Boolean) {
    var budget = 20000
    fun walk(parent: COSDictionary, depth: Int) {
      if (depth > 64) return
      var item = parent.getDictionaryObject(COSName.FIRST) as? COSDictionary
      val seen = IdentityHashMap<COSDictionary, Boolean>()
      while (item != null && budget-- > 0 && seen.put(item, true) == null) {
        val next = item.getDictionaryObject(COSName.NEXT) as? COSDictionary
        walk(item, depth + 1)
        if (isGone(linkTarget(doc, item))) {
          if (item.getDictionaryObject(COSName.FIRST) is COSDictionary) {
            item.removeItem(COSName.DEST)
            item.removeItem(COSName.A)
          } else {
            unlink(parent, item)
          }
        }
        item = next
      }
    }
    walk(node, 0)
  }

  private fun unlink(parent: COSDictionary, item: COSDictionary) {
    val prev = item.getDictionaryObject(COSName.PREV) as? COSDictionary
    val next = item.getDictionaryObject(COSName.NEXT) as? COSDictionary
    if (prev != null) {
      if (next != null) prev.setItem(COSName.NEXT, next) else prev.removeItem(COSName.NEXT)
    } else {
      if (next != null) parent.setItem(COSName.FIRST, next) else parent.removeItem(COSName.FIRST)
    }
    if (next != null) {
      if (prev != null) next.setItem(COSName.PREV, prev) else next.removeItem(COSName.PREV)
    } else {
      if (prev != null) parent.setItem(COSName.LAST, prev) else parent.removeItem(COSName.LAST)
    }
    item.removeItem(COSName.PREV)
    item.removeItem(COSName.NEXT)
  }

  /** /Count again after removals: visible descendants, negative for a closed item. */
  private fun recount(node: COSDictionary, isRoot: Boolean, depth: Int): Int {
    if (depth > 64) return 0
    var total = 0
    var child = node.getDictionaryObject(COSName.FIRST) as? COSDictionary
    val seen = IdentityHashMap<COSDictionary, Boolean>()
    while (child != null && seen.put(child, true) == null) {
      val sub = recount(child, isRoot = false, depth = depth + 1)
      total += 1 + if (child.getInt(COSName.COUNT, 0) > 0) sub else 0
      child = child.getDictionaryObject(COSName.NEXT) as? COSDictionary
    }
    if (total == 0) {
      node.removeItem(COSName.COUNT)
      if (isRoot) node.setInt(COSName.COUNT, 0)
      return 0
    }
    val closed = !isRoot && node.getInt(COSName.COUNT, 0) < 0
    node.setInt(COSName.COUNT, if (closed) -total else total)
    return total
  }

  private fun pruneNameTree(doc: PDDocument, node: COSDictionary, isGone: (COSDictionary?) -> Boolean, depth: Int) {
    if (depth > 32) return
    (node.getDictionaryObject(COSName.NAMES) as? COSArray)?.let { names ->
      var i = names.size() - 2
      while (i >= 0) {
        if (isGone(destinationPage(doc, names.get(i + 1)))) {
          names.remove(i + 1)
          names.remove(i)
        }
        i -= 2
      }
    }
    (node.getDictionaryObject(COSName.KIDS) as? COSArray)?.let { kids ->
      for (k in 0 until kids.size()) (kids.getObject(k) as? COSDictionary)?.let { pruneNameTree(doc, it, isGone, depth + 1) }
    }
  }

  /** Removes `gone` widgets from a field list, then fields left with no kids; adds what it removed to `gone`. */
  private fun pruneFields(list: COSArray, gone: IdentityHashMap<COSBase, Boolean>, depth: Int) {
    if (depth > 32) return
    var i = list.size() - 1
    while (i >= 0) {
      val d = list.getObject(i) as? COSDictionary
      if (d != null) {
        if (gone[d] != null) {
          list.remove(i)
        } else {
          val kids = d.getDictionaryObject(COSName.KIDS) as? COSArray
          if (kids != null && kids.size() > 0) {
            pruneFields(kids, gone, depth + 1)
            if (kids.size() == 0) {
              list.remove(i)
              gone[d] = true
            }
          }
        }
      }
      i--
    }
  }

  /** Replaces every reference to a `gone` object reachable from `root` by null. */
  private fun scrub(root: COSBase, gone: IdentityHashMap<COSBase, Boolean>) {
    val seen = IdentityHashMap<COSBase, Boolean>()
    val stack = ArrayDeque<COSBase>()
    stack.addLast(root)
    while (stack.isNotEmpty()) {
      val obj = stack.removeLast()
      if (seen.put(obj, true) != null) continue
      when (obj) {
        is COSDictionary -> for (key in obj.keySet().toList()) {
          val raw = obj.getItem(key)
          val target = if (raw is COSObject) raw.getObject() else raw
          if (target != null && gone[target] != null) obj.setItem(key, COSNull.NULL)
          else if (target is COSDictionary || target is COSArray) stack.addLast(target)
        }
        is COSArray -> for (i in 0 until obj.size()) {
          val raw = obj.get(i)
          val target = if (raw is COSObject) raw.getObject() else raw
          if (target != null && gone[target] != null) obj.set(i, COSNull.NULL)
          else if (target is COSDictionary || target is COSArray) stack.addLast(target)
        }
      }
    }
  }

  // ── Read-back helpers (PDFium: an independent reader) ────────────────────

  private fun norm(s: String): String = s.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")

  /** Every page's text, whitespace collapsed (PDFium). */
  fun texts(context: Context, file: File, password: String?): List<String> {
    val doc = PdfEngine.openPdfium(context, file, password)
    doc.use {
      return (0 until doc.getPageCount()).map { i ->
        doc.openPage(i).use { page ->
          page.openTextPage().use { tp ->
            val n = tp.textPageCountChars()
            if (n <= 0) "" else norm(tp.textPageGetText(0, n) ?: "")
          }
        }
      }
    }
  }

  /** A page's text as the sorted characters it has, whitespace left out (order-free comparison). */
  fun characters(text: String): String =
    text.filter { !it.isWhitespace() }.toCharArray().apply { sort() }.concatToString()

  const val LOOK_SIDE = 48

  /** Pages drawn small in grey (up to 24 spread over the document): a rewrite that broke an image or font shows. */
  fun looks(context: Context, file: File, password: String?, annotations: Boolean = true): List<IntArray> {
    val doc = PdfEngine.openPdfium(context, file, password)
    doc.use {
      val n = doc.getPageCount()
      if (n <= 0) return emptyList()
      val picks = if (n <= 24) (0 until n).toList() else (0 until 24).map { it * (n - 1) / 23 }
      val sizes = PdfEngine.pageSizes(doc)
      val bmp = Bitmap.createBitmap(LOOK_SIDE, LOOK_SIDE, Bitmap.Config.ARGB_8888)
      try {
        return picks.map { i -> look(doc, i, sizes[2 * i], sizes[2 * i + 1], bmp, annotations) }
      } finally {
        bmp.recycle()
      }
    }
  }

  private fun look(doc: io.legere.pdfiumandroid.PdfDocument, i: Int, w: Float, h: Float, bmp: Bitmap, annotations: Boolean): IntArray {
    val scale = LOOK_SIDE / maxOf(w, h, 1f)
    val sw = maxOf(1, (w * scale).toInt())
    val sh = maxOf(1, (h * scale).toInt())
    bmp.eraseColor(android.graphics.Color.WHITE)
    doc.openPage(i).use { page ->
      page.renderPageBitmap(bmp, (LOOK_SIDE - sw) / 2, (LOOK_SIDE - sh) / 2, sw, sh, annotations, false,
        android.graphics.Color.WHITE, android.graphics.Color.WHITE)
    }
    val px = IntArray(LOOK_SIDE * LOOK_SIDE)
    bmp.getPixels(px, 0, LOOK_SIDE, 0, 0, LOOK_SIDE, LOOK_SIDE)
    for (k in px.indices) {
      val c = px[k]
      px[k] = (((c shr 16) and 0xff) * 30 + ((c shr 8) and 0xff) * 59 + (c and 0xff) * 11) / 100
    }
    return px
  }

  /** Always deletes `tmp` when `block` throws. */
  inline fun <T> cleaningUp(tmp: File, block: () -> T): T = try {
    block()
  } catch (e: Throwable) {
    tmp.delete()
    throw e
  }

  /** IOException-safe close. */
  fun closeQuietly(doc: PDDocument?) {
    try { doc?.close() } catch (e: IOException) {}
  }
}

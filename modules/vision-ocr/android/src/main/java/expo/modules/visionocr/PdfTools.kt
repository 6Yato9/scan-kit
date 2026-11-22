package expo.modules.visionocr

import android.content.Context
import android.util.Log
import com.tom_roush.pdfbox.cos.COSArray
import com.tom_roush.pdfbox.cos.COSBase
import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.multipdf.PDFMergerUtility
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.PDResources
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission
import java.io.File

/**
 * The PDF tools that change a PDF's pages or protection (port phase 4), the
 * counterparts of PdfEditor.swift, PdfMerger.swift, PdfProtector.swift and
 * PdfUnrestrict.swift, with the same arguments, results and messages.
 *
 * Everything is written to a temp file next to the output, read back (with
 * PdfBox, and PDFium where text and looks are compared) and only then renamed
 * into place: a caller never gets a half-written or unverified file.
 */
object PdfTools {
  private const val TAG = "PdfTools"
  private const val UNVERIFIED_EDIT = "The edited PDF could not be verified"

  // ── pdfEditPages (PdfEditor.compose) ─────────────────────────────────────

  /** The inheritable page attributes (ISO 32000 §7.7.3.4) a page takes from its tree. */
  private val INHERITABLE = listOf(COSName.RESOURCES, COSName.MEDIA_BOX, COSName.CROP_BOX, COSName.ROTATE)

  private fun inherited(page: COSDictionary, key: COSName): COSBase? {
    var node: COSDictionary? = page.getDictionaryObject(COSName.PARENT) as? COSDictionary
    var depth = 0
    while (node != null && depth < 64) {
      node.getDictionaryObject(key)?.let { return it }
      node = node.getDictionaryObject(COSName.PARENT) as? COSDictionary
      depth++
    }
    return null
  }

  /** Copies what a page inherits from its page-tree nodes onto the page, so it can move anywhere. */
  private fun materialize(page: PDPage) {
    val d = page.cosObject
    for (key in INHERITABLE) {
      if (d.getDictionaryObject(key) == null) inherited(d, key)?.let { d.setItem(key, it) }
    }
    if (d.getDictionaryObject(COSName.MEDIA_BOX) == null) page.mediaBox = PDRectangle.LETTER
  }

  private fun copyRect(r: PDRectangle) = PDRectangle(r.lowerLeftX, r.lowerLeftY, r.width, r.height)

  /** A blank page with `like`'s media box, crop box and rotation (PdfEditor.blankPage). */
  private fun blankPage(like: PDPage): PDPage {
    val page = PDPage(copyRect(like.mediaBox))
    if (like.cosObject.getDictionaryObject(COSName.CROP_BOX) != null) page.cropBox = copyRect(like.cropBox)
    page.rotation = PdfPlan.normalized(like.rotation)
    page.resources = PDResources()
    return page
  }

  /**
   * Writes a PDF whose pages are, in order, input pages `sources[i]` turned
   * by `rotations[i]`, or blank pages for -(k + 1); pages are moved, never
   * redrawn. The document is edited in place, so its form, bookmarks, page
   * labels, named destinations and metadata stay; a page removed is removed
   * for good (bookmarks, links, form fields and other references to it go
   * too, see PdfDocs.forgetPages). Returns the page count.
   */
  fun editPages(context: Context, input: File, output: File, sources: List<Int>, rotations: List<Int>, password: String?): Int {
    val opened = PdfDocs.open(context, input, password)
    val doc = opened.doc
    val tmp = PdfDocs.tempNextTo(output, "edit")
    try {
      // Owner-password PDFs whose permissions don't allow assembling pages are refused, as on iOS.
      if (doc.isEncrypted && !opened.withPassword && PdfDocs.allowed(doc) and PdfPermissionBits.ASSEMBLE == 0) {
        throw PdfFail(PdfDocs.RESTRICTED)
      }
      val count = doc.numberOfPages
      PdfPlan.check(sources, rotations, count)?.let { throw PdfFail(it) }
      val originals = doc.pages.toList()
      if (originals.size != count) throw PdfFail("Could not read the pages")
      for (p in originals) materialize(p)
      val targets = sources.map { s -> if (s >= 0) originals[s] else blankPage(originals[-s - 1]) }
      val expected = targets.mapIndexed { i, page ->
        val r = PdfPlan.normalized(page.rotation + rotations[i])
        page.rotation = r
        r
      }
      val used = sources.filter { it >= 0 }.toHashSet()
      val deleted = originals.indices.filter { it !in used }.map { originals[it].cosObject }

      // A flat page tree in the new order.
      val root = doc.documentCatalog.cosObject.getDictionaryObject(COSName.PAGES) as? COSDictionary
        ?: throw PdfFail("Could not read the pages")
      val kids = COSArray()
      for (t in targets) {
        t.cosObject.setItem(COSName.PARENT, root)
        kids.add(t.cosObject)
      }
      root.setItem(COSName.KIDS, kids)
      root.setInt(COSName.COUNT, targets.size)
      PdfDocs.forgetPages(doc, deleted, targets.map { it.cosObject })
      PdfDocs.settleNeedAppearances(doc)
      PdfDocs.keepProtection(opened)
      doc.save(tmp)
    } catch (e: PdfFail) {
      tmp.delete()
      throw e
    } catch (e: Throwable) {
      tmp.delete()
      Log.w(TAG, "edit failed", e)
      throw PdfFail("Could not write the PDF")
    } finally {
      PdfDocs.closeQuietly(doc)
    }
    return PdfDocs.cleaningUp(tmp) {
      verifyEdit(context, input, password, tmp, sources, rotations, opened.withPassword)
      PdfDocs.accept(tmp, output)
      sources.size
    }
  }

  /** Read back an edit: the planned pages, in order, with their turns and their text; never looser. */
  private fun verifyEdit(
    context: Context, input: File, password: String?, written: File,
    sources: List<Int>, rotations: List<Int>, wasUnlocked: Boolean,
  ) {
    fun refuse(why: String): Nothing {
      Log.w(TAG, "edit refused: $why")
      throw PdfFail(UNVERIFIED_EDIT)
    }
    val source = PdfDocs.open(context, input, password)
    val sourceProtection = if (source.withPassword) null else PdfDocs.protection(source.doc)
    val sourceRotations = try {
      source.doc.pages.map { PdfPlan.normalized(it.rotation) }
    } finally {
      PdfDocs.closeQuietly(source.doc)
    }
    val check = PdfDocs.reload(context, written) ?: refuse("unreadable")
    check.use {
      if (check.numberOfPages != sources.size) refuse("page count")
      if (wasUnlocked && check.isEncrypted) refuse("still encrypted")
      PdfDocs.widened(sourceProtection, check)?.let { refuse("permissions: $it") }
      check.pages.forEachIndexed { k, page ->
        val s = sources[k]
        val base = sourceRotations[if (s >= 0) s else -s - 1]
        if (PdfPlan.normalized(page.rotation) != PdfPlan.normalized(base + rotations[k])) refuse("rotation of page ${k + 1}")
      }
    }
    // The text of every page is where the plan put it (PDFium, independent of
    // PdfBox). Compared as the characters it has: a turned page's text comes
    // out in another order.
    val before = PdfDocs.texts(context, input, password).map(PdfDocs::characters)
    val after = PdfDocs.texts(context, written, null).map(PdfDocs::characters)
    if (after.size != sources.size) refuse("pdfium pages")
    for (k in sources.indices) {
      val s = sources[k]
      val want = if (s >= 0) before[s] else ""
      if (after[k] != want) refuse("text of page ${k + 1}")
    }
  }

  // ── mergePdfs (PdfMerger.merge) ──────────────────────────────────────────

  /**
   * Concatenates PDFs in order; pages keep their size, text, links and form
   * fields. Fields are never linked across parts (the same rule as iOS's
   * PdfMerger): a later part's top-level field whose name is already taken is
   * renamed to the first free "<name>_2", "<name>_3"… (PdfMergeNames), so
   * PDFMergerUtility finds no clash to join or to call "dummyFieldNameN".
   * A part whose permissions don't
   * allow assembly is refused ("restricted"); parts with an owner password
   * pass their restrictions on: the result allows only what every one of them
   * allows. Verified before it is put at `output`.
   */
  fun merge(context: Context, inputs: List<File>, output: File) {
    if (inputs.isEmpty()) throw PdfFail("Nothing to merge")
    val parts = ArrayList<PDDocument>()
    val tmp = PdfDocs.tempNextTo(output, "merge")
    val protections = ArrayList<Pair<Int, Int>>()
    var pages = 0
    var shared: Int? = null
    val usedNames = HashSet<String>()
    try {
      val dest = PDDocument(PdfEngine.memory(context))
      parts.add(dest)
      val merger = PDFMergerUtility()
      for (file in inputs) {
        val part = try {
          PdfEngine.loadBox(context, file, "")
        } catch (e: Throwable) {
          null
        } ?: throw PdfFail("Could not open a part of the PDF")
        parts.add(part)
        if (part.isEncrypted) {
          if (PdfDocs.allowed(part) and PdfPermissionBits.ASSEMBLE == 0) throw PdfFail(PdfDocs.RESTRICTED)
          PdfDocs.protection(part)?.let { (p, r) ->
            protections.add(p to r)
            val eff = PdfPermissionBits.effectiveP(p, r)
            shared = (shared ?: eff) and eff
          }
        }
        pages += part.numberOfPages
        PdfMergeNames.renameClashing(part, usedNames)
        merger.appendDocument(dest, part)
      }
      shared?.let { dest.protect(PdfDocs.policy(PdfDocs.randomOwnerPassword(), "", it)) }
      PdfDocs.settleNeedAppearances(dest)
      dest.save(tmp)
    } catch (e: PdfFail) {
      tmp.delete()
      throw e
    } catch (e: Throwable) {
      tmp.delete()
      Log.w(TAG, "merge failed", e)
      throw PdfFail("Could not write the PDF")
    } finally {
      parts.forEach { PdfDocs.closeQuietly(it) }
    }
    PdfDocs.cleaningUp(tmp) {
      val check = PdfDocs.reload(context, tmp) ?: throw PdfFail("The merged PDF could not be verified")
      check.use {
        val widened = protections.firstNotNullOfOrNull { PdfDocs.widened(it, check) }
        if (check.numberOfPages != pages || widened != null || (shared != null) != check.isEncrypted) {
          Log.w(TAG, "merge refused: pages ${check.numberOfPages}/$pages, ${widened ?: "encryption"}")
          throw PdfFail("The merged PDF could not be verified")
        }
      }
      PdfDocs.accept(tmp, output)
    }
  }

  // ── protectPdf / protectPdfKeeping (PdfProtector) ────────────────────────

  /**
   * A password-protected copy: `password` opens it and, for a PDF that had no
   * protection, is also the owner password (as on iOS). A PDF that already
   * had an owner password with restrictions keeps them exactly, under a new
   * random owner password: protecting it never loosens it. Verified: locked,
   * opens with the password, same pages, nothing widened.
   */
  fun protect(context: Context, input: File, output: File, password: String) {
    if (password.isEmpty()) throw PdfFail("Password is empty")
    val doc = PdfEngine.loadBox(context, input, "") ?: throw PdfFail("Could not open the PDF")
    val tmp = PdfDocs.tempNextTo(output, "protect")
    val pages: Int
    val source: Pair<Int, Int>?
    try {
      pages = doc.numberOfPages
      source = PdfDocs.protection(doc)
      val policy = if (source == null) {
        PdfDocs.policy(password, password, AccessPermission().permissionBytes)
      } else {
        PdfDocs.policy(PdfDocs.randomOwnerPassword(), password, PdfPermissionBits.effectiveP(source.first, source.second))
      }
      doc.protect(policy)
      doc.save(tmp)
    } catch (e: Throwable) {
      tmp.delete()
      Log.w(TAG, "protect failed", e)
      throw PdfFail("Could not write the protected PDF")
    } finally {
      PdfDocs.closeQuietly(doc)
    }
    PdfDocs.cleaningUp(tmp) {
      verifyProtected(context, tmp, password, pages, source?.let { PdfPermissionBits.fromP(it.first, it.second) }, expectOwner = source == null)
      PdfDocs.accept(tmp, output)
    }
  }

  /**
   * Encrypts a plain PDF keeping a protection as it was (round 14): open
   * password `userPassword`, owner password `ownerPassword` (random when
   * null), `permissions` as PDFAccessPermissions bits. Verified: locked,
   * opens with the password, same pages; with a random owner, opened as a
   * user with exactly those permissions (none widened).
   */
  fun protectKeeping(context: Context, input: File, output: File, userPassword: String, ownerPassword: String?, permissions: Int) {
    if (userPassword.isEmpty()) throw PdfFail("Password is empty")
    val doc = PdfEngine.loadBox(context, input, "") ?: throw PdfFail("Could not open the PDF")
    val tmp = PdfDocs.tempNextTo(output, "keep")
    val pages: Int
    val bits = permissions and PdfPermissionBits.ALL
    val randomOwner = ownerPassword.isNullOrEmpty()
    try {
      pages = doc.numberOfPages
      val owner = if (randomOwner) PdfDocs.randomOwnerPassword() else ownerPassword!!
      if (doc.isEncrypted) doc.isAllSecurityToBeRemoved = false
      doc.protect(PdfDocs.policy(owner, userPassword, PdfPermissionBits.toP(bits)))
      doc.save(tmp)
    } catch (e: Throwable) {
      tmp.delete()
      Log.w(TAG, "protectKeeping failed", e)
      throw PdfFail("Could not write the protected PDF")
    } finally {
      PdfDocs.closeQuietly(doc)
    }
    PdfDocs.cleaningUp(tmp) {
      verifyProtected(context, tmp, userPassword, pages, if (randomOwner) bits else null, expectOwner = !randomOwner && ownerPassword == userPassword)
      PdfDocs.accept(tmp, output)
    }
  }

  /**
   * Locked without a password, opens with `password`, `pages` pages. With
   * `bits`, opened with `password` it is a user (not the owner) whose
   * permissions are exactly `bits`: none widened, none lost.
   */
  private fun verifyProtected(context: Context, file: File, password: String, pages: Int, bits: Int?, expectOwner: Boolean) {
    fun refuse(why: String): Nothing {
      Log.w(TAG, "protection refused: $why")
      throw PdfFail("Protection could not be verified")
    }
    if (PdfDocs.reload(context, file, "")?.also { it.close() } != null) refuse("opens without a password")
    val check = PdfDocs.reload(context, file, password) ?: refuse("doesn't open with the password")
    check.use {
      if (!check.isEncrypted || check.numberOfPages != pages) refuse("pages")
      val owner = check.currentAccessPermission.isOwnerPermission
      if (bits != null) {
        if (owner) refuse("the open password is the owner password")
        val (p, r) = PdfDocs.protection(check) ?: refuse("no permissions")
        val now = PdfPermissionBits.fromP(p, r)
        if (now != bits) refuse("permissions $bits -> $now")
      }
      if (expectOwner && !owner) refuse("not the owner")
    }
  }

  // ── unrestrictPdf (PdfUnrestrict.unrestrict) ─────────────────────────────

  /**
   * An unencrypted copy with every restriction removed: every object written
   * again without encryption, pages never redrawn (what `qpdf --decrypt`
   * does), the catalog's /Perms (DocMDP / usage rights, which restrict too and
   * can't stay valid) left out. Verified against the original before it is
   * accepted: unencrypted, same pages, same text on every page, same
   * annotations per page, same form fields and bookmarks, same look.
   */
  fun unrestrict(context: Context, input: File, output: File, password: String?): Map<String, Any> {
    var usedPassword: String? = null
    val doc = try {
      PdfEngine.loadBox(context, input, "") ?: run {
        if (password.isNullOrEmpty()) throw PdfFail(PdfDocs.LOCKED)
        usedPassword = password
        PdfEngine.loadBox(context, input, password) ?: throw PdfFail(PdfDocs.WRONG_PASSWORD)
      }
    } catch (e: PdfFail) {
      throw e
    } catch (e: Throwable) {
      throw PdfFail("Could not open the PDF")
    }
    val tmp = PdfDocs.tempNextTo(output, "unrestrict")
    val pageCount: Int
    val annotations: List<Int>
    val fields: Int
    val bookmarks: Int
    try {
      pageCount = doc.numberOfPages
      if (pageCount <= 0) throw PdfFail("The PDF has no pages")
      annotations = doc.pages.map { it.cosObject.annotationCount() }
      fields = fieldCount(doc)
      bookmarks = bookmarkCount(doc)
      doc.documentCatalog.cosObject.removeItem(COSName.PERMS)
      doc.isAllSecurityToBeRemoved = true
      doc.save(tmp)
    } catch (e: PdfFail) {
      tmp.delete()
      throw e
    } catch (e: Throwable) {
      tmp.delete()
      Log.w(TAG, "unrestrict failed", e)
      throw PdfFail("Could not write an unrestricted copy")
    } finally {
      PdfDocs.closeQuietly(doc)
    }
    return PdfDocs.cleaningUp(tmp) {
      fun refuse(why: String): Nothing {
        Log.w(TAG, "unrestrict refused: $why")
        throw PdfFail("Could not write an unrestricted copy")
      }
      val check = PdfDocs.reload(context, tmp) ?: refuse("unreadable")
      check.use {
        if (check.isEncrypted) refuse("still encrypted")
        if (check.numberOfPages != pageCount) refuse("pages")
        if (check.pages.map { it.cosObject.annotationCount() } != annotations) refuse("annotations")
        if (fieldCount(check) != fields) refuse("fields")
        if (bookmarkCount(check) != bookmarks) refuse("bookmarks")
      }
      val before = PdfDocs.texts(context, input, usedPassword)
      val after = PdfDocs.texts(context, tmp, null)
      if (before.size != after.size) refuse("pdfium pages")
      for (i in before.indices) if (before[i].isNotEmpty() && before[i] != after[i]) refuse("text of page ${i + 1}")
      val looksBefore = PdfDocs.looks(context, input, usedPassword)
      val looksAfter = PdfDocs.looks(context, tmp, null)
      if (looksBefore.size != looksAfter.size) refuse("looks")
      for (i in looksBefore.indices) {
        // Mean difference per pixel: anti-aliasing noise is well under 2.
        if (PdfPlan.meanDifference(looksBefore[i], looksAfter[i]) > 4.0) refuse("look of page ${i + 1}")
      }
      PdfDocs.accept(tmp, output)
      mapOf("pageCount" to pageCount, "encrypted" to false, "method" to "rewrite")
    }
  }

  private fun COSDictionary.annotationCount(): Int = (getDictionaryObject(COSName.ANNOTS) as? COSArray)?.size() ?: 0

  /** Top-level /AcroForm /Fields (-1: no AcroForm), as PdfUnrestrict's fingerprint. */
  private fun fieldCount(doc: PDDocument): Int {
    val form = PdfDocs.acroFormDict(doc) ?: return -1
    return (form.getDictionaryObject(COSName.FIELDS) as? COSArray)?.size() ?: 0
  }

  private fun bookmarkCount(doc: PDDocument): Int {
    val root = doc.documentCatalog.cosObject.getDictionaryObject(COSName.OUTLINES) as? COSDictionary ?: return 0
    var n = 0
    var budget = 100000
    fun walk(node: COSDictionary, depth: Int) {
      if (depth > 64) return
      var item = node.getDictionaryObject(COSName.FIRST) as? COSDictionary
      val seen = java.util.IdentityHashMap<COSDictionary, Boolean>()
      while (item != null && budget-- > 0 && seen.put(item, true) == null) {
        n++
        walk(item, depth + 1)
        item = item.getDictionaryObject(COSName.NEXT) as? COSDictionary
      }
    }
    walk(root, 0)
    return n
  }
}

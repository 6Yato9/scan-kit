package expo.modules.visionocr

import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDNonTerminalField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTerminalField

/**
 * Merging forms without linking their fields (PdfMerger.swift does the
 * same). Two parts that both have a field "name" would otherwise become one
 * field (filling one fills the other) or, with PdfBox's legacy merge, a field
 * called "dummyFieldName3". A later part's clashing TOP-LEVEL field is
 * renamed to the first free "<name>_2", "<name>_3"…, free of every top-level
 * name already in the result, of the part's own names and of names already
 * given; the part's fields are taken in page and annotation order of their
 * first widget (as iOS walks them). Children keep their names under the
 * renamed parent ("a.b" → "a_2.b"); one field's widgets stay one field.
 */
object PdfMergeNames {
  /** New names for `names` (one part's top-level names, in order) that clash with `used`. */
  fun renames(names: List<String>, used: Set<String>): Map<String, String> {
    val taken = HashSet(used).apply { addAll(names) }
    val out = LinkedHashMap<String, String>()
    for (name in names) {
      if (name !in used || name in out) continue
      var k = 2
      while ("${name}_$k" in taken) k++
      val to = "${name}_$k"
      out[name] = to
      taken.add(to)
    }
    return out
  }

  /** Renames `part`'s clashing top-level fields in place and adds its top-level names to `used`. */
  fun renameClashing(part: PDDocument, used: MutableSet<String>) {
    val form = part.documentCatalog?.acroForm ?: return
    val tops = form.fields.filter { !it.partialName.isNullOrEmpty() }
    if (tops.isEmpty()) return
    // Where each top-level field first shows: (page, annotation index).
    val position = HashMap<com.tom_roush.pdfbox.cos.COSBase, Pair<Int, Int>>()
    part.pages.forEachIndexed { p, page ->
      val annots = try { page.annotations } catch (_: Exception) { emptyList() }
      annots.forEachIndexed { a, annot -> position.putIfAbsent(annot.cosObject, p to a) }
    }
    fun first(field: PDField): Pair<Int, Int> {
      var best = Int.MAX_VALUE to Int.MAX_VALUE
      fun visit(f: PDField) {
        when (f) {
          is PDTerminalField -> f.widgets.forEach { w ->
            val at = position[w.cosObject] ?: return@forEach
            if (at.first < best.first || (at.first == best.first && at.second < best.second)) best = at
          }
          is PDNonTerminalField -> f.children.forEach { visit(it) }
        }
      }
      visit(field)
      return best
    }
    val ordered = tops.withIndex()
      .sortedWith(compareBy({ first(it.value).first }, { first(it.value).second }, { it.index }))
      .map { it.value }
    val names = ordered.map { it.partialName }.distinct()
    val renames = renames(names, used)
    for (f in ordered) renames[f.partialName]?.let { f.partialName = it }
    names.forEach { used.add(renames[it] ?: it) }
  }
}

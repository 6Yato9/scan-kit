// lib/pdf-fill.ts
//
// Fill & sign an imported PDF in place (app/pdf-fill.tsx): fill in its form
// (AcroForm text fields, checkboxes, radio buttons, choices) and add text, a
// date, check marks, crosses, a signature and initials — without "Convert to
// pages". The page itself is never redrawn: its text stays text, selectable
// and searchable, and the rest of the PDF (other pages, links, notes, the form)
// is kept. Additions are PDF annotations with a drawn appearance, so Preview,
// Files, Mail and Acrobat show them (modules/vision-ocr/ios/PdfFiller.swift
// explains the choice and how the written file is verified).
//
// The screen works in DISPLAY space: the page as the user sees it — its crop
// box, turned by its /Rotate — with rects as fractions (0..1) of that upright
// page, origin top-left. Native wants PDF space: points in the page's own
// coordinate system (origin bottom-left, before the rotation). The two
// conversions below are pure and unit-tested; everything else goes through
// lib/pdf-edit.ts rewriteStoredPdf, the same crash-safe, journaled atomic swap
// with Undo as every other PDF edit.
import { Directory, File, Paths } from 'expo-file-system';
import type { Href } from 'expo-router';
import {
  VisionOcr,
  type NativeFieldValue,
  type NativeFillField,
  type NativeFillInfo,
  type NativeFillPage,
  type NativeMark,
  type NativePdfInfo,
} from '../modules/vision-ocr/src';
import { PdfEditError, rewriteStoredPdf, undoPdfEdit, type FilePrint, type PdfEditResult, type PdfEditUndo, filePrint, samePrint } from './pdf-edit';
import { SIGNATURE_INK, type Signature, type SignatureInk } from './stamp';

// ── Geometry (pure) ──────────────────────────────────────────────────────────

/** [x, y, width, height] in a page's PDF space. */
export type PdfRect = [number, number, number, number];
/** Fractions (0..1) of the upright page as shown, origin top-left. */
export type DisplayRect = { x: number; y: number; w: number; h: number };
export type Rotation = 0 | 90 | 180 | 270;
export type PageGeometry = { crop: { x: number; y: number; w: number; h: number }; rotation: Rotation };

/** A page's /Rotate as one of the four turns (any multiple of 90, either sign). */
export function normalizeRotation(deg: number): Rotation {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as Rotation;
}

export function pageGeometry(p: Pick<NativeFillPage, 'crop' | 'rotation'>): PageGeometry {
  const [x = 0, y = 0, w = 0, h = 0] = p.crop ?? [];
  return { crop: { x, y, w, h }, rotation: normalizeRotation(p.rotation ?? 0) };
}

/** The page's size as shown, in points (width and height swap on a quarter turn). */
export function displaySize(g: PageGeometry): { width: number; height: number } {
  const turned = g.rotation % 180 !== 0;
  return turned ? { width: g.crop.h, height: g.crop.w } : { width: g.crop.w, height: g.crop.h };
}

/**
 * A point shown at (u, v) points from the top-left of the upright page, in
 * PDF space. The page is shown turned CLOCKWISE by its rotation.
 */
export function displayPointToPage(u: number, v: number, g: PageGeometry): [number, number] {
  const { x, y, w, h } = g.crop;
  switch (g.rotation) {
    case 90: return [x + v, y + u];
    case 180: return [x + w - u, y + v];
    case 270: return [x + w - v, y + h - u];
    default: return [x + u, y + h - v];
  }
}

/** The inverse of displayPointToPage. */
export function pagePointToDisplay(px: number, py: number, g: PageGeometry): [number, number] {
  const { x, y, w, h } = g.crop;
  switch (g.rotation) {
    case 90: return [py - y, px - x];
    case 180: return [x + w - px, py - y];
    case 270: return [y + h - py, x + w - px];
    default: return [px - x, y + h - py];
  }
}

/** A rect on the page as shown (fractions) → PDF space. */
export function displayRectToPage(r: DisplayRect, g: PageGeometry): PdfRect {
  const { width, height } = displaySize(g);
  const [ax, ay] = displayPointToPage(r.x * width, r.y * height, g);
  const [bx, by] = displayPointToPage((r.x + r.w) * width, (r.y + r.h) * height, g);
  return [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)];
}

/** A rect in PDF space → fractions of the page as shown. */
export function pageRectToDisplay(rect: readonly number[], g: PageGeometry): DisplayRect {
  const { width, height } = displaySize(g);
  const [rx = 0, ry = 0, rw = 0, rh = 0] = rect;
  const [ax, ay] = pagePointToDisplay(rx, ry, g);
  const [bx, by] = pagePointToDisplay(rx + rw, ry + rh, g);
  if (!(width > 0) || !(height > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: Math.min(ax, bx) / width,
    y: Math.min(ay, by) / height,
    w: Math.abs(bx - ax) / width,
    h: Math.abs(by - ay) / height,
  };
}

// ── What the user adds ───────────────────────────────────────────────────────

export type FillMarkKind = 'text' | 'date' | 'check' | 'cross' | 'signature' | 'initials';
export type FillInk = SignatureInk;

/**
 * One addition, on page `page`, in display fractions. Text (and the date) is
 * sized by `fontSize` in PDF points; its box (w, h) is what it measured on
 * screen. Marks and signatures are sized by their box.
 */
export type FillMark = {
  id: string;
  page: number;
  kind: FillMarkKind;
  x: number;
  y: number;
  w: number;
  h: number;
  ink: FillInk;
  text?: string;
  fontSize?: number;
  signature?: Signature;
};

export const isTextKind = (k: FillMarkKind) => k === 'text' || k === 'date';
export const isInkKind = (k: FillMarkKind) => k === 'signature' || k === 'initials';

/** Text sizes offered, in PDF points. */
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40] as const;
export const DEFAULT_FONT_SIZE = 12;

/** The next size up or down the scale from `size` (staying put at either end). */
export function stepFontSize(size: number, dir: 1 | -1): number {
  const list = FONT_SIZES as readonly number[];
  if (dir > 0) return list.find(s => s > size + 0.01) ?? list[list.length - 1];
  for (let i = list.length - 1; i >= 0; i--) if (list[i] < size - 0.01) return list[i];
  return list[0];
}

/** The text a mark puts on the page ('' for none). */
export function markText(m: Pick<FillMark, 'kind' | 'text'>): string {
  return isTextKind(m.kind) ? (m.text ?? '').replace(/\s+$/, '') : '';
}

/** A text addition with nothing in it is dropped (the user cleared it). */
export function isEmptyMark(m: FillMark): boolean {
  return isTextKind(m.kind) && markText(m).trim() === '';
}

/**
 * Room kept around text in its annotation box, in points: the appearance is
 * clipped to the box, and the on-screen measure and Core Text differ by a
 * hair, so a box measured tight could cut the last letter or a descender.
 */
export function textPadding(fontSize: number): { right: number; bottom: number } {
  return { right: Math.max(2, fontSize * 0.5), bottom: Math.max(1, fontSize * 0.2) };
}

/** The native call's description of each addition (empty text dropped). */
export function planMarks(marks: readonly FillMark[], pages: readonly NativeFillPage[]): NativeMark[] {
  const out: NativeMark[] = [];
  for (const m of marks) {
    const page = pages[m.page];
    if (!page || isEmptyMark(m)) continue;
    const g = pageGeometry(page);
    let r: DisplayRect = { x: m.x, y: m.y, w: m.w, h: m.h };
    const color = SIGNATURE_INK[m.ink] ?? SIGNATURE_INK.black;
    if (isTextKind(m.kind)) {
      const size = m.fontSize ?? DEFAULT_FONT_SIZE;
      const pad = textPadding(size);
      const { width, height } = displaySize(g);
      if (width > 0 && height > 0) r = { ...r, w: r.w + pad.right / width, h: r.h + pad.bottom / height };
      out.push({ page: m.page, rect: displayRectToPage(clampRect(r), g), kind: 'text', text: markText(m), fontSize: size, color });
    } else if (m.kind === 'check' || m.kind === 'cross') {
      out.push({ page: m.page, rect: displayRectToPage(clampRect(r), g), kind: m.kind, color });
    } else if (m.signature) {
      out.push({ page: m.page, rect: displayRectToPage(clampRect(r), g), kind: 'image', image: m.signature.dataUri, color });
    }
  }
  return out;
}

/** Kept on the page (a box hanging off an edge is shortened, never moved). */
export function clampRect(r: DisplayRect): DisplayRect {
  const x = Math.min(Math.max(0, r.x), 1);
  const y = Math.min(Math.max(0, r.y), 1);
  return { x, y, w: Math.max(0, Math.min(r.w, 1 - x)), h: Math.max(0, Math.min(r.h, 1 - y)) };
}

// ── The form ─────────────────────────────────────────────────────────────────

export type FieldEdit = { value?: string; on?: boolean };
/**
 * The user's changes to the form. Text and choice values are keyed by the
 * field's name (fieldKey): one field can show on several pages (several
 * widgets) and has one value, so editing it anywhere changes it everywhere.
 * Checkboxes and radio buttons are keyed by widget id.
 */
export type FieldEdits = Record<string, FieldEdit>;

/** Where a text or choice field's value lives in FieldEdits: its fully-qualified name (its widget id if it has none). */
export function fieldKey(f: Pick<NativeFillField, 'id' | 'name'>): string {
  return f.name ? `name:${f.name}` : f.id;
}

/** `edits` with text or choice field `f` (and so every widget of it) set to `value`. */
export function setFieldText(edits: FieldEdits, f: Pick<NativeFillField, 'id' | 'name'>, value: string): FieldEdits {
  return { ...edits, [fieldKey(f)]: { value } };
}

/**
 * What to call a field: the form's own description, else its name made
 * readable ("full_name" → "Full name", "dateOfBirth" → "Date of birth"); the
 * last part of a dotted name ("page1.applicant.email" → "Email").
 */
export function fieldLabel(f: Pick<NativeFillField, 'name' | 'label'>): string {
  const own = (f.label ?? '').trim();
  if (own) return own;
  const last = (f.name ?? '').split('.').filter(Boolean).pop() ?? '';
  const words = last
    .replace(/\[\d+\]$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Field';
}

/** True for a field the screen lets the user fill in. */
export function isFillable(f: NativeFillField): boolean {
  return !f.readOnly && (f.kind === 'text' || f.kind === 'choice' || f.kind === 'checkbox' || f.kind === 'radio');
}

/** A field's value as it stands with `edits` applied. */
export function fieldValue(f: NativeFillField, edits: FieldEdits): FieldEdit {
  if (f.kind === 'checkbox' || f.kind === 'radio') return { on: edits[f.id]?.on ?? !!f.on };
  return { value: edits[fieldKey(f)]?.value ?? edits[f.id]?.value ?? f.value ?? '' };
}

/**
 * The edit for tapping checkbox or radio button `f`: a checkbox toggles; a
 * radio button is chosen and the others of its group (same name) are cleared.
 * (Radio buttons, like on paper, aren't un-chosen by a second tap.)
 */
export function toggleButton(f: NativeFillField, fields: readonly NativeFillField[], edits: FieldEdits): FieldEdits {
  if (f.kind === 'checkbox') {
    const on = !fieldValue(f, edits).on;
    const next = { ...edits, [f.id]: { on } };
    if (!f.name) return next;
    // The same checkbox shown on several pages (same name and on-value)
    // follows; one with the same name but another on-value is a choice
    // between them (like radio buttons), so it turns off.
    for (const g of fields) {
      if (g.kind !== 'checkbox' || g.name !== f.name || g.id === f.id) continue;
      if ((g.onValue ?? '') === (f.onValue ?? '')) next[g.id] = { on };
      else if (on) next[g.id] = { on: false };
    }
    return next;
  }
  if (f.kind !== 'radio') return edits;
  const next = { ...edits };
  for (const g of fields) {
    if (g.kind === 'radio' && g.name === f.name) next[g.id] = { on: g.id === f.id };
  }
  return next;
}

/** Fields whose value differs from what the PDF has, as pdfFill wants them. */
export function planFieldValues(fields: readonly NativeFillField[], edits: FieldEdits): NativeFieldValue[] {
  const out: NativeFieldValue[] = [];
  // A text or choice field goes once, whichever page it was edited on: native
  // writes the value to every widget of the field.
  const sent = new Set<string>();
  for (const f of fields) {
    if (!isFillable(f)) continue;
    if (f.kind === 'checkbox' || f.kind === 'radio') {
      const e = edits[f.id];
      if (!e || e.on === undefined || e.on === !!f.on) continue;
      out.push({ id: f.id, name: f.name, kind: f.kind, on: e.on });
    } else {
      const key = fieldKey(f);
      const e = edits[key] ?? edits[f.id];
      if (!e || sent.has(key)) continue;
      const value = f.maxLength && f.maxLength > 0 ? (e.value ?? '').slice(0, f.maxLength) : (e.value ?? '');
      // Unchanged only if every widget of the field already shows it.
      const widgets = f.name ? fields.filter(g => g.name === f.name && g.kind === f.kind) : [f];
      if (widgets.every(g => (g.value ?? '') === value)) continue;
      sent.add(key);
      out.push({ id: f.id, name: f.name, kind: f.kind, value });
    }
  }
  // A radio group changed: send every button of it, so the native side sees
  // which one is chosen (it only turns the chosen one on).
  const groups = new Set(out.filter(v => v.kind === 'radio').map(v => v.name));
  for (const f of fields) {
    if (f.kind !== 'radio' || !groups.has(f.name) || out.some(v => v.id === f.id)) continue;
    out.push({ id: f.id, name: f.name, kind: 'radio', on: fieldValue(f, edits).on });
  }
  return out;
}

// ── Signed and XFA PDFs (pure) ──────────────────────────────────────────────

export type FillNotice = {
  /** 'confirm': ask before saving; 'note': say once; 'blocked': nothing can be filled in here. */
  level: 'confirm' | 'note' | 'blocked';
  title: string;
  body: string;
};

/**
 * What the fill screen must tell the user about this PDF before they work on
 * it (null: nothing). Saving rewrites the whole file, which breaks any digital
 * signature in it; an XFA form shows its own layer in Acrobat, and only the
 * AcroForm fields under it can be filled here.
 */
export function fillNotice(info: Pick<NativeFillInfo, 'signed' | 'certified' | 'xfa' | 'fields'>): FillNotice | null {
  const fillable = (info.fields ?? []).some(isFillable);
  if (info.xfa && !fillable) {
    return {
      level: 'blocked',
      title: 'This form needs Adobe Acrobat',
      body: 'It’s an XFA form, made for Adobe Acrobat Reader. Open it there to fill it in.',
    };
  }
  if (info.signed || info.certified) {
    return {
      level: 'confirm',
      title: 'Saving will invalidate this PDF’s digital signature',
      body: info.certified
        ? 'Its author certified it against changes. After saving, apps like Adobe Acrobat will show the signature as invalid. You can undo right after saving.'
        : 'After saving, apps like Adobe Acrobat will show its signature as invalid. You can undo right after saving.',
    };
  }
  if (info.xfa) {
    return {
      level: 'note',
      title: 'Only the visible fields can be filled in',
      body: 'This is an XFA form. Adobe Acrobat may show it differently from other apps.',
    };
  }
  return null;
}

// ── Flattened copy for sharing (pure decision + native wrapper) ─────────────

/** True when this build can write a flattened copy. */
export function canFlattenPdf(): boolean {
  return typeof VisionOcr?.pdfFlatten === 'function' && typeof VisionOcr?.pdfInfo === 'function';
}

/**
 * Whether Share offers "Flattened PDF" for a PDF with this pdfInfo: it has
 * form fields or additions (signatures, text, notes) to burn in, opens
 * without a password, its permissions allow commenting and filling, and it
 * isn't digitally signed (a flattened copy would carry a broken signature).
 * Older builds (no counts) never offer it.
 */
export function shouldOfferFlatten(info: NativePdfInfo | null | undefined): boolean {
  if (!info || info.locked) return false;
  if (!((info.formFields ?? 0) > 0 || (info.annotations ?? 0) > 0)) return false;
  if (info.signed || info.certified) return false;
  if (info.encrypted && !(info.canAnnotate && info.canFillForms)) return false;
  return true;
}

/** Reads what the Share sheet needs to decide (null when it can't be read). */
export async function pdfShareInfo(pdfUri: string): Promise<NativePdfInfo | null> {
  const read = VisionOcr?.pdfInfo;
  if (typeof read !== 'function') return null;
  try {
    return await read(clean(pdfUri), null);
  } catch {
    return null;
  }
}

/**
 * True when the PDF holds a digital signature (or is certified): any change
 * to the file, a page edit included, invalidates it. False when unknown.
 */
export async function isDigitallySigned(pdfUri: string): Promise<boolean> {
  const info = await pdfShareInfo(pdfUri);
  return !!(info && (info.signed || info.certified));
}

/** The question asked before changing a digitally signed PDF (page edits). */
export const SIGNED_PDF_CHANGE = {
  title: 'Changing this PDF will invalidate its digital signature',
  body: 'Apps like Adobe Acrobat will show its signature as invalid. You can undo right after.',
  confirm: 'Change anyway',
} as const;

/**
 * Writes a flattened copy of `pdfUri` to `outUri` (form values, signatures
 * and added text drawn into the pages; their text stays text; links kept).
 * The stored PDF is not touched. Rejects with PdfEditError.
 */
export async function flattenPdfCopy(pdfUri: string, outUri: string): Promise<string> {
  const flatten = VisionOcr?.pdfFlatten;
  if (typeof flatten !== 'function') throw new PdfEditError('unavailable', 'pdfFlatten missing');
  try {
    await flatten(clean(pdfUri), clean(outUri));
  } catch (err) {
    const e = classifyNative(err);
    const code = (err as { code?: string } | null)?.code ?? '';
    if (code === 'ERR_PDF_RESTRICTED') throw new PdfEditError('restricted', e.message);
    throw e;
  }
  return outUri;
}

// ── Messages ─────────────────────────────────────────────────────────────────

/** What the toast says after saving; lib/last-undo.ts turns it into the menu's "Undo …". */
export function fillMessage(marks: readonly FillMark[], fieldCount: number): string {
  const kept = marks.filter(m => !isEmptyMark(m));
  const signed = kept.some(m => isInkKind(m.kind));
  const other = kept.some(m => !isInkKind(m.kind)) || fieldCount > 0;
  if (signed && !other) return 'Signed';
  if (signed) return 'Filled in and signed';
  if (fieldCount > 0 && kept.length === 0) return 'Form filled in';
  return 'Filled in';
}

/** The page the viewer should show after saving: the first one changed, else `fallback`. */
export function firstChangedPage(marks: readonly FillMark[], fields: readonly NativeFieldValue[], all: readonly NativeFillField[], fallback: number): number {
  const pages: number[] = marks.filter(m => !isEmptyMark(m)).map(m => m.page);
  for (const v of fields) {
    const f = all.find(x => x.id === v.id);
    if (f) pages.push(f.page);
  }
  return pages.length ? Math.min(...pages) : fallback;
}

/**
 * The route to Fill & sign document `docId` at `page` (app/pdf-fill.tsx;
 * 'last': its last page, where a contract is usually signed).
 * `fromViewer`: the viewer is underneath, so Done goes back to it.
 */
export function pdfFillHref(docId: string, page: number | 'last' = 0, fromViewer = false): Href {
  const params: Record<string, string> = { docId, page: page === 'last' ? 'last' : String(Math.max(0, Math.floor(page))) };
  if (fromViewer) params.from = 'viewer';
  // Cast: the typed-routes list is regenerated by the dev server, which may not know the screen yet.
  return { pathname: '/pdf-fill', params } as unknown as Href;
}

// ── Native ───────────────────────────────────────────────────────────────────

/** True when this build can fill and sign PDFs in place. */
export function canFillPdf(): boolean {
  return (
    typeof VisionOcr?.pdfFill === 'function' &&
    typeof VisionOcr?.pdfFillInfo === 'function' &&
    typeof VisionOcr?.pdfRenderPage === 'function' &&
    typeof VisionOcr?.replaceFile === 'function'
  );
}

const clean = (uri: string) => uri.split('?')[0];

export type FillSession = {
  info: NativeFillInfo;
  /** The stored PDF's bytes when the screen read it: saving refuses if they changed. */
  print: FilePrint;
};

function classifyNative(err: unknown): PdfEditError {
  if (err instanceof PdfEditError) return err;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const code = (err as { code?: string } | null)?.code ?? '';
  if (code === 'ERR_PDF_LOCKED' || /^locked$/i.test(msg)) return new PdfEditError('locked', msg);
  if (/could not open|no pages/i.test(msg)) return new PdfEditError('unreadable', msg);
  return new PdfEditError('failed', msg);
}

/** Reads what the fill screen needs from the stored PDF. Rejects with PdfEditError. */
export async function openFillSession(pdfUri: string): Promise<FillSession> {
  const read = VisionOcr?.pdfFillInfo;
  if (typeof read !== 'function') throw new PdfEditError('unavailable', 'pdfFillInfo missing');
  const uri = clean(pdfUri);
  if (!new File(uri).exists) throw new PdfEditError('unreadable', 'stored PDF missing');
  let info: NativeFillInfo;
  try {
    info = await read(uri);
  } catch (err) {
    throw classifyNative(err);
  }
  if (!info || !(info.pageCount > 0) || !Array.isArray(info.pages)) throw new PdfEditError('unreadable', 'no pages');
  return { info: { ...info, fields: Array.isArray(info.fields) ? info.fields : [] }, print: filePrint(uri) };
}

const PREVIEW_DIR = 'pdf-fill';
let previewSeq = 0;

function previewDir(): Directory {
  return new Directory(Paths.cache, PREVIEW_DIR);
}

/**
 * Page `index` as an upright JPEG for the screen, long edge `maxEdge` px
 * (bounded: a phone has far less memory than the simulator). With `hideFields`
 * the form's own widgets are left out; the screen draws them.
 */
export async function renderFillPage(pdfUri: string, index: number, maxEdge: number, hideFields: boolean): Promise<{ uri: string; width: number; height: number }> {
  const render = VisionOcr?.pdfRenderPage;
  if (typeof render !== 'function') throw new PdfEditError('unavailable', 'pdfRenderPage missing');
  const dir = previewDir();
  dir.create({ intermediates: true, idempotent: true });
  previewSeq += 1;
  const out = new File(dir, `page-${Date.now().toString(36)}-${previewSeq}-${index}.jpg`);
  try {
    return await render(clean(pdfUri), index, out.uri, Math.round(Math.min(Math.max(maxEdge, 600), 2400)), hideFields);
  } catch (err) {
    throw classifyNative(err);
  }
}

/** Deletes the page previews (the screen closed). Never throws. */
export function clearFillPreviews(): void {
  try {
    const dir = previewDir();
    if (dir.exists) dir.delete();
  } catch {}
}

/** Something rewrote a document's PDF from outside the viewer (Fill & sign, its Undo): show `page`. */
type RewriteListener = (docId: string, page: number) => void;
const rewriteListeners = new Set<RewriteListener>();

export function subscribePdfRewrites(fn: RewriteListener): () => void {
  rewriteListeners.add(fn);
  return () => { rewriteListeners.delete(fn); };
}

/** The last rewrite, for a viewer that opens after it (Fill & sign from Tools). */
let pendingRewrite: { docId: string; page: number; at: number } | null = null;
const PENDING_REWRITE_MS = 15_000;

/** The page to open `docId` at after a recent rewrite (once), or null. */
export function takePendingRewrite(docId: string, now = Date.now()): number | null {
  const p = pendingRewrite;
  if (!p || p.docId !== docId) return null;
  pendingRewrite = null;
  return now - p.at <= PENDING_REWRITE_MS ? p.page : null;
}

function emitRewrite(docId: string, page: number): void {
  pendingRewrite = { docId, page, at: Date.now() };
  for (const l of [...rewriteListeners]) {
    try { l(docId, page); } catch {}
  }
}

/**
 * Writes the form values and additions into document `docId`'s PDF in place
 * (lib/pdf-edit.ts rewriteStoredPdf: atomic, journaled, with Undo). Refuses
 * with PdfEditError 'changed' when the PDF is no longer what the screen read,
 * and with 'failed' when there is nothing to save.
 */
export async function fillStoredPdf(
  docId: string,
  pdfUri: string,
  session: FillSession,
  marks: readonly FillMark[],
  edits: FieldEdits,
  showPage: number,
): Promise<PdfEditResult> {
  const fill = VisionOcr?.pdfFill;
  if (typeof fill !== 'function' || !canFillPdf()) throw new PdfEditError('unavailable', 'pdfFill missing');
  const nativeMarks = session.info.canAnnotate ? planMarks(marks, session.info.pages) : [];
  const fields = session.info.canFillForms ? planFieldValues(session.info.fields, edits) : [];
  if (nativeMarks.length === 0 && fields.length === 0) throw new PdfEditError('failed', 'nothing to save');
  const result = await rewriteStoredPdf(
    docId,
    async (target, out) => {
      if (target !== clean(pdfUri) || !samePrint(filePrint(target), session.print)) {
        throw new PdfEditError('changed', 'PDF changed since it was opened');
      }
      return fill(target, out, fields, nativeMarks);
    },
    session.info.pageCount,
  );
  emitRewrite(docId, showPage);
  return result;
}

/** Undo of a fill (the toast or the viewer's menu); the viewer shows `page` again. */
export async function undoPdfFill(undo: PdfEditUndo, page: number) {
  const doc = await undoPdfEdit(undo);
  emitRewrite(undo.docId, page);
  return doc;
}

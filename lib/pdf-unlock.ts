// lib/pdf-unlock.ts
// Opening a password-protected PDF. The user types the password once; PDFKit
// writes an unencrypted copy (VisionOcr.unlockPdf), and that copy replaces the
// stored PDF so the document opens, converts, prints and searches like any
// other from then on. The protected original is kept until the copy is safely
// in place: a wrong password, a failed write or a document deleted meanwhile
// leaves it exactly as it was.
import { Directory, File, Paths } from 'expo-file-system';
import { VisionOcr } from '../modules/vision-ocr/src';
import { withDocLock } from './bake';
import { getDocument, updateDocumentWith } from './storage';
import { indexPdfText } from './pdf-text';

/** Caches/pdf-convert is cleared by the startup sweep (lib/files.ts TEMP_DIRS). */
const WORK_DIR = 'pdf-convert';

export class PdfUnlockError extends Error {
  constructor(readonly kind: 'wrong-password' | 'unavailable' | 'missing' | 'failed', message: string) {
    super(message);
    this.name = 'PdfUnlockError';
  }
}

export function pdfUnlockAvailable(): boolean {
  return typeof VisionOcr?.unlockPdf === 'function';
}

/** Maps a native rejection to what the user is told. */
export function unlockErrorKind(err: unknown): 'wrong-password' | 'failed' {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /wrong-password|password/i.test(msg) ? 'wrong-password' : 'failed';
}

function workDir(): Directory {
  const dir = new Directory(Paths.cache, WORK_DIR);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function deleteQuietly(file: File | null): void {
  try {
    if (file?.exists) file.delete();
  } catch {}
}

/**
 * Replaces document `docId`'s protected PDF with an unlocked copy made with
 * `password`. Resolves once the record has been updated (its text is indexed
 * in the background). Rejects with PdfUnlockError.
 */
export async function unlockStoredPdf(docId: string, password: string): Promise<void> {
  const unlock = VisionOcr?.unlockPdf;
  if (typeof unlock !== 'function') throw new PdfUnlockError('unavailable', 'unlockPdf missing');
  const doc = await getDocument(docId);
  if (!doc?.pdfUri) throw new PdfUnlockError('missing', 'not a PDF document');
  if (!password) throw new PdfUnlockError('wrong-password', 'empty password');
  const storedUri = doc.pdfUri.split('?')[0];

  const out = new File(workDir(), `unlock-${Date.now()}.pdf`);
  try {
    await unlock(storedUri, out.uri, password);
  } catch (err) {
    deleteQuietly(out);
    const kind = unlockErrorKind(err);
    throw new PdfUnlockError(kind, kind === 'wrong-password' ? 'wrong password' : 'unlock failed');
  }
  if (!out.exists) throw new PdfUnlockError('failed', 'no output');

  // Swap under the page lock, against the CURRENT record: the protected file is
  // moved aside (not deleted) until the unlocked one is in its place.
  await withDocLock(docId, async () => {
    const current = await getDocument(docId);
    if (!current?.pdfUri || current.pdfUri.split('?')[0] !== storedUri) {
      deleteQuietly(out);
      throw new PdfUnlockError('missing', 'document changed');
    }
    const stored = new File(storedUri);
    const backup = new File(workDir(), `locked-${Date.now()}.pdf`);
    try {
      if (stored.exists) stored.move(backup);
      out.move(new File(storedUri));
    } catch (err) {
      // Put the protected original back where it was.
      try {
        if (backup.exists && !new File(storedUri).exists) backup.move(new File(storedUri));
      } catch {}
      deleteQuietly(out);
      throw new PdfUnlockError('failed', err instanceof Error ? err.message : 'swap failed');
    }
    // Same path, new bytes: updatedAt tells every view to load it again.
    const ok = await updateDocumentWith(docId, () => ({ updatedAt: Date.now() }));
    deleteQuietly(backup);
    if (!ok) throw new PdfUnlockError('missing', 'document deleted');
  });
  indexPdfText(docId, { force: true }).catch(() => {});
}

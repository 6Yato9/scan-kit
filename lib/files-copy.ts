// lib/files-copy.ts
// "Keep a copy in Files" (Settings › Storage): an automatic backup with no
// account. Every document is kept as a searchable PDF in the app's Documents
// folder, which the Files app shows under On My iPhone › Scan Kit (with
// UIFileSharingEnabled and LSSupportsOpeningDocumentsInPlace in Info.plist),
// and from there it is included in device backups and can be moved to iCloud
// Drive or a computer. A copy is rewritten when its document changes and
// removed when the document is deleted.
//
// The work is a reconcile pass (planFilesCopy), not a hook in every writer:
// it compares the live documents with what it wrote last time (a manifest),
// so it catches every kind of change wherever it was made. Passes are
// requested by the Home tab (focus, saves, background edits, returning to the
// app) and are debounced and serial; a request during a pass runs one more.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { getDocSettings, getDocuments } from './storage';
import { generatePdf } from './pdf';
import { ocrAvailable } from './ocr';
import { exportFileName } from './share';
import { planFilesCopy, type CopyManifest } from './files-copy-plan';

const ENABLED_KEY = '@scan_kit_files_copy';
const MANIFEST_KEY = '@scan_kit_files_copy_manifest';

/** Where the copies go: the Documents folder itself, what Files shows as the app's folder. */
function copyDir(): Directory {
  return new Directory(Paths.document);
}

/**
 * Off until the app's internal data moves out of Documents. Exposing Documents
 * to the Files app (UIFileSharingEnabled) would also expose every internal
 * page image, signature and OCR text — outside App Lock. When the migration to
 * Library/Application Support lands, flip this and set the Info.plist keys.
 */
export const FILES_COPY_AVAILABLE = false;

export async function getFilesCopyEnabled(): Promise<boolean> {
  if (!FILES_COPY_AVAILABLE) return false;
  try {
    return (await AsyncStorage.getItem(ENABLED_KEY)) === '1';
  } catch {
    return false;
  }
}

async function readManifest(): Promise<CopyManifest> {
  try {
    const raw = await AsyncStorage.getItem(MANIFEST_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeManifest(m: CopyManifest): Promise<void> {
  if (Object.keys(m).length) await AsyncStorage.setItem(MANIFEST_KEY, JSON.stringify(m));
  else await AsyncStorage.removeItem(MANIFEST_KEY);
}

function deleteCopy(name: string): void {
  try {
    const f = new File(copyDir(), name);
    if (f.exists) f.delete();
  } catch {
    // already gone, or the user moved it in Files: nothing to do
  }
}

// ── The reconcile pass ───────────────────────────────────────────────────────

let running = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by turning the feature off: a pass in flight stops at its next step. */
let generation = 0;

/**
 * Ask for a pass soon (debounced: a burst of edits makes one pass). Cheap to
 * call often; does nothing while the feature is off.
 */
export function requestFilesCopySync(delayMs = 2000): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runSync();
  }, delayMs);
}

async function runSync(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await syncOnce();
    } while (again);
  } finally {
    running = false;
  }
}

async function syncOnce(): Promise<void> {
  if (!(await getFilesCopyEnabled())) return;
  const gen = generation;
  const docs = await getDocuments();
  const manifest = await readManifest();
  const plan = planFilesCopy(docs, manifest, n => exportFileName(n, 'pdf'));
  if (!plan.remove.length && !plan.write.length && !plan.forget.length) return;

  for (const name of plan.remove) deleteCopy(name);
  for (const id of plan.forget) delete manifest[id];
  await writeManifest(manifest);

  const byId = new Map(docs.map(d => [d.id, d]));
  for (const w of plan.write) {
    if (gen !== generation) return; // turned off meanwhile
    const doc = byId.get(w.id);
    if (!doc) continue;
    const ok = await writeCopy(doc, w.name);
    if (gen !== generation) {
      // Turned off while this one was being made: don't leave it behind.
      if (ok) deleteCopy(w.name);
      return;
    }
    if (!ok) continue; // tried again on the next pass
    manifest[w.id] = { name: w.name, stamp: w.stamp };
    await writeManifest(manifest);
  }
}

/** Writes one document's PDF under `name`, replacing the old copy only once the new one exists. */
async function writeCopy(
  doc: { pages: string[]; pdfUri?: string },
  name: string,
): Promise<boolean> {
  // A dot name: hidden in Files while it is being written.
  const temp = new File(copyDir(), `.${Date.now().toString(36)}-copy.pdf`);
  try {
    if (doc.pdfUri) {
      new File(doc.pdfUri.split('?')[0]).copy(temp);
    } else {
      const settings = await getDocSettings().catch(() => null);
      const out = await generatePdf(doc.pages, {
        pageSize: settings?.pdfPageSize ?? 'A4',
        quality: 'standard',
        searchable: ocrAvailable(),
      });
      new File(out.split('?')[0]).move(temp);
    }
    const dest = new File(copyDir(), name);
    if (dest.exists) dest.delete();
    temp.move(dest);
    return true;
  } catch {
    try { if (temp.exists) temp.delete(); } catch {}
    return false;
  }
}

// ── Turning it on and off ────────────────────────────────────────────────────

/** Turns the feature on (and makes every copy now) or off. */
export async function setFilesCopyEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await AsyncStorage.setItem(ENABLED_KEY, '1');
    requestFilesCopySync(0);
  } else {
    generation++;
    await AsyncStorage.removeItem(ENABLED_KEY);
  }
}

/** Deletes every copy this feature wrote (after turning it off, if the user asks). */
export async function removeFilesCopies(): Promise<number> {
  const manifest = await readManifest();
  const names = Object.values(manifest).map(e => e.name);
  for (const n of names) deleteCopy(n);
  await writeManifest({});
  return names.length;
}

/** How many copies are in Files now (from the manifest). */
export async function filesCopyCount(): Promise<number> {
  return Object.keys(await readManifest()).length;
}

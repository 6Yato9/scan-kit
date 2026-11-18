// lib/recovered-files.ts
// Settings › Recovered files (app/settings/recovered-files.tsx): the files the
// app set aside and would otherwise keep out of sight for good —
//  - pages an update kept aside because both an older and a newer build had
//    written the same file (lib/storage-layout.ts merge: scan-kit-recovered/);
//  - pages the one-time Documents pass moved that no document uses any more
//    (legacy-documents/).
// The user can bring a set back as a new document, or delete it. Nothing here
// ever touches a file a document (live or in Recently deleted) uses.
import {
  deleteRecoveredGroup,
  listRecoveredGroups,
  rebaseStoredUri,
  type RecoveredGroup,
} from './storage-layout';
import { documentFileRefsForCleanup, documentIdsForCleanup, getScanSettings } from './storage';
import { saveScan } from './save-scan';
import { autoName } from './auto-name';

export type { RecoveredGroup };

const QUALITY = { low: 0.5, medium: 0.75, high: 0.9 } as const;

function clean(uri: string): string {
  return rebaseStoredUri(uri.split('?')[0]).split('?')[0];
}

/**
 * Every file URI a document record uses (pages, their .orig shadows, PDFs),
 * or null when not every record could be read.
 */
async function referencedFiles(): Promise<Set<string> | null> {
  const [ids, refs] = await Promise.all([documentIdsForCleanup(), documentFileRefsForCleanup()]);
  if (!ids || !refs || refs.length < ids.length) return null;
  const out = new Set<string>();
  for (const r of refs) {
    for (const p of r.pages) {
      const u = clean(p);
      out.add(u);
      out.add(u.replace(/\.jpg$/, '.orig.jpg'));
    }
    if (r.pdfUri) out.add(clean(r.pdfUri));
  }
  return out;
}

/** What there is to show (empty when nothing was set aside). */
export async function getRecoveredGroups(): Promise<RecoveredGroup[]> {
  try {
    return listRecoveredGroups(await referencedFiles());
  } catch {
    return [];
  }
}

/** True when a group can come back as a document (pages or a PDF). */
export function canRestore(g: RecoveredGroup): boolean {
  return (g.kind === 'pages' || g.kind === 'pdf') && g.files.length > 0;
}

/**
 * Saves a group as a new document (copies — the originals stay until the
 * document is safely saved), then removes the group. Returns the new id.
 */
export async function restoreRecoveredGroup(g: RecoveredGroup): Promise<string> {
  if (!canRestore(g)) throw new Error('recovered: nothing to restore');
  const scan = await getScanSettings();
  const name = autoName(new Date(g.savedAt ?? Date.now()), 'Recovered');
  const { id } = g.kind === 'pdf'
    ? await saveScan({ pdfUri: g.files[0], name, quality: QUALITY[scan.quality] })
    : await saveScan({ pages: g.files, name, quality: QUALITY[scan.quality] });
  // Saved: the set-aside files are now in the document.
  deleteRecoveredGroup(g);
  return id;
}

/** Deletes a group for good. */
export function deleteRecovered(g: RecoveredGroup): boolean {
  return deleteRecoveredGroup(g);
}

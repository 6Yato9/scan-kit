// lib/copy-undo.ts
// One way for the PDF tools that save a copy (Unlock PDF, Protect PDF,
// Flatten PDF) to name it, open it and offer Undo, so they all behave alike:
//
// - The copy is "<name> (<what>)" — "Lease (protected)" — in the same folder
//   as the original (each tool's lib sets `folder`), the original untouched.
// - It replaces the tool in the viewer, which shows the tool's message with
//   Undo (its toast and its "…" menu: lib/last-undo.ts names it, e.g. "Undo
//   protect PDF").
// - Undo removes the copy (lib/merge-undo undoNewMerge: deleted outright when
//   it is exactly as saved, else moved to Recently deleted so later work on it
//   isn't lost), closes its viewer and says so where the user lands: in the
//   original's viewer when the tool was opened from it (the viewer covers the
//   app-wide toast host, so it takes a viewer notice), else as a toast.
import { Alert } from 'react-native';
import { router as stackRouter, type Router } from 'expo-router';
import type { Document } from '../types/document';
import { newMergeUndo, undoNewMerge } from './merge-undo';
import { postViewerNotice } from './viewer-notice';
import { navigateWhenUnlocked } from './nav-guard';
import { notifyError, notifySuccess } from './haptics';

/** "Lease" + "protected" -> "Lease (protected)"; a name that already ends so is kept. */
export function copyName(name: string, what: string): string {
  const base = name.trim() || 'Document';
  const tag = `(${what})`;
  return base.toLowerCase().endsWith(tag.toLowerCase()) ? base : `${base} ${tag}`;
}

/** What Undo of a new copy says: "Protected copy removed" / "… moved to Recently deleted". */
export function copyUndoneMessage(what: string, outcome: 'deleted' | 'trashed' | 'missing'): string {
  const label = `${what.charAt(0).toUpperCase()}${what.slice(1)} copy`;
  return outcome === 'trashed' ? `${label} moved to Recently deleted` : `${label} removed`;
}

type Toast = { show: (message: string) => void };

/**
 * Opens `copy` in the viewer in place of the tool screen, with `message` and
 * Undo (see the header). `what` names the copy for Undo's confirmation
 * ("protected" -> "Protected copy removed"). Call right after the copy was
 * saved (it navigates through navigateWhenUnlocked).
 */
export function openNewCopy({
  copy,
  message,
  what,
  sourceId,
  fromViewer,
  router,
  toast,
  bumpLastSaved,
}: {
  copy: Pick<Document, 'id' | 'updatedAt'>;
  message: string;
  what: string;
  /** The original document (its viewer is under this one when `fromViewer`). */
  sourceId: string;
  fromViewer: boolean;
  router: Pick<Router, 'replace'>;
  toast: Toast;
  bumpLastSaved: () => void;
}): void {
  const undo = newMergeUndo(copy);
  postViewerNotice({
    docId: copy.id,
    message,
    action: {
      label: 'Undo',
      onPress: () => {
        undoNewMerge(undo)
          .then(outcome => {
            bumpLastSaved();
            notifySuccess();
            const done = copyUndoneMessage(what, outcome);
            if (fromViewer) postViewerNotice({ docId: sourceId, message: done });
            navigateWhenUnlocked(() => stackRouter.back());
            if (!fromViewer) toast.show(done);
          })
          .catch(err => {
            console.error('Undo new copy failed', err);
            notifyError();
            Alert.alert('Couldn’t undo', `Try again, or delete the ${what} copy yourself.`);
          });
      },
    },
  });
  navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id: copy.id } }));
}

// components/document-actions.tsx
// The long-press action flow shared by Home and Files: the actions sheet and
// everything it leads to (rename, duplicate, merge, move, share/export,
// delete). Each screen keeps its own document list; this hook updates it.
// Delete is a soft delete into Recently deleted, with Undo in the toast.
// Merge offers Undo too (lib/merge-undo.ts): pages merged into a document
// come out again; a new merged document (with an imported PDF) goes.
//
// Rename and move use patchDocument so they only touch the fields they change
// and never overwrite OCR text indexed in the background meanwhile.
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { Document } from '@/types/document';
import { patchDocument, restoreDocument, saveFolder, getFolders, trashDocument } from '@/lib/storage';
import { duplicateDocument, mergeIntoWithUndo } from '@/lib/doc-ops';
import {
  MERGE_UNDO_FAILED_TITLE,
  mergedIntoMessage,
  mergedNewMessage,
  MergeUndoError,
  mergeUndoneMessage,
  mergeUndoRefusalMessage,
  newMergeUndo,
  newMergeUndoFailedMessage,
  undoMergeInto,
  undoNewMerge,
  type MergeUndo,
  type NewMergeUndo,
} from '@/lib/merge-undo';
import { mergeDocumentsToPdf, needsPdfMerge, PdfEditError } from '@/lib/pdf-edit';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { useToast } from '@/components/toast';
import { useScan } from '@/contexts/scan-context';
import { DocActionsSheet } from '@/components/doc-actions-sheet';
import { RenameSheet } from '@/components/rename-sheet';
import { MergeSheet } from '@/components/merge-sheet';
import { MoveFolderSheet } from '@/components/move-folder-sheet';
import { ExportSheet } from '@/components/export-sheet';

type SetDocs = React.Dispatch<React.SetStateAction<Document[]>>;

export function useDocumentActions({
  documents,
  setDocuments,
  folders,
  setFolders,
  onSelect,
}: {
  documents: Document[];
  setDocuments: SetDocs;
  folders: string[];
  setFolders: (f: string[]) => void;
  /** Enables the "Select" row (multi-select entry point). */
  onSelect?: (doc: Document) => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const { bumpLastSaved } = useScan();
  const [actionsTarget, setActionsTarget] = useState<Document | null>(null);
  const [renameTarget, setRenameTarget] = useState<Document | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Document | null>(null);
  const [moveTarget, setMoveTarget] = useState<Document | null>(null);
  const [exportDoc, setExportDoc] = useState<Document | null>(null);
  const [exportVisible, setExportVisible] = useState(false);

  const dropMissing = useCallback((id: string) => {
    setDocuments(prev => prev.filter(d => d.id !== id));
    toast.show('This document no longer exists');
  }, [setDocuments, toast]);

  const handleDelete = useCallback((doc: Document) => {
    Alert.alert(
      `Delete “${doc.name}”?`,
      'It moves to Recently deleted, where you can restore it for 30 days.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              // Soft delete: the record and files stay until Recently deleted is emptied.
              const ok = await trashDocument(doc.id);
              setDocuments(prev => prev.filter(d => d.id !== doc.id));
              if (!ok) return;
              notifySuccess();
              toast.show('Moved to Recently deleted', {
                action: {
                  label: 'Undo',
                  onPress: () => {
                    restoreDocument(doc.id)
                      .then(restored => {
                        if (restored) setDocuments(prev => (prev.some(d => d.id === doc.id) ? prev : [{ ...doc, trashedAt: undefined }, ...prev]));
                        bumpLastSaved();
                      })
                      .catch(err => {
                        console.error('Restore failed', err);
                        Alert.alert('Couldn’t restore the document', 'Find it in Settings, Recently deleted.');
                      });
                  },
                },
              });
            } catch (err) {
              console.error('Delete failed', err);
              Alert.alert('Couldn’t delete the document', 'Try again.');
            }
          },
        },
      ],
    );
  }, [setDocuments, toast, bumpLastSaved]);

  const handleDuplicate = useCallback(async (doc: Document) => {
    try {
      const copy = await duplicateDocument(doc);
      setDocuments(prev => [copy, ...prev]);
      toast.show('Document duplicated');
    } catch (err) {
      console.error('Duplicate failed', err);
      Alert.alert('Couldn’t duplicate document', 'There may not be enough free space. Please try again.');
    }
  }, [setDocuments, toast]);

  const handleRename = useCallback(async (doc: Document, newName: string) => {
    setRenameTarget(null);
    try {
      const updatedAt = Date.now();
      const ok = await patchDocument(doc.id, { name: newName, updatedAt });
      if (!ok) { dropMissing(doc.id); return; }
      setDocuments(prev => prev.map(d => (d.id === doc.id ? { ...d, name: newName, updatedAt } : d)));
    } catch (err) {
      console.error('Rename failed', err);
      Alert.alert('Couldn’t rename document', 'Please try again.');
    }
  }, [setDocuments, dropMissing]);

  /** Undo for a merge that made a new document (a PDF here): it goes; the originals were never touched. */
  const undoNewMergeDoc = useCallback((undo: NewMergeUndo, pdf: boolean) => {
    undoNewMerge(undo)
      .then(outcome => {
        setDocuments(prev => prev.filter(d => d.id !== undo.docId));
        bumpLastSaved();
        notifySuccess();
        // Changed since the merge: kept in Recently deleted rather than deleted.
        toast.show(mergeUndoneMessage(outcome, pdf));
      })
      .catch(err => {
        console.error('Undo merge failed', err);
        notifyError();
        Alert.alert(MERGE_UNDO_FAILED_TITLE, newMergeUndoFailedMessage(pdf));
      });
  }, [setDocuments, bumpLastSaved, toast]);

  /** Undo for pages merged into an existing document: takes exactly those pages out again. */
  const undoMergeIntoDoc = useCallback((undo: MergeUndo) => {
    undoMergeInto(undo)
      .then(updated => {
        setDocuments(prev => prev.map(d => (d.id === updated.id ? updated : d)));
        notifySuccess();
        toast.show(mergeUndoneMessage());
      })
      .catch(err => {
        notifyError();
        // Refused (the document changed since): nothing was touched.
        if (err instanceof MergeUndoError && err.editRefused) {
          Alert.alert(MERGE_UNDO_FAILED_TITLE, mergeUndoRefusalMessage(err.kind));
          return;
        }
        console.error('Undo merge failed', err);
        Alert.alert(MERGE_UNDO_FAILED_TITLE, 'Try again.');
      });
  }, [setDocuments, toast]);

  const handleMerge = useCallback(async (target: Document, source: Document) => {
    // An imported PDF in the pair: one new PDF, both originals kept (lib/pdf-edit).
    if (needsPdfMerge([target, source])) {
      try {
        const merged = await mergeDocumentsToPdf([target, source], `${target.name} (merged)`);
        setDocuments(prev => [merged, ...prev]);
        bumpLastSaved();
        notifySuccess();
        const undo = newMergeUndo(merged);
        toast.show(mergedNewMessage(2), { action: { label: 'Undo', onPress: () => undoNewMergeDoc(undo, true) } });
      } catch (err) {
        const locked = err instanceof PdfEditError && err.kind === 'locked';
        if (err instanceof PdfEditError && err.kind === 'restricted') {
          Alert.alert('This PDF can’t be merged', 'Its author doesn’t allow changes to its pages.');
          return;
        }
        if (!locked) console.error('PDF merge failed', err);
        const who = locked ? [target, source].find(d => d.id === (err as PdfEditError).docId) : null;
        Alert.alert(
          locked ? `“${who?.name ?? 'This PDF'}” is password protected` : 'Couldn’t merge the documents',
          locked ? 'Open it and enter its password, then merge again.' : 'There may not be enough free space. Try again.',
        );
      }
      return;
    }
    try {
      const result = await mergeIntoWithUndo(target, source);
      if (!result) { dropMissing(target.id); return; }
      const { doc: updated, added, undo } = result;
      setDocuments(prev => prev.map(d => (d.id === updated.id ? updated : d)));
      notifySuccess();
      toast.show(
        mergedIntoMessage(added, 'to', target.name),
        undo ? { action: { label: 'Undo', onPress: () => undoMergeIntoDoc(undo) } } : undefined,
      );
    } catch (err) {
      console.error('Merge failed', err);
      Alert.alert('Couldn’t merge the documents', 'There may not be enough free space. Try again.');
    }
  }, [setDocuments, dropMissing, toast, bumpLastSaved, undoNewMergeDoc, undoMergeIntoDoc]);

  const handleMove = useCallback(async (doc: Document, folder: string | null) => {
    setMoveTarget(null);
    if ((doc.folder ?? null) === folder) return;
    try {
      const updatedAt = Date.now();
      const ok = await patchDocument(doc.id, { folder: folder ?? undefined, updatedAt });
      if (!ok) { dropMissing(doc.id); return; }
      setDocuments(prev => prev.map(d => (d.id === doc.id ? { ...d, folder: folder ?? undefined, updatedAt } : d)));
      toast.show(folder ? `Moved to “${folder}”` : 'Removed from folder');
    } catch (err) {
      console.error('Move to folder failed', err);
      Alert.alert('Couldn’t move document', 'Please try again.');
    }
  }, [setDocuments, dropMissing, toast]);

  const createFolder = useCallback(async (name: string) => {
    await saveFolder(name);
    setFolders(await getFolders());
  }, [setFolders]);

  const sheets = (
    <>
      <DocActionsSheet
        visible={actionsTarget !== null}
        document={actionsTarget}
        onShare={doc => { setExportDoc(doc); setExportVisible(true); }}
        onRename={setRenameTarget}
        onDuplicate={doc => { handleDuplicate(doc); }}
        onMerge={setMergeTarget}
        onSplit={doc => navigateWhenUnlocked(() => router.push({ pathname: '/tools/split', params: { docId: doc.id } }))}
        onMoveToFolder={setMoveTarget}
        onSelect={onSelect}
        onDelete={handleDelete}
        onClose={() => setActionsTarget(null)}
      />
      <RenameSheet
        visible={renameTarget !== null}
        document={renameTarget}
        onRename={handleRename}
        onClose={() => setRenameTarget(null)}
      />
      <MergeSheet
        visible={mergeTarget !== null}
        targetDoc={mergeTarget}
        allDocs={documents}
        onMerge={handleMerge}
        onClose={() => setMergeTarget(null)}
      />
      <MoveFolderSheet
        visible={moveTarget !== null}
        document={moveTarget}
        folders={folders}
        onMove={handleMove}
        onCreateFolder={createFolder}
        onClose={() => setMoveTarget(null)}
      />
      {exportDoc && (
        <ExportSheet visible={exportVisible} document={exportDoc} onClose={() => setExportVisible(false)} />
      )}
    </>
  );

  return { openActions: setActionsTarget, sheets, createFolder };
}

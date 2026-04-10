# Scan Kit v2 — Full CamScanner Feature Set Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add all offline-capable CamScanner features to Scan Kit: export fix, page editing (rotate/filter/delete/reorder), viewer enhancements (thumbnail strip, add-more, print), and home screen upgrades (search, sort, multi-select, document actions).

**Architecture:** Extend the existing sheet-first pattern. All page and document operations are triggered via bottom sheets or modals within the existing flat Stack (index + viewer). No new navigation screens except a fullscreen reorder modal. Two new packages: `expo-image-manipulator` and `react-native-draggable-flatlist`.

**Tech Stack:** Expo 54, expo-image-manipulator, react-native-draggable-flatlist, react-native-gesture-handler (existing), react-native-reanimated (existing), expo-print (existing), expo-sharing (existing), AsyncStorage (existing), expo-file-system v19 class API (existing).

---

## 1. Export Fix

### Problem
`ExportSheet` calls `onClose()` before the system share sheet appears, so the spinner is dismissed immediately and the user sees nothing while the PDF is generating.

### Fix
Keep the sheet open and spinner visible for the entire duration of the export operation. `onClose()` is called only after `shareAsync()` resolves or rejects.

**PDF export flow:**
1. User taps "Export as PDF"
2. Sheet stays open, spinner replaces buttons
3. `generatePdf()` runs (may take 1–3 seconds)
4. `Sharing.shareAsync()` is called — system share sheet appears on top of our sheet
5. User picks destination (Messages, WhatsApp, Save to Files, etc.)
6. After share sheet dismisses, our sheet calls `onClose()`

**JPEG export flow:**
Same pattern. Sheet stays open with spinner while each page is shared sequentially.

**Print option:**
A third option "Print" is added to the export sheet. Tapping it calls `Print.printAsync({ html })` using the same HTML generation as PDF but targeting the system print dialog directly. Sheet closes after print dialog appears.

---

## 2. Viewer Enhancements

### 2a. Thumbnail Strip
A horizontal scrollable strip of page thumbnails pinned to the bottom of the viewer screen, above the safe area. Each thumbnail is 56×72pt with a 2pt border (blue `#0a7ea4` when active, transparent when inactive). Tapping a thumbnail scrolls the main FlatList to that page via `scrollToIndex`. The strip auto-scrolls to keep the active thumbnail visible.

The page counter in the header is removed — the thumbnail strip replaces it.

### 2b. "Add Pages" Button
The thumbnail strip's last item (after all page thumbnails) is an "＋ Add Pages" button (same size as thumbnails, dashed border, grey). Tapping it:
1. Launches `DocumentScanner.scanDocument()`
2. On success, new pages are appended to `document.pages` starting at the next index
3. Files are saved via `appendPages()` in `lib/files.ts`
4. Document is updated in AsyncStorage
5. Viewer state re-renders with the new pages; thumbnail strip shows the new thumbnails

### 2c. Per-page "•••" Menu
A "•••" button in the top-right of the viewer header. Tapping it opens `PageActionsSheet` for the currently visible page. Contains: rotate left, rotate right, apply filter, delete page, share this page.

### 2d. Reorder Button
A "⇅ Reorder" text button in the viewer header (left of "•••"). Tapping opens `ReorderModal` — a fullscreen modal with a draggable list of page thumbnails. Each row has a thumbnail, page number, and drag handle on the right. Confirming saves the new page order.

---

## 3. Page Editing

### 3a. Rotate
`lib/image.ts` — `rotatePage(uri: string, direction: 'cw' | 'ccw'): Promise<string>`

Uses `expo-image-manipulator`:
- CW: `rotate: 90`
- CCW: `rotate: -90`

Saves result back to the same file path (overwrite). Returns the URI. Caller updates `document.pages[i]` and calls `updateDocument()`.

### 3b. Filters
`lib/image.ts` — `applyFilter(uri: string, filter: PageFilter): Promise<string>`

```ts
export type PageFilter = 'original' | 'grayscale' | 'bw' | 'enhanced';
```

- `original`: no-op, returns original URI unchanged
- `grayscale`: `ImageManipulator.manipulateAsync(uri, [], { format: SaveFormat.JPEG })` + grayscale option
- `bw`: grayscale + high contrast (manipulate with grayscale; if `expo-image-manipulator` does not expose contrast, apply grayscale only and label it B&W)
- `enhanced`: boost contrast/saturation via manipulator options; fallback to grayscale if not supported

Result saved back to the same file path. Caller updates document and AsyncStorage.

The `PageActionsSheet` shows a horizontal filter strip with four labeled tiles: Original · Grayscale · B&W · Enhanced. Tapping a non-Original tile applies the filter (shows an `ActivityIndicator` on the tile while processing). Original is always enabled. Once applied, the filter is permanent (not a display-only overlay) — the JPEG is overwritten.

### 3c. Delete Single Page
In `PageActionsSheet`, a "Delete Page" button (red). 

`lib/files.ts` — `deleteSinglePage(docId: string, pageIndex: number, totalPages: number): void`
- Deletes `page-{pageIndex}.jpg`
- Renames `page-{i}.jpg` → `page-{i-1}.jpg` for all i > pageIndex (to keep sequential naming)

Caller removes the URI from `document.pages`, calls `updateDocument()`. If this was the last page, calls `deleteDocument()` + `deleteDocumentFiles()` and closes the viewer.

### 3d. Reorder Pages
`ReorderModal` uses `react-native-draggable-flatlist`. Each row: thumbnail (56×72) + "Page N" label + drag handle icon.

On confirm:
`lib/files.ts` — `reorderPages(docId: string, newOrder: number[]): string[]`
- Copies files to a temp naming scheme (`page-tmp-{i}.jpg`) to avoid collisions
- Renames to final `page-{i}.jpg` order
- Returns new URIs array

Caller updates `document.pages` in state and AsyncStorage.

On cancel: no file changes.

---

## 4. Home Screen

### 4a. Search Bar
Below the "Scan Kit" title, a `TextInput` styled as a rounded search field (grey background, magnifying glass icon). Filters `documents` array in-state by `name.toLowerCase().includes(query)`. No debounce needed (client-side). Clears on unmount. Shows "No results for '…'" when filtered list is empty (not the full empty state).

### 4b. Sort
A sort icon button (↕) in the top-right of the header. Tapping opens `SortSheet` with three radio options:
- Date Added (default)
- Last Modified
- Name A–Z

Selection stored in AsyncStorage key `@scan_kit_sort`. `lib/storage.ts` exports `getSortPreference(): Promise<SortKey>` and `saveSortPreference(key: SortKey): Promise<void>`. Applied to the documents array before rendering.

### 4c. Multi-Select Mode
Multi-select mode is entered via the "Select" option in `DocActionsSheet` (see 4d). The tapped document is pre-selected when entering multi-select.

Once active:
- All cards show a circular checkbox overlay (empty circle / filled blue check)
- A bottom action bar slides up with "Delete (N)" and "Cancel"
- Tapping cards toggles selection
- "Delete (N)" shows a confirmation alert, then deletes all selected documents and their files, then exits multi-select
- "Cancel" exits multi-select (no changes)
- Tapping the FAB or navigating away also cancels multi-select

Multi-select mode is tracked in component state (`selectedIds: Set<string>`). When `selectedIds.size > 0`, the component is in multi-select mode. Long-press on a card while multi-select is active toggles that card's selection.

### 4d. Document Actions Sheet
Long-press on any card (when NOT in multi-select mode) opens `DocActionsSheet`. Options:

**Rename:** Dismisses DocActionsSheet, then opens `RenameSheet` (existing component, unchanged). `RenameSheet` is kept — it is not removed.

**Duplicate:** Creates a new document with name "Copy of {name}", copies all page files to a new docId directory, saves to AsyncStorage, refreshes the list.

**Merge with…:** Opens `MergeSheet` — a scrollable list of all other documents. Selecting one appends the selected doc's pages to the current doc (copy files, update pages array, update AsyncStorage). The source document is NOT deleted (user can delete it separately). The merged doc's `updatedAt` is updated.

**Select:** Dismisses DocActionsSheet, enters multi-select mode with this document pre-selected.

**Delete:** Alert confirmation → `deleteDocument` + `deleteDocumentFiles`. Same as today.

---

## 5. New & Modified Files Summary

### New files
| File | Responsibility |
|------|---------------|
| `lib/image.ts` | `rotatePage`, `applyFilter` via expo-image-manipulator |
| `components/page-actions-sheet.tsx` | Per-page: rotate, filter strip, delete, share |
| `components/thumbnail-strip.tsx` | Horizontal thumbnail strip + Add Pages button |
| `components/reorder-modal.tsx` | Fullscreen draggable page reorder |
| `components/sort-sheet.tsx` | Sort preference picker |
| `components/doc-actions-sheet.tsx` | Rename, Duplicate, Merge, Delete |
| `components/merge-sheet.tsx` | Document picker for merge |

### Modified files
| File | Changes |
|------|---------|
| `lib/files.ts` | Add `deleteSinglePage`, `replacePage`, `appendPages`, `reorderPages` |
| `lib/storage.ts` | Add `duplicateDocument`, `mergeDocuments`, `getSortPreference`, `saveSortPreference` |
| `components/export-sheet.tsx` | Fix spinner flow, add Print option |
| `app/viewer.tsx` | Add thumbnail strip, reorder button, •••  menu, add-more flow, hold doc in state |
| `app/index.tsx` | Add search, sort, multi-select, DocActionsSheet |

### Unchanged files
| File | Note |
|------|------|
| `components/rename-sheet.tsx` | Kept; opened from `DocActionsSheet` instead of directly from long-press |

### New packages
- `expo-image-manipulator` (Expo SDK 54 compatible)
- `react-native-draggable-flatlist`

---

## 6. Data Flow for Page Edits

All page edit operations (rotate, filter, delete, reorder, add-more) follow this pattern:
1. Perform file operation (lib/files.ts or lib/image.ts)
2. Build updated `Document` object (new pages array, new `updatedAt`)
3. Call `updateDocument(updated)` (AsyncStorage)
4. Set updated document in viewer component state → triggers re-render

The viewer holds `document` in local state (loaded once on mount). It does NOT re-query AsyncStorage after edits — it updates state directly. This keeps edits instant.

---

## 7. Edge Cases

- **Rotate/filter on a document with 1 page:** allowed; document still exists
- **Delete on a document with 1 page:** document is deleted, viewer closes with `router.back()`
- **Add more pages cancelled:** `scannedImages` is empty/undefined; no changes made
- **Merge with a doc that has the same name:** allowed; pages are appended, name unchanged
- **Sort preference missing from AsyncStorage:** defaults to Date Added
- **Reorder modal cancelled:** no file renames, no state changes
- **Filter "original" selected:** no-op, returns immediately without calling ImageManipulator

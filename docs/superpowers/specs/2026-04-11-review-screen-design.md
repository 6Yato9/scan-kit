# Post-Scan Review Screen — Design Spec
Date: 2026-04-11

## Overview

A full-screen review screen that appears after every scan (and import) before the document is saved. Replaces the current auto-save-on-scan behaviour. The user can rename the document, apply a filter per page, rotate/crop/delete individual pages, and add more pages before committing.

## Navigation

- Registered as `presentation: 'fullScreenModal'` in `app/_layout.tsx` (same pattern as `viewer`).
- `scan-context` sets `reviewVisible = true` after a scan completes. A `useEffect` in `app/(tabs)/_layout.tsx` watches `reviewVisible` and calls `router.push('/review')`.
- On **Done**: saves document → `clearPending()` → `router.replace('/(tabs)/files')`.
- On **× / Retake / back gesture**: `clearPending()` → `router.back()`.

## Screen Layout (top → bottom)

### ① Top Bar
- `×` dismiss button (left)
- `TextInput` pre-filled with `autoName()` result (e.g. `Scan 11-04-2026 17:30`), fully editable
- **Done ✓** button (right, accent colour). Disabled if title is empty.

### ② Page Pager
- Vertical `FlatList` with `snapToInterval` set to the measured item height.
- Each item renders the page image with its current filter applied as a React Native Image `style` prop (same CSS-filter approach used in the viewer).
- Focused page: full size, accent border. Adjacent pages: peeking at ≈35% scale with reduced opacity.
- `onViewableItemsChanged` with `itemVisiblePercentThreshold: 50` tracks `focusedIndex`.
- Page counter badge (e.g. `2 / 3`) in the bottom-right corner of the pager.

### ③ Filter Strip
- Horizontal `FlatList` of filter options: Original · Enhanced · Grayscale · B&W.
- Label above reads `FILTER — Page N` where N is `focusedIndex + 1`.
- Tapping a filter: `setFilters(prev => { const next = [...prev]; next[focusedIndex] = filter; return next; })`.
- Selected filter shown with accent border and coloured label.
- Filter thumbnails render a small version of the focused page image with the filter applied.

### ④ Action Row
Five actions, all targeting `focusedIndex`:

| Button | Behaviour |
|--------|-----------|
| Retake | `clearPending()` → `router.back()` → re-opens scanner after 350 ms |
| Rotate | Calls `rotatePage()` from `lib/image.ts`, shows spinner, replaces URI in local `pages` array |
| Crop | Re-launches `DocumentScanner.scanDocument()` to retake that page (one shot). If the user captures an image it replaces the current page's URI; if they cancel, the page is unchanged. |
| Delete | Removes page from local array. If 0 pages remain → `clearPending()` + `router.back()` |
| Add Page | Calls `appendPendingPages()` — re-triggers scanner, new pages appended |

## State (local to `review.tsx`)

```ts
const [pages, setPages]       = useState<string[]>(pendingPages)
const [filters, setFilters]   = useState<PageFilter[]>(
  pendingPages.map(() => pendingDefaultFilter as PageFilter)
)
const [name, setName]         = useState(autoName())
const [focusedIndex, setFocused] = useState(0)
const [rotating, setRotating] = useState(false)
```

PDF imports (`pendingPdfUri` set): show a single read-only preview with no filter strip. Title is editable; Done saves the PDF document. No other actions available.

## Save Logic

Moved entirely into `review.tsx` (out of `(tabs)/_layout.tsx`):

```ts
async function handleSave() {
  const id = Crypto.randomUUID()
  const now = Date.now()
  // copy pages with quality, apply filters array
  // call saveDocument(doc)
  // bumpLastSaved(), clearPending()
  // router.replace('/(tabs)/files')
}
```

## Context Changes (`scan-context.tsx`)

| Change | Detail |
|--------|--------|
| Rename `nameSheetVisible` → `reviewVisible` | Semantically accurate |
| Add `appendPendingPages(pages: string[])` | Appends new pages to `pendingPages` for Add Page action |

## Files Changed

| File | Type | Description |
|------|------|-------------|
| `app/review.tsx` | **New** | Full review screen |
| `app/_layout.tsx` | Modified | Add `Stack.Screen` for review as fullScreenModal |
| `app/(tabs)/_layout.tsx` | Modified | Replace auto-save `useEffect` with `router.push('/review')` |
| `contexts/scan-context.tsx` | Modified | Rename flag, add `appendPendingPages` |

## Edge Cases

| Scenario | Behaviour |
|----------|-----------|
| Delete last page | `clearPending()` + `router.back()` |
| Tap × or back gesture | `clearPending()` + `router.back()` |
| PDF import | Filter strip hidden; single read-only preview |
| Rotate while rotating | Button disabled during `rotating === true` |
| Empty title | Done button disabled |
| Add Page | Re-triggers scanner; if images captured they are appended and `focusedIndex` moves to first new page; if user cancels scanner, review screen stays unchanged |

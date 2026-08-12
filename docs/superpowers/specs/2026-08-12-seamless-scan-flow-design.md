# Seamless scan flow — design

Date: 2026-08-12

## Goal

Cut the scan→save flow to zero app-level taps, matching CamScanner: finish capturing
and you are looking at a saved, enhanced document. Refinement moves *after* the save
instead of gating it.

Secondary goal: make filters actually work on iOS. They are currently no-ops
(see "Why filters are baked" below), which makes an auto-applied default filter
meaningless without this fix.

## Flow

Before, after the final shutter press:

```
VisionKit "Keep Scan" → VisionKit "Save" → review screen "Done" → Files list
```

After:

```
VisionKit "Keep Scan" → VisionKit "Save" → viewer, open on the new document
```

The two VisionKit taps stay — they are the system scanner's own UI (crop confirm and
batch finish). The app contributes none.

On Save the app writes the pages with the default filter baked in, titles the document
with `autoName()`, and opens the viewer on it.

Multi-page needs no special handling: VisionKit batches natively, so three shutter
presses produce one three-page document.

## Retiring the review screen

`app/review.tsx` (552 lines) is deleted. It duplicated work VisionKit already does
(crop confirmation, multi-page batching) and gated the save behind a naming step whose
value was already auto-generated.

Five entry points currently route through it, and all five switch to auto-save:

| Entry point | Call |
|---|---|
| Scan | `contexts/scan-context.tsx` `triggerScan` |
| Import Images | `app/(tabs)/files.tsx` `openImport` |
| Import PDF | `app/(tabs)/files.tsx` `openPdfImport` |
| Book tool | `app/tools/book.tsx` |
| Whiteboard tool | `app/tools/whiteboard.tsx` |

Consequences:

- `ScanContext` loses `pendingPages`, `pendingPdfUri`, `pendingQuality`,
  `pendingDefaultFilter`, `reviewVisible`, `clearPending`, and the pending-state
  persistence effects. With nothing pending, there is no in-progress state to restore
  across backgrounding. `PendingState` and its storage helpers go too.
- The `reviewVisible` → `router.push('/review')` effect in `app/(tabs)/_layout.tsx`
  is removed.

### Capabilities that must move first

Retiring review would otherwise strand the user in a document they cannot rename or crop.

| Capability | Today | Becomes |
|---|---|---|
| Rename | Review's title field; `RenameSheet` reachable only from the Files list | Tap the title in the viewer header, opening the existing `RenameSheet` |
| Crop | Review's `CropModal` — its only consumer | A Crop action in `page-actions-sheet`, beside Rotate, opening the existing `CropModal` |

Retake is dropped. VisionKit has Retake built into capture, and after auto-save a bad
scan is one Delete away.

## Filter model

### Why filters are baked

React Native 0.81's iOS filter implementation
(`React/Fabric/Mounting/ComponentViews/View/RCTViewComponentView.mm`, the `// filter`
block) handles only `FilterType::Brightness` and `FilterType::Opacity`. Every other
primitive is silently dropped. So `grayscale`, `contrast` and `saturate` do nothing on
iOS, which makes Grayscale, B&W and Enhanced all no-ops on screen, and disables two of
the three Adjust sliders.

This is a platform gap, not a usage error — an earlier fix that switched from a CSS
string to the array form could not have worked, because the array parses fine and iOS
drops the primitives regardless.

### The model

Chosen approach: bake at capture, keep the original alongside.

- `page-N.jpg` — the **displayed** image, with filter and adjustments already in the pixels.
- `page-N.orig.jpg` — the pristine source, created immediately before the first bake of
  that page by copying the then-current `page-N.jpg`.
- Changing a filter or adjustment re-derives `page-N.jpg` from `page-N.orig.jpg`, so
  changes never compound JPEG loss and Enhanced→Original is always possible.

`document.filters` and `document.adjustments` stop being render instructions. They become
a **record of what is already baked into the pixels**, used only to show the current
selection in the picker and to re-derive from `.orig`.

Pages with no filter and default adjustments need no `.orig`, so unfiltered imports do
not pay the storage cost.

### The double-apply trap

Because pixels are pre-baked, nothing may re-apply the filter. Every existing consumer
must stop:

CSS consumers (would double-filter exports):
- `lib/pdf.ts` — `generatePdf`, `generateSearchablePdf`
- `components/export-sheet.tsx` (ZIP)
- `app/tools/watermark.tsx`, `app/tools/timestamp.tsx`, `app/tools/sign.tsx`

RN style consumers (now redundant):
- `app/viewer.tsx`, `components/page-actions-sheet.tsx`,
  `components/reorder-modal.tsx`, `components/thumbnail-strip.tsx`

`page-actions-sheet` is the one exception worth noting: its filter *preview tiles* must
show what a filter would look like before it is applied. Those tiles render from `.orig`
through a baked preview, not from the live style prop.

`combinedFilterCss` is retained for these previews and for any future HTML rendering;
`combinedFilterRN` becomes unused and is removed.

## Defaults

`DEFAULT_SCAN_SETTINGS.defaultFilter` changes from `'original'` to `'enhanced'`, so
scans look like scans without the user choosing anything. The Scan Settings screen
already exposes this control, so it remains changeable.

## Migration

Existing documents store unfiltered pixels and rely on render-time filtering. Once
render-time filtering is removed they would silently appear unfiltered.

Bump `@scan_kit_schema_version` from 2 to 3. For each document with a non-original
filter or non-default adjustment on a page: copy `page-N.jpg` → `page-N.orig.jpg`, then
bake the recorded filter and adjustments into `page-N.jpg`. Documents with no filters
are untouched and gain no `.orig`.

The migration runs through the existing memoized migration path in `lib/storage.ts` and
must be idempotent — a page that already has `.orig` is skipped.

## How baking actually works

`expo-image-manipulator` cannot do this. Its `Action` union is
`ActionResize | ActionRotate | ActionFlip | ActionCrop | ActionExtent` — geometry only,
no colour operations. An earlier draft of this spec assumed the filter could ride along
in the existing manipulate pass; that is not possible.

The mechanism is instead the pipeline `app/annotate.tsx` already uses: a WebView loads
the page over `file://`, draws it to an offscreen canvas at natural resolution, and
returns `canvas.toDataURL('image/jpeg', 0.92)` via `postMessage`, which RN writes to
disk. Baking a filter is that same pipeline with `ctx.filter` set before `drawImage`.

This reuses the CSS strings `combinedFilterCss` already produces, so on-screen pixels
and PDF export share one filter definition.

### Baking is deferred, not synchronous

A WebView round-trip per page is too slow to sit on the scan path. So the save is never
blocked on it:

1. Scan saves immediately with raw pixels; the viewer opens at once.
2. Baking runs per page in the background and swaps each page file, mirroring the
   fire-and-forget OCR indexing already in `handleSave`.
3. The viewer's existing `?v=${updatedAt}` cache-bust makes the enhanced page appear
   with no new refresh machinery.

`document.filters[i]` is written **only after** page `i` bakes successfully. Until then
the document is honestly unfiltered — pixels and metadata agree — so an export that
races the bake yields unenhanced output rather than wrong output, and double-application
stays impossible.

## Error handling

- If baking a page fails, the page keeps its raw pixels and `filters[i]` is left unset.
  The scan is already saved; a failed enhancement must never cost the user the scan.
- Baking is re-entrant: a page whose `filters[i]` is already set is skipped, so an
  interrupted bake resumes safely on the next attempt.
- If re-deriving from `.orig` fails on a filter change, the current `page-N.jpg` is left
  untouched and the change is reported, matching how `replacePage` already behaves.
- Save failure keeps the existing behaviour in `handleSave`: delete partial files for
  that document id, surface the error. That logic moves to the auto-save path.
- Migration is wrapped per-document so one bad document cannot abort the sweep, matching
  `garbageCollectOrphans`.

## Testing

Existing suites cover `lib/` only; these changes are concentrated there, which is
favourable.

- `__tests__/filters.test.ts` — assert `combinedFilterRN` is gone and that
  `combinedFilterCss` still produces the exact strings the bake canvas depends on.
- `__tests__/files.test.ts` — `.orig` is created on first filter application and not
  before; re-derivation reads from `.orig`; idempotency when `.orig` already exists.
- `__tests__/storage.test.ts` — v2→v3 migration bakes only documents with recorded
  filters, is idempotent, and survives a single corrupt document.
- `__tests__/pdf.test.ts` — assert generated HTML carries **no** `filter:` style, guarding
  the double-apply regression.

Screen-level behaviour (auto-save landing in the viewer) stays manual, consistent with
the current absence of screen tests.

## Out of scope

- Adding screen-level test coverage.
- Reworking the tools that consume documents beyond removing their filter re-application.
- The ML Kit arm64 simulator constraint, which is a vendor limitation and unrelated.

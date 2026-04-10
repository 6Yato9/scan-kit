# Scan Kit — Design Spec
**Date:** 2026-04-10  
**Status:** Approved

---

## Overview

Scan Kit is a simple, focused document scanner app for iOS and Android built with Expo. It mirrors the core CamScanner experience: scan single or multiple pages, save them persistently on-device, and export as PDF or JPEG. The UI is a single home screen with modal overlays — no tabs, no complexity.

---

## Screens & Navigation

One route: `/` (home). The existing tab structure is replaced entirely.

```
Home Screen (/)
├── [Modal] Scanner Flow       — react-native-document-scanner-plugin
│     └── Name Prompt Sheet    — editable name, auto-filled, confirm to save
├── [Modal] Document Viewer    — full-screen page previews with swipe
│     └── [Sheet] Export       — PDF / JPEG / Share options
└── [Inline] Rename            — long-press context menu on grid card
```

**Home screen layout:**
- Header: "Scan Kit" title
- Grid: 2-column thumbnail cards showing preview image, document name, page count, and date
- FAB (floating action button) bottom-center: primary scan button, always visible
- Empty state: illustration + "Tap to scan your first document"

---

## Data Model

```ts
type Document = {
  id: string       // uuid
  name: string     // user-editable, default: "Scan Apr 10, 2026"
  pages: string[]  // array of local file URIs (JPEG)
  createdAt: number
  updatedAt: number
}
```

---

## Storage

- **Page images:** saved to `FileSystem.documentDirectory` via `expo-file-system` — survives app restarts
- **Document metadata:** stored in `AsyncStorage` as a JSON array — simple, no SQLite needed at this scale
- **On delete:** remove metadata entry + delete all page image files from disk
- **PDFs:** generated on-demand and saved to cache dir for sharing only, not persisted

---

## Scanner Flow

**Plugin:** `react-native-document-scanner-plugin`
- Handles camera, auto edge detection, and perspective crop natively
- Returns an array of cropped JPEG URIs

**Single scan:** captures one page → name prompt sheet

**Batch scan:** user scans multiple pages in one session, taps "Done" → name prompt sheet with page count shown

**Name prompt (bottom sheet):**
- Pre-filled with date-based auto-name: `"Scan Apr 10, 2026"`
- Single editable text input, keyboard auto-focuses
- Page count shown: e.g. `"3 pages scanned"`
- "Save" confirms and returns to grid; "Retake" discards and reopens scanner

---

## Document Viewer

- Opens as a full-screen modal from the home grid
- Horizontal swipe between pages (`FlatList` with `pagingEnabled`)
- Page counter in header: `"2 / 3"`
- Export button in header → bottom sheet

---

## Export

All exports go through the system share sheet (`expo-sharing`):

| Format | Behavior |
|--------|----------|
| PDF | All pages combined into a single multi-page PDF via `expo-print` |
| JPEG | Individual page images shared one at a time via share sheet (use PDF for multi-page export) |
| Share | System share sheet — AirDrop, Messages, email, etc. |

---

## Rename

- Long-press a grid card → context menu: "Rename" / "Delete"
- Rename opens a bottom sheet with the editable name field (same style as name prompt)
- Also accessible via a `···` menu icon on each card

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `react-native-document-scanner-plugin` | Camera + edge detection + crop |
| `expo-file-system` | Save/delete image files on device |
| `@react-native-async-storage/async-storage` | Persist document metadata |
| `expo-print` | Generate multi-page PDFs from JPEG URIs |
| `expo-sharing` | System share sheet |
| `expo-crypto` | Generate document UUIDs (already in Expo ecosystem) |

---

## Out of Scope

- Cloud sync / backup
- OCR / text recognition
- Filters / color modes (beyond what the scanner plugin provides)
- Folders / organization
- Password protection

# Scan Kit UI guidelines

The app must read as a polished, professional product. These rules are not optional.

## Never
- No emoji, and no unicode symbols used as icons (✓ ✕ ☰ › → • ★ ⚠ …). Typographic
  characters inside sentences (… — –) are fine.
- No text standing in for an icon ("Rotate L", "X", "HD" pills used as icons).
- No hard-coded colours. Every colour comes from `useTheme().colors`.
- No raw `err.message`, stack text, file paths or developer wording shown to users.
- No `Alert.alert('Error', …)` titles and no OK-to-dismiss success alerts — use the
  toast (`useToast`) for success and a specific, human error title for failures.

## Icons
- Ionicons (`@expo/vector-icons`). Outline style by default; filled only for
  the active tab or a selected state. The only exceptions are the few glyphs
  Ionicons lacks or draws at a different weight — the signature (Sign), the
  pencil (Rename) and the split tall page (Long image): render them with
  Apple's SF Symbols via `components/app-icon.tsx`, which falls back to an
  Ionicon off iOS. Text recognition is `reader-outline` everywhere.
- One glyph per action across the app: share `share-outline`, copy `copy-outline`,
  delete `trash-outline`, more `ellipsis-horizontal`, selected `checkmark`,
  back `chevron-back`, close `close`, add `add`.

## Building blocks (use these, don't hand-roll)
- `components/screen-header.tsx` — `ScreenHeader`, `HeaderIconButton`,
  `HeaderTextButton`. Pushed screens use the chevron back; modals use close.
- `components/primary-button.tsx` — `PrimaryButton` (primary / secondary /
  destructive). Keep it mounted and pass `disabled`; never render it conditionally.
- `components/section-label.tsx` — caps label above a group.
- `components/bottom-sheet.tsx` — every sheet.
- `components/empty-state.tsx` — every empty list, with an action where one makes sense.

## Tokens (`lib/theme.ts`)
- `Spacing` (4-pt scale, `gutter` 16 for screen edges), `Radius`, `Type`, `HIT` (44).
- Filled buttons: `colors.accentFill` background with `colors.onAccent` text.
  `colors.accent` is for tinted text and icons only.
- The viewer, annotate and crop screens are always dark: use `colors.chrome*`.

## Copy
- Sentence case everywhere ("Export document", "Move to folder"), American spelling.
- Errors say what happened and what to do: "Couldn't create PDF. Try again with fewer pages."

## Touch and accessibility
- Every hit target ≥ 44×44 (use `hitSlop` for small glyphs).
- Every icon-only button has an `accessibilityLabel`.

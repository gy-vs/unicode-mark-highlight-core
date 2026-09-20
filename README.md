# Unicode search core

TypeScript library for normalized text matching with grapheme-aware highlights.

- Source text is segmented into grapheme clusters (`Intl.Segmenter`); each folded
  output code unit records the source grapheme that produced it, so matches on
  diacritic-stripped text expand back to whole grapheme boundaries (post-base and
  prepended combining marks, emoji skin-tone modifiers, variation selectors, ZWJ).
- Mark-only queries (e.g. a combining acute or `🏽`) match graphemes carrying those
  attachments in order.
- Multiple queries keep their identity (`queryId`); hits from different queries are
  never merged. Same-query overlaps merge only when the strategy allows
  (`none` / `overlap` / `adjacent`).
- Results are returned in logical text order; rendering direction (RTL included)
  never participates in range ordering.
- `clipExcerpt` snaps a window outward to grapheme boundaries and re-bases every
  range relative to the clip start; absolute ranges are never returned.

Run `npm install`, then `npm test` and `npm run build`.

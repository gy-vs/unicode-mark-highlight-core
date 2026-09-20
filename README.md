# Unicode search core

TypeScript library for normalized text matching with grapheme-accurate highlights.

- `createSearchIndex(text)` builds the search representation: the text is
  segmented into graphemes, each grapheme is normalized (NFD, marks stripped,
  lowercased), and every code unit of the normalized string records which
  original grapheme it came from.
- `findMatches(text, query)` / `findMatchesIn(index, query)` return half-open
  ranges into the *original* text. Hits are expanded to full grapheme
  boundaries, so trailing/leading combining marks, emoji modifiers and ZWJ
  sequences are never left outside the highlight. Mark-only queries (e.g. a
  lone combining accent) fall back to a mark-preserving channel.
- `search(text, queries, { merge })` runs several queries at once and tags
  every hit with its query identity. Overlapping or adjacent hits from
  different queries are always preserved; ranges merge only when they come
  from the same query *and* `merge: 'same-query'` is set. Results are sorted
  in logical text order — rendering direction (RTL/LTR) never affects range
  ordering.
- `cropSnippet(text, matches, { maxLength, context })` crops a snippet around
  the first match without splitting graphemes, clips the visible matches to
  the window and re-bases every range to the crop start (callers never
  receive absolute offsets).

Run `npm install`, then `npm test` and `npm run build`.

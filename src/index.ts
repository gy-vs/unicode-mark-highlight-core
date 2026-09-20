/**
 * Unicode-aware search core.
 *
 * The search representation records, for every code unit of the normalized
 * search string, which grapheme of the original text it came from. Hits found
 * in normalized space are mapped back through that table and expanded to full
 * grapheme boundaries, so a highlight always covers whole user-perceived
 * characters: base letters plus their combining marks, emoji modifiers and
 * ZWJ sequences.
 *
 * All ranges are half-open [start, end) UTF-16 code-unit offsets into the
 * original text, returned in logical text order. Rendering direction
 * (RTL/LTR) never participates in range ordering.
 */

/** Half-open range [start, end) of UTF-16 code-unit offsets into the original text. */
export type Match = { start: number; end: number };

/** A match tagged with the identity of the query that produced it. */
export type QueryMatch = Match & { queryIndex: number; query: string };

/**
 * Merge policy for overlapping or adjacent hits. Hits keep their query
 * identity: ranges from different queries are never merged, and same-query
 * ranges merge only under 'same-query'.
 */
export type MergeStrategy = 'preserve' | 'same-query';

export type SearchOptions = { merge?: MergeStrategy };

/**
 * Diacritic-insensitive, case-folded form of `value` (NFD, marks removed,
 * lowercased). Locale-independent on purpose so matching is deterministic.
 */
export function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Case-folded NFD form that keeps combining marks; used for mark-only queries. */
function normalizeWithMarks(value: string): string {
  return value.normalize('NFD').toLowerCase();
}

interface Channel {
  /** Normalized string that is actually searched. */
  normalized: string;
  /** Source grapheme index for every code unit of `normalized`. */
  units: number[];
}

/**
 * Search representation of a text: per-grapheme normalized channels plus the
 * table mapping each output unit back to its source grapheme.
 */
export interface SearchIndex {
  text: string;
  /** Grapheme start offsets (UTF-16 code units) in `text`. */
  graphemeStart: number[];
  /** Grapheme end offsets (UTF-16 code units) in `text`. */
  graphemeEnd: number[];
  /** Diacritic-insensitive channel. */
  stripped: Channel;
  /** Mark-preserving channel, used when a query normalizes to only marks. */
  marked: Channel;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Builds the search representation for `text`. */
export function createSearchIndex(text: string): SearchIndex {
  const graphemeStart: number[] = [];
  const graphemeEnd: number[] = [];
  const strippedUnits: number[] = [];
  const markedUnits: number[] = [];
  const strippedParts: string[] = [];
  const markedParts: string[] = [];
  let offset = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const grapheme = graphemeStart.length;
    graphemeStart.push(offset);
    offset += segment.length;
    graphemeEnd.push(offset);
    const stripped = normalizeText(segment);
    strippedParts.push(stripped);
    for (let i = 0; i < stripped.length; i++) strippedUnits.push(grapheme);
    const marked = normalizeWithMarks(segment);
    markedParts.push(marked);
    for (let i = 0; i < marked.length; i++) markedUnits.push(grapheme);
  }
  return {
    text,
    graphemeStart,
    graphemeEnd,
    stripped: { normalized: strippedParts.join(''), units: strippedUnits },
    marked: { normalized: markedParts.join(''), units: markedUnits },
  };
}

function findInChannel(index: SearchIndex, channel: Channel, needle: string): Match[] {
  const out: Match[] = [];
  if (!needle) return out;
  let at = 0;
  while ((at = channel.normalized.indexOf(needle, at)) >= 0) {
    const first = channel.units[at];
    const last = channel.units[at + needle.length - 1];
    // Expand the hit to full grapheme boundaries so leading/trailing
    // combining marks, emoji modifiers and ZWJ sequences stay inside.
    out.push({ start: index.graphemeStart[first], end: index.graphemeEnd[last] });
    at += needle.length;
  }
  return out;
}

/** Finds `query` in a previously built search index. */
export function findMatchesIn(index: SearchIndex, query: string): Match[] {
  const strippedNeedle = normalizeText(query);
  if (strippedNeedle) return findInChannel(index, index.stripped, strippedNeedle);
  // Mark-only query (e.g. a lone combining accent): nothing survives mark
  // stripping, so search the mark-preserving channel instead.
  const markedNeedle = normalizeWithMarks(query);
  if (markedNeedle) return findInChannel(index, index.marked, markedNeedle);
  return [];
}

/** Finds `query` in `text`; ranges refer to the original text. */
export function findMatches(text: string, query: string): Match[] {
  return findMatchesIn(createSearchIndex(text), query);
}

function compareRanges(a: Match, b: Match): number {
  return a.start - b.start || a.end - b.end;
}

/**
 * Runs several queries over `text` (or a reused index) and returns every hit
 * tagged with its query identity. Overlapping or adjacent hits from different
 * queries are preserved; same-query hits merge only with
 * `merge: 'same-query'`. Results are sorted by logical text order only —
 * rendering direction never affects range ordering.
 */
export function search(
  text: string | SearchIndex,
  queries: readonly string[],
  options: SearchOptions = {},
): QueryMatch[] {
  const index = typeof text === 'string' ? createSearchIndex(text) : text;
  let hits: QueryMatch[] = [];
  queries.forEach((query, queryIndex) => {
    for (const match of findMatchesIn(index, query)) {
      hits.push({ ...match, queryIndex, query });
    }
  });
  if ((options.merge ?? 'preserve') === 'same-query') hits = mergeSameQuery(hits);
  hits.sort((a, b) => compareRanges(a, b) || a.queryIndex - b.queryIndex);
  return hits;
}

/** Merges overlapping or adjacent hits, but only within the same query. */
function mergeSameQuery(hits: QueryMatch[]): QueryMatch[] {
  const byQuery = new Map<number, QueryMatch[]>();
  for (const hit of hits) {
    const list = byQuery.get(hit.queryIndex);
    if (list) list.push(hit);
    else byQuery.set(hit.queryIndex, [hit]);
  }
  const merged: QueryMatch[] = [];
  for (const list of byQuery.values()) {
    list.sort(compareRanges);
    let current: QueryMatch | undefined;
    for (const hit of list) {
      if (current && hit.start <= current.end) {
        current.end = Math.max(current.end, hit.end);
      } else {
        current = { ...hit };
        merged.push(current);
      }
    }
  }
  return merged;
}

export type SnippetOptions = {
  /** Maximum snippet length in code units. Default 160. */
  maxLength?: number;
  /** Context to keep around the focused match, in code units. Default 20. */
  context?: number;
};

export type Snippet<M extends Match = Match> = {
  /** Cropped text. */
  text: string;
  /** Offset in the original text where the snippet starts. */
  start: number;
  /** Offset in the original text where the snippet ends. */
  end: number;
  /** Match ranges re-based to the snippet start — never absolute offsets. */
  matches: M[];
};

/** Grapheme boundary offsets of `text`, ascending, starting at 0. */
function graphemeBounds(text: string): number[] {
  const bounds = [0];
  for (const { segment } of graphemeSegmenter.segment(text)) {
    bounds.push(bounds[bounds.length - 1] + segment.length);
  }
  return bounds;
}

/**
 * Crops a snippet around the first match and re-bases every visible match
 * range to the crop start. The window is expanded outward to grapheme
 * boundaries (so it may slightly exceed `maxLength`) and matches are clipped
 * to it; callers only ever receive ranges relative to `snippet.text`.
 */
export function cropSnippet<M extends Match>(
  text: string,
  matches: readonly M[],
  options: SnippetOptions = {},
): Snippet<M> {
  const maxLength = Math.max(1, options.maxLength ?? 160);
  const context = Math.max(0, options.context ?? 20);
  const sorted = [...matches].sort(compareRanges);
  const focus = sorted[0];

  let start = 0;
  let end = Math.min(text.length, maxLength);
  if (focus) {
    start = Math.max(0, focus.start - context);
    end = Math.min(text.length, focus.end + context);
    if (end - start > maxLength) {
      const focusLength = focus.end - focus.start;
      if (focusLength >= maxLength) {
        start = focus.start;
        end = focus.start + maxLength;
      } else {
        const spare = maxLength - focusLength;
        start = focus.start - Math.floor(spare / 2);
        end = start + maxLength;
        if (start < 0) {
          end -= start;
          start = 0;
        }
        if (end > text.length) {
          start = Math.max(0, start - (end - text.length));
          end = text.length;
        }
      }
    }
  }

  // Never cut through a grapheme: expand the window to cluster boundaries.
  const bounds = graphemeBounds(text);
  let snappedStart = 0;
  for (const bound of bounds) {
    if (bound <= start) snappedStart = bound;
    else break;
  }
  start = snappedStart;
  for (const bound of bounds) {
    if (bound >= end) {
      end = bound;
      break;
    }
  }

  const rebased: M[] = [];
  for (const match of sorted) {
    const s = Math.max(match.start, start);
    const e = Math.min(match.end, end);
    if (e <= s) continue;
    // Re-base to the crop start; absolute ranges must not leak to callers.
    rebased.push({ ...match, start: s - start, end: e - start } as M);
  }
  return { text: text.slice(start, end), start, end, matches: rebased };
}

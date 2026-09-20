/**
 * Unicode-aware search core.
 *
 * The original text is segmented into grapheme clusters. Each cluster is folded
 * independently into a `core` string (base letters, lower-cased) plus the list
 * of combining attachments that were stripped from it (post-base marks,
 * prepended concatenation marks, emoji modifiers, variation selectors, ZWJ and
 * tag characters). Every code unit of the folded haystack remembers which
 * source grapheme produced it, so a match on folded letters can be expanded
 * back to whole grapheme cluster boundaries: the combining marks following the
 * base letters are never left outside the highlighted range.
 */

export type Match = { start: number; end: number };

export type QueryId = string | number;
export type MergeStrategy = 'none' | 'overlap' | 'adjacent';

export type Query = {
  id?: QueryId;
  text: string;
};

export type Hit = Match & {
  queryId?: QueryId;
};

export type SearchOptions = {
  /**
   * When hits produced by the *same* query are merged:
   * - 'none'     : every occurrence is kept (default)
   * - 'overlap'  : overlapping occurrences merge into one
   * - 'adjacent' : touching or overlapping occurrences merge into one
   *
   * Hits belonging to different queries are never merged, even if their
   * ranges overlap or are identical.
   */
  merge?: MergeStrategy;
};

export type Excerpt = {
  text: string;
  /** Absolute UTF-16 offset of `text` inside the source. */
  offset: number;
  /** Hits re-based to offsets inside `text`; logical text order. */
  hits: Hit[];
};

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Code points that act like combining attachments but are not `\p{M}`. */

const SKIN_TONE_MODIFIER = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const VARIATION_SELECTOR = (cp: number) =>
  (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
const TAG_CHARACTER = (cp: number) => cp >= 0xe0020 && cp <= 0xe007f;
const ZWJ = 0x200d;

/**
 * Grapheme_Cluster_Break=Prepend characters (e.g. Arabic number sign U+0600)
 * are not marks (\p{M}), yet they attach to the *following* base character in
 * a single grapheme cluster — the "prepended combining mark" case. The regexp
 * property escape for Prepended_Concatenation_Mark is not available in V8, so
 * detect the behaviour through the segmenter: a prepend character followed by
 * `a` stays one cluster, while a base character or an Extend breaks.
 */
const prependCache = new Map<number, boolean>();
function isPrependLike(cp: number): boolean {
  const cached = prependCache.get(cp);
  if (cached !== undefined) return cached;
  const ch = String.fromCodePoint(cp);
  const segments = [...segmenter.segment(ch + 'a')];
  const result = !/\p{M}/u.test(ch) && segments.length === 1 && segments[0]!.segment === ch + 'a';
  prependCache.set(cp, result);
  return result;
}

/** Classify a code point of an NFD-decomposed grapheme cluster. */
function classify(cp: number): 'core' | 'attachment' {
  if (/\p{M}/u.test(String.fromCodePoint(cp))) return 'attachment';
  if (isPrependLike(cp)) return 'attachment';
  if (SKIN_TONE_MODIFIER(cp) || VARIATION_SELECTOR(cp) || TAG_CHARACTER(cp) || cp === ZWJ) {
    return 'attachment';
  }
  return 'core';
}

type Grapheme = {
  /** Source UTF-16 span of the cluster in the original text. */
  start: number;
  end: number;
  /** Folded base letters (lower-cased). */
  core: string;
  /** Stripped code points, in original order (prepend marks first, post-base last). */
  attachments: number[];
};

type FoldModel = {
  graphemes: Grapheme[];
  /** Folded haystack formed by concatenating every grapheme's core. */
  folded: string;
  /** Source grapheme index that produced each folded code unit. */
  unitOwner: number[];
};

function buildFoldModel(text: string): FoldModel {
  const graphemes: Grapheme[] = [];
  let folded = '';
  const unitOwner: number[] = [];

  for (const seg of segmenter.segment(text)) {
    const cluster = seg.segment;
    const start = seg.index;
    const end = start + cluster.length;
    let core = '';
    const attachments: number[] = [];

    for (const ch of cluster.normalize('NFD')) {
      const cp = ch.codePointAt(0)!;
      if (classify(cp) === 'attachment') {
        attachments.push(cp);
      } else {
        core += ch.toLocaleLowerCase();
      }
    }

    const gi = graphemes.length;
    // One owner per UTF-16 code unit so astral base letters stay aligned.
    for (let k = 0; k < core.length; k += 1) unitOwner.push(gi);
    folded += core;
    graphemes.push({ start, end, core, attachments });
  }

  return { graphemes, folded, unitOwner };
}

/** Fold a query independently of grapheme boundaries (marks float to attachments). */
function splitFold(query: string): { core: string; attachments: number[] } {
  let core = '';
  const attachments: number[] = [];
  for (const ch of query.normalize('NFD')) {
    const cp = ch.codePointAt(0)!;
    if (classify(cp) === 'attachment') attachments.push(cp);
    else core += ch.toLocaleLowerCase();
  }
  return { core, attachments };
}

/** True when `needle` code points occur in `haystack` in order. */
function isSubsequence(needle: number[], haystack: number[]): boolean {
  if (needle.length === 0) return false;
  let j = 0;
  for (const cp of haystack) {
    if (cp === needle[j]) {
      j += 1;
      if (j === needle.length) return true;
    }
  }
  return false;
}

/** Map one folded occurrence [foldStart, foldEnd) to full grapheme spans. */
function occurrenceToHits(model: FoldModel, foldStart: number, foldEnd: number, queryId: QueryId | undefined): Hit[] {
  const { graphemes, unitOwner, folded } = model;
  // Clamp onto code-unit boundaries so an astral base letter cannot be split.
  const startUnit = foldStart < folded.length && isTrailSurrogate(folded.charCodeAt(foldStart)) ? foldStart + 1 : foldStart;
  const endUnit = foldEnd > 0 && isLeadSurrogate(folded.charCodeAt(foldEnd - 1)) ? foldEnd - 1 : foldEnd;
  if (endUnit <= startUnit) return [];

  const first = unitOwner[startUnit]!;
  const last = unitOwner[endUnit - 1]!;
  return [{ start: graphemes[first]!.start, end: graphemes[last]!.end, queryId }];
}

const isLeadSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isTrailSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Raw, unmerged occurrences of a single query in a folded model. */
function rawHits(model: FoldModel, core: string, attachments: number[], queryId: QueryId | undefined): Hit[] {
  const hits: Hit[] = [];

  if (core.length > 0) {
    // Overlapping occurrences are all collected; merging is a separate policy.
    let at = 0;
    while (at <= model.folded.length - core.length) {
      const found = model.folded.indexOf(core, at);
      if (found < 0) break;
      hits.push(...occurrenceToHits(model, found, found + core.length, queryId));
      at = found + 1;
    }
    return hits;
  }

  // Mark-only query: match whole graphemes carrying those attachments in order.
  if (attachments.length > 0) {
    for (const g of model.graphemes) {
      if (isSubsequence(attachments, g.attachments)) {
        hits.push({ start: g.start, end: g.end, queryId });
      }
    }
  }
  return hits;
}

/** Merge hits belonging to one query according to the strategy. */
function mergeHits(hits: Hit[], strategy: MergeStrategy): Hit[] {
  if (strategy === 'none' || hits.length < 2) return hits;
  const sorted = [...hits].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Hit[] = [];
  for (const hit of sorted) {
    const prev = merged[merged.length - 1];
    const touch = prev !== undefined &&
      (strategy === 'adjacent' ? hit.start <= prev.end : hit.start < prev.end);
    if (prev && touch) {
      prev.end = Math.max(prev.end, hit.end);
    } else {
      merged.push({ ...hit });
    }
  }
  return merged;
}

/** Logical text order; rendering direction never participates in ordering. */
function sortLogical(hits: Hit[], queryOrder: Map<QueryId | undefined, number>): Hit[] {
  return [...hits].sort(
    (a, b) =>
      a.start - b.start ||
      a.end - b.end ||
      (queryOrder.get(a.queryId) ?? 0) - (queryOrder.get(b.queryId) ?? 0),
  );
}

/**
 * Search one or more queries against `text`.
 *
 * Hits are returned in logical text order (start offset, then end offset),
 * regardless of the rendering direction (LTR/RTL). Each hit keeps the identity
 * of the query that produced it; hits from distinct queries are never merged.
 */
export function searchHits(text: string, queries: Query | Query[], options: SearchOptions = {}): Hit[] {
  const list = Array.isArray(queries) ? queries : [queries];
  const strategy = options.merge ?? 'none';
  const model = buildFoldModel(text);
  const queryOrder = new Map<QueryId | undefined, number>();

  const groups: Hit[][] = list.map((q, index) => {
    const queryId = q.id ?? (list.length === 1 ? undefined : index);
    queryOrder.set(queryId, index);
    const { core, attachments } = splitFold(q.text);
    return mergeHits(rawHits(model, core, attachments, queryId), strategy);
  });

  return sortLogical(groups.flat(), queryOrder);
}

/**
 * Backwards-compatible single-query API, now grapheme-boundary aware:
 * combining marks before or after the matched base letters stay inside the
 * returned ranges, and results are always in logical text order.
 */
export function findMatches(text: string, query: string): Match[] {
  return searchHits(text, { text: query }, { merge: 'none' }).map(({ start, end }) => ({ start, end }));
}

/** Folded representation used by the matcher (base letters only, lower-cased). */
export function normalizeText(value: string): string {
  return buildFoldModel(value).folded;
}

/**
 * Clip an excerpt around `[clipStart, clipEnd)` (absolute UTF-16 offsets into
 * `text`). The window is snapped outward to grapheme cluster boundaries, and
 * every returned hit is re-based to the excerpt start — absolute ranges are
 * never handed to the caller. Hits fully outside the window are dropped; hits
 * crossing an edge are clamped to the clipped text.
 */
export function clipExcerpt(text: string, hits: Hit[], clipStart: number, clipEnd: number): Excerpt {
  if (text.length === 0) return { text: '', offset: 0, hits: [] };
  const boundaries = [...segmenter.segment(text)].map((seg) => seg.index);
  const start = Math.min(text.length, Math.max(0, clipStart));
  const end = Math.min(text.length, Math.max(start, clipEnd));

  // Grapheme boundary at or before `offset` (0 when offset is at the start).
  const snapStart = (offset: number): number => {
    let result = 0;
    for (const b of boundaries) {
      if (b <= offset) result = b;
      else break;
    }
    return result;
  };
  // Grapheme boundary at or after `offset` (text end when past the last cluster).
  const snapEnd = (offset: number): number => {
    for (const b of boundaries) {
      if (b >= offset) return b;
    }
    return text.length;
  };

  const windowStart = snapStart(start);
  const windowEnd = snapEnd(end);

  const clipped: Hit[] = sortLogical(
    hits
      .map((hit) => {
        const relStart = Math.max(hit.start, windowStart) - windowStart;
        const relEnd = Math.min(hit.end, windowEnd) - windowStart;
        if (relEnd <= 0 || relStart >= windowEnd - windowStart) return null;
        return { start: relStart, end: relEnd, ...(hit.queryId === undefined ? {} : { queryId: hit.queryId }) };
      })
      .filter((h): h is Hit => h !== null),
    new Map(),
  );

  return {
    text: text.slice(windowStart, windowEnd),
    offset: windowStart,
    hits: clipped,
  };
}

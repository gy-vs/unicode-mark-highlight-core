import { describe, expect, it } from 'vitest';
import {
  createSearchIndex,
  cropSnippet,
  findMatches,
  findMatchesIn,
  search,
} from '../src/index.js';

// é as a single NFC codepoint; ◌́ is the combining acute accent U+0301.
const NFC_E = 'Café';
const NFD_E = 'Café';
// שלום ("shalom") written with escapes so source encoding cannot change it.
const SHALOM = 'שלום';
const RTL_TEXT = `${SHALOM} עולם ${SHALOM}`;

describe('findMatches', () => {
  it('finds normalized text', () => expect(findMatches(NFC_E, 'cafe')).toHaveLength(1));

  it('extends the highlight to trailing combining marks', () => {
    // NFD "Café": the acute accent is a separate code unit after "e".
    expect(findMatches(NFD_E, 'cafe')).toEqual([{ start: 0, end: 5 }]);
    expect(findMatches(NFD_E, 'café')).toEqual([{ start: 0, end: 5 }]);
  });

  it('keeps a leading dangling mark outside the following match', () => {
    // A combining mark with no base is its own grapheme and stays outside.
    expect(findMatches('́abc', 'abc')).toEqual([{ start: 1, end: 4 }]);
  });

  it('expands across marks sitting between matched letters', () => {
    // "a" + combining acute + "b": query "ab" must cover the accent too.
    expect(findMatches('áb', 'ab')).toEqual([{ start: 0, end: 3 }]);
  });

  it('matches NFC and NFD spellings identically', () => {
    expect(findMatches(NFC_E, 'cafe')).toEqual([{ start: 0, end: 4 }]);
    expect(findMatches(NFD_E, 'cafe')).toEqual([{ start: 0, end: 5 }]);
    expect(findMatches(NFC_E, 'café')).toEqual([{ start: 0, end: 4 }]);
  });

  it('supports mark-only queries', () => {
    // The accent alone cannot survive mark stripping; it still must be found
    // and expanded to the grapheme that carries it.
    expect(findMatches(NFD_E, '́')).toEqual([{ start: 3, end: 5 }]);
  });

  it('returns no ranges for an empty query', () => {
    expect(findMatches('abc', '')).toEqual([]);
  });

  it('expands emoji modifier sequences to the full grapheme', () => {
    const text = 'say 👍🏽 ok';
    expect(findMatches(text, '👍')).toEqual([{ start: 4, end: 4 + '👍🏽'.length }]);
  });

  it('expands ZWJ sequences to the full grapheme', () => {
    const family = '👨‍👩‍👧';
    expect(findMatches(family, '👩')).toEqual([{ start: 0, end: family.length }]);
  });

  it('returns RTL ranges in logical order', () => {
    expect(findMatches(RTL_TEXT, SHALOM)).toEqual([
      { start: 0, end: 4 },
      { start: 10, end: 14 },
    ]);
  });
});

describe('createSearchIndex', () => {
  it('reuses the same index across queries', () => {
    const index = createSearchIndex(`${NFD_E} au ${NFC_E}`);
    expect(findMatchesIn(index, 'cafe')).toEqual([
      { start: 0, end: 5 },
      { start: 9, end: 13 },
    ]);
    expect(findMatchesIn(index, 'au')).toEqual([{ start: 6, end: 8 }]);
  });
});

describe('search', () => {
  it('keeps overlapping hits from different queries separate', () => {
    expect(search('abab', ['aba', 'bab'])).toEqual([
      { start: 0, end: 3, queryIndex: 0, query: 'aba' },
      { start: 1, end: 4, queryIndex: 1, query: 'bab' },
    ]);
  });

  it('preserves adjacent same-query hits by default', () => {
    expect(search('aaaa', ['aa'])).toEqual([
      { start: 0, end: 2, queryIndex: 0, query: 'aa' },
      { start: 2, end: 4, queryIndex: 0, query: 'aa' },
    ]);
  });

  it('merges same-query hits only when the strategy allows it', () => {
    expect(search('aaaa', ['aa'], { merge: 'same-query' })).toEqual([
      { start: 0, end: 4, queryIndex: 0, query: 'aa' },
    ]);
  });

  it('never merges across queries even when merging is enabled', () => {
    expect(search('abab', ['aba', 'bab'], { merge: 'same-query' })).toEqual([
      { start: 0, end: 3, queryIndex: 0, query: 'aba' },
      { start: 1, end: 4, queryIndex: 1, query: 'bab' },
    ]);
  });

  it('sorts RTL matches by logical offset, not rendering order', () => {
    const matches = search('אבג אבג', ['אבג', 'ב']);
    // Nested ranges from different queries stay distinct and are ordered by
    // logical offset only; bidi direction plays no role in the ordering.
    expect(matches.map((m) => [m.start, m.end, m.queryIndex])).toEqual([
      [0, 3, 0],
      [1, 2, 1],
      [4, 7, 0],
      [5, 6, 1],
    ]);
  });
});

describe('cropSnippet', () => {
  it('re-bases match ranges to the crop start', () => {
    const text = 'x'.repeat(50) + NFC_E + 'y'.repeat(50);
    const [match] = findMatches(text, 'cafe'); // { start: 50, end: 54 }
    const snippet = cropSnippet(text, [match], { maxLength: 24, context: 10 });
    expect(snippet.start).toBeGreaterThan(0);
    expect(snippet.matches).toHaveLength(1);
    const [range] = snippet.matches;
    // The caller must receive ranges relative to the snippet, not absolutes.
    expect(range.start).toBe(match.start - snippet.start);
    expect(range.end).toBe(match.end - snippet.start);
    expect(snippet.text.slice(range.start, range.end)).toBe(NFC_E);
  });

  it('clips partially visible matches to the window', () => {
    const snippet = cropSnippet('a'.repeat(100), [{ start: 0, end: 60 }], {
      maxLength: 20,
      context: 0,
    });
    expect(snippet.text).toHaveLength(20);
    expect(snippet.matches).toEqual([{ start: 0, end: 20 }]);
  });

  it('never splits a grapheme at the crop boundary', () => {
    const text = 'ab'.repeat(30) + '👍🏽' + 'cd'.repeat(30);
    // A range inside the emoji cluster: the window expands to contain it whole.
    const snippet = cropSnippet(text, [{ start: 62, end: 64 }], { maxLength: 10, context: 0 });
    expect(snippet.text).toBe('👍🏽');
    expect(snippet.matches).toEqual([{ start: 2, end: 4 }]);
  });

  it('crops from the start when there are no matches', () => {
    expect(cropSnippet('hello world', [], { maxLength: 5 })).toEqual({
      text: 'hello',
      start: 0,
      end: 5,
      matches: [],
    });
  });

  it('re-bases RTL snippet ranges to logical offsets', () => {
    const [, second] = findMatches(RTL_TEXT, SHALOM); // { start: 10, end: 14 }
    const snippet = cropSnippet(RTL_TEXT, [second], { context: 0 });
    expect(snippet.text).toBe(SHALOM);
    expect(snippet.start).toBe(10);
    expect(snippet.matches).toEqual([{ start: 0, end: 4 }]);
  });
});

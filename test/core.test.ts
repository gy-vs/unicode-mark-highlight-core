import { describe, expect, it } from 'vitest';
import { clipExcerpt, findMatches, normalizeText, searchHits, type Hit } from '../src/index.js';

// "café" in NFC (U+00E9) and NFD (e + combining acute U+0301).
const ACUTE = '́';
const DIAERESIS = '̈';
const CAFE_NFC = 'Café';
const CAFE_NFD = `Cafe${ACUTE}`;
const PREPEND = '؀'; // ARABIC NUMBER SIGN: Grapheme_Cluster_Break=Prepend, not \p{M}

describe('grapheme-boundary expansion', () => {
  it('finds normalized text (original behaviour)', () => {
    expect(findMatches(CAFE_NFC, 'cafe')).toHaveLength(1);
  });

  it('covers the post-base combining mark (NFD)', () => {
    // The whole folded word matches [0,5); a base-letter query expands to the
    // full cluster "e + U+0301" at code units [3,5), leaving no mark outside.
    expect(findMatches(CAFE_NFD, 'cafe')).toEqual([{ start: 0, end: 5 }]);
    expect(findMatches(CAFE_NFD, 'e')).toEqual([{ start: 3, end: 5 }]);
    expect(CAFE_NFD.slice(3, 5)).toBe(`e${ACUTE}`);
  });

  it('covers the precomposed letter (NFC) with the same logical range', () => {
    expect(findMatches(CAFE_NFC, 'cafe')).toEqual([{ start: 0, end: 4 }]);
    expect(findMatches(CAFE_NFC, 'e')).toEqual([{ start: 3, end: 4 }]);
    expect(CAFE_NFC.slice(3, 4)).toBe('é');
  });

  it('covers a prepended concatenation mark before the base', () => {
    // U+0600 attaches to the following digit in one grapheme: "؀5".
    expect(findMatches('a؀5b', '5')).toEqual([{ start: 1, end: 3 }]);
    expect('a؀5b'.slice(1, 3)).toBe('؀5');
  });

  it('covers pre-base and post-base marks together', () => {
    // "؀5́": prepend + digit + acute -> a single grapheme of length 3.
    const text = `a${PREPEND}5${ACUTE}b`;
    expect(findMatches(text, '5')).toEqual([{ start: 1, end: 4 }]);
    expect(text.slice(1, 4)).toBe(`${PREPEND}5${ACUTE}`);
  });

  it('keeps marks on repeated occurrences', () => {
    expect(findMatches(`${CAFE_NFD} ${CAFE_NFD}`, 'cafe')).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
    ]);
  });
});

describe('mark-only queries', () => {
  it('finds clusters carrying a post-base mark by the mark alone', () => {
    expect(findMatches(CAFE_NFD, ACUTE)).toEqual([{ start: 3, end: 5 }]);
  });

  it('does not match unmarked text', () => {
    expect(findMatches('Cafe', ACUTE)).toEqual([]);
  });

  it('finds clusters by a prepended mark alone', () => {
    expect(findMatches(`a${PREPEND}5b`, PREPEND)).toEqual([{ start: 1, end: 3 }]);
  });

  it('finds emoji modifier queries (skin tone)', () => {
    // "👍" base is one code unit, "🏽" modifier is two.
    const hand = '👍🏽';
    expect(hand.length).toBe(4);
    expect(findMatches(`x${hand}y`, '🏽')).toEqual([{ start: 1, end: 5 }]);
    expect(findMatches(`x${hand}y`, '👍')).toEqual([{ start: 1, end: 5 }]);
  });

  it('finds ZWJ sequences whose base matches', () => {
    // Man + ZWJ + computer: 2 + 1 + 2 = 5 code units, one grapheme.
    const zwj = '👨‍💻';
    expect(zwj.length).toBe(5);
    expect(findMatches(`a${zwj}b`, '👨')).toEqual([{ start: 1, end: 6 }]);
  });

  it('requires multiple marks in order', () => {
    // Acute + diaeresis must occur as an ordered subsequence of attachments.
    const cluster = `e${ACUTE}${DIAERESIS}`;
    expect(findMatches(`a${cluster}b`, `${ACUTE}${DIAERESIS}`)).toEqual([{ start: 1, end: 4 }]);
    expect(findMatches(`a${cluster}b`, `${DIAERESIS}${ACUTE}`)).toEqual([]);
  });
});

describe('NFD equivalence', () => {
  it('treats NFC and NFD text identically', () => {
    expect(normalizeText(CAFE_NFC)).toBe('cafe');
    expect(normalizeText(CAFE_NFD)).toBe('cafe');
    expect(findMatches(CAFE_NFD, 'CAFÉ')).toEqual([{ start: 0, end: 5 }]);
    expect(findMatches(CAFE_NFC, 'CAFÉ')).toEqual([{ start: 0, end: 4 }]);
  });
});

describe('RTL and logical ordering', () => {
  const hebrew = 'abשaב'; // Latin letters + Hebrew: 0:a 1:b 2:ש 3:a 4:ב

  it('returns hits in logical order even though text renders RTL', () => {
    expect(findMatches(hebrew, 'a')).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ]);
  });

  it('keeps distinct overlapping query hits ordered logically', () => {
    const hits = searchHits(
      hebrew,
      [
        { id: 'a', text: 'a' },
        { id: 'b', text: 'b' },
        { id: 'a2', text: 'a' },
      ],
    );
    expect(hits).toEqual([
      { start: 0, end: 1, queryId: 'a' },
      { start: 0, end: 1, queryId: 'a2' },
      { start: 1, end: 2, queryId: 'b' },
      { start: 3, end: 4, queryId: 'a' },
      { start: 3, end: 4, queryId: 'a2' },
    ]);
  });
});

describe('overlapping queries and merge policy', () => {
  const text = 'aaaa';

  it('keeps every overlapping occurrence by default', () => {
    expect(findMatches(text, 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 1, end: 3 },
      { start: 2, end: 4 },
    ]);
  });

  it('merges overlapping occurrences for the same query with merge: overlap', () => {
    expect(searchHits(text, { text: 'aa' }, { merge: 'overlap' })).toEqual([
      { start: 0, end: 4 },
    ]);
  });

  it('merges touching occurrences with merge: adjacent', () => {
    expect(searchHits(`${CAFE_NFD} ${CAFE_NFD}`, { text: 'cafe' }, { merge: 'adjacent' })).toHaveLength(2);
    const two = searchHits('cafecafe', { text: 'cafe' }, { merge: 'adjacent' });
    expect(two).toEqual([{ start: 0, end: 8 }]);
    // Adjacent but not overlapping stays separate under 'overlap'.
    expect(searchHits('cafecafe', { text: 'cafe' }, { merge: 'overlap' })).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
    ]);
  });

  it('never merges hits from different queries', () => {
    const hits = searchHits(text, [{ id: 'x', text: 'aa' }, { id: 'y', text: 'aa' }], {
      merge: 'adjacent',
    });
    expect(hits).toEqual([
      { start: 0, end: 4, queryId: 'x' },
      { start: 0, end: 4, queryId: 'y' },
    ]);
  });

  it('never merges different queries even when ranges are identical', () => {
    const hits = searchHits(CAFE_NFC, [{ id: 1, text: 'cafe' }, { id: 2, text: 'cafe' }]);
    expect(hits).toEqual([
      { start: 0, end: 4, queryId: 1 },
      { start: 0, end: 4, queryId: 2 },
    ]);
  });
});

describe('clipExcerpt', () => {
  const text = `${CAFE_NFD} ${CAFE_NFD} ${CAFE_NFD}`;
  const hits: Hit[] = [
    { start: 0, end: 5 },
    { start: 6, end: 11 },
    { start: 12, end: 17 },
  ];

  it('re-bases ranges relative to the clip start', () => {
    const ex = clipExcerpt(text, hits, 6, 11);
    expect(ex.text).toBe(CAFE_NFD);
    expect(ex.offset).toBe(6);
    expect(ex.hits).toEqual([{ start: 0, end: 5 }]);
  });

  it('snaps the window outward to grapheme boundaries', () => {
    // Second NFD cluster "café" is at [9,11): base e at 9, mark at 10.
    // Starting at the mark code unit (10) must snap the start back to 9;
    // ending inside the third cluster snaps forward to its end.
    const ex = clipExcerpt(text, hits, 10, 16); // 16 = mark code unit of 3rd café
    expect(ex.offset).toBe(9);
    expect(ex.text).toBe(text.slice(9));
    expect(ex.hits).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 8 },
    ]);
    // The first relative range is the complete cluster including the mark.
    expect(ex.text.slice(0, 2)).toBe(`e${ACUTE}`);
    expect(ex.text.slice(3, 8)).toBe(CAFE_NFD);
  });

  it('clamps hits crossing the clip edges and keeps query identity', () => {
    const all: Hit[] = [{ start: 0, end: 17, queryId: 'q' }];
    const ex = clipExcerpt(text, all, 6, 11);
    expect(ex.hits).toEqual([{ start: 0, end: 5, queryId: 'q' }]);
  });

  it('drops hits fully outside the window', () => {
    const ex = clipExcerpt(text, hits, 12, 17);
    expect(ex.text).toBe(CAFE_NFD);
    expect(ex.hits).toEqual([{ start: 0, end: 5 }]);
  });

  it('never exposes absolute offsets for clipped ranges', () => {
    const ex = clipExcerpt(text, hits, 6, 17);
    for (const h of ex.hits) {
      expect(h.start).toBeGreaterThanOrEqual(0);
      expect(h.end).toBeLessThanOrEqual(ex.text.length);
    }
    // Relative ranges index into the returned text as whole graphemes.
    expect(ex.text.slice(ex.hits[0]!.start, ex.hits[0]!.end)).toBe(CAFE_NFD);
    expect(ex.text.slice(ex.hits[1]!.start, ex.hits[1]!.end)).toBe(CAFE_NFD);
  });

  it('re-bases astral emoji ranges correctly', () => {
    // "x" + "👍🏽"(4) + "y" + "👍🏽"(4)
    const em = '👍🏽';
    const t = `x${em}y${em}`;
    const all = searchHits(t, { text: em });
    const ex = clipExcerpt(t, all, 2, t.length); // cut in the middle of first cluster
    expect(ex.offset).toBe(1);
    expect(ex.text).toBe(t.slice(1));
    expect(ex.text.slice(ex.hits[0]!.start, ex.hits[0]!.end)).toBe(em);
    expect(ex.text.slice(ex.hits[1]!.start, ex.hits[1]!.end)).toBe(em);
  });
});

describe('edge cases', () => {
  it('returns nothing for an empty query', () => {
    expect(findMatches(CAFE_NFC, '')).toEqual([]);
    expect(searchHits(CAFE_NFC, { text: '' })).toEqual([]);
  });

  it('does not let a mark-only query match bare clusters', () => {
    expect(findMatches('cafe', ACUTE)).toEqual([]);
  });

  it('handles empty text in clipping', () => {
    expect(clipExcerpt('', [], 0, 0)).toEqual({ text: '', offset: 0, hits: [] });
  });
});

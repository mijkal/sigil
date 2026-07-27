import { describe, it, expect } from 'vitest';
import { findMatches, highlightLine } from './find';

describe('findMatches', () => {
  it('finds case-insensitive matches in document order', () => {
    const lines = ['Error here', 'all good', 'another ERROR and error'];
    const m = findMatches(lines, 'error');
    expect(m).toEqual([
      { row: 0, start: 0, end: 5 },
      { row: 2, start: 8, end: 13 },
      { row: 2, start: 18, end: 23 },
    ]);
  });
  it('is empty for a blank query', () => {
    expect(findMatches(['x'], '')).toEqual([]);
  });
  it('does not overlap', () => {
    expect(findMatches(['aaaa'], 'aa')).toEqual([
      { row: 0, start: 0, end: 2 },
      { row: 0, start: 2, end: 4 },
    ]);
  });
});

describe('highlightLine', () => {
  it('wraps matches in <mark> and escapes HTML', () => {
    expect(highlightLine('a<b> ERR', 'err', -1)).toBe('a&lt;b&gt; <mark class="sigil-find">ERR</mark>');
  });
  it('tags the current match', () => {
    // two matches; the one at offset 4 is current
    expect(highlightLine('err err', 'err', 4)).toBe(
      '<mark class="sigil-find">err</mark> <mark class="sigil-find sigil-find-cur">err</mark>'
    );
  });
  it('returns escaped plain text when query is empty', () => {
    expect(highlightLine('a<b', '', -1)).toBe('a&lt;b');
  });
});

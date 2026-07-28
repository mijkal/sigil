import { describe, it, expect } from 'vitest';
import { globToRegExp, matchesHidden, DEFAULT_HIDDEN_PATTERNS } from './hiddenSessionStore';

describe('globToRegExp', () => {
  it('anchors the pattern so it never matches a substring', () => {
    const re = globToRegExp('hostsh-*')!;
    expect(re.test('hostsh-0bb72231')).toBe(true);
    // The bug this guards: a naive `indexOf`/unanchored regex would hide a real
    // session whose name merely CONTAINS the token.
    expect(re.test('my-hostsh-notes')).toBe(false);
    expect(re.test('prod-hostsh-1')).toBe(false);
  });

  it('escapes regex metacharacters so they are literal', () => {
    const re = globToRegExp('a.b')!;
    expect(re.test('a.b')).toBe(true);
    expect(re.test('axb')).toBe(false);
  });

  it('supports ? as a single-character wildcard', () => {
    const re = globToRegExp('task-?')!;
    expect(re.test('task-1')).toBe(true);
    expect(re.test('task-12')).toBe(false);
  });

  it('returns null for an empty pattern rather than matching everything', () => {
    expect(globToRegExp('')).toBeNull();
  });
});

describe('matchesHidden', () => {
  it('hides the Drydock worker sessions by default', () => {
    expect(matchesHidden('hostsh-0bb72231', DEFAULT_HIDDEN_PATTERNS)).toBe(true);
    expect(matchesHidden('mctask-45cce877', DEFAULT_HIDDEN_PATTERNS)).toBe(true);
  });

  it('leaves real work visible', () => {
    for (const name of ['utopia', 'Dodecki', 'mycellm', 'general', 'nextstep']) {
      expect(matchesHidden(name, DEFAULT_HIDDEN_PATTERNS)).toBe(false);
    }
  });

  it('hides nothing when the pattern list is empty', () => {
    expect(matchesHidden('hostsh-0bb72231', [])).toBe(false);
  });

  it('ignores a bare prefix without the separator', () => {
    expect(matchesHidden('hostsh', DEFAULT_HIDDEN_PATTERNS)).toBe(false);
  });
});

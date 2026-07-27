import { describe, it, expect } from 'vitest';
import { sanitizeSGRParams, stripNonSGR, linkifyHtml, renderLine, plainText } from './scrollback';

const ESC = '\x1b';

describe('sanitizeSGRParams', () => {
  it('keeps basic colour/style codes', () => {
    expect(sanitizeSGRParams('1')).toBe('1');
    expect(sanitizeSGRParams('38;5;153')).toBe('38;5;153');
    expect(sanitizeSGRParams('0;1;31')).toBe('0;1;31');
    expect(sanitizeSGRParams('38;2;10;20;30')).toBe('38;2;10;20;30');
  });
  it('drops params that are not renderable SGR', () => {
    expect(sanitizeSGRParams('200')).toBeNull();
  });
});

describe('stripNonSGR', () => {
  it('preserves the ESC on SGR sequences (regression: the ESC-strip bug)', () => {
    const inp = `${ESC}[38;5;153mhello${ESC}[39m`;
    // Already-clean SGR must pass through unchanged — the bug stripped the ESC,
    // yielding a bare "[38;5;153m" that leaked as literal text.
    expect(stripNonSGR(inp)).toBe(inp);
    // No colour code may appear WITHOUT a preceding ESC.
    expect(stripNonSGR(inp)).not.toMatch(/(^|[^\x1b])\[38;5;153m/);
  });
  it('removes OSC sequences and cursor positioning', () => {
    expect(stripNonSGR(`${ESC}]0;title\x07text`)).toBe('text');
    expect(stripNonSGR(`a${ESC}[2Jb`)).toBe('ab'); // erase-screen dropped
  });
  it('leaves plain text untouched', () => {
    expect(stripNonSGR('just words')).toBe('just words');
  });
});

describe('linkifyHtml', () => {
  it('wraps a bare URL in an anchor', () => {
    const out = linkifyHtml('see https://example.com/x for more');
    expect(out).toContain('<a href="https://example.com/x"');
    expect(out).toContain('class="term-link"');
  });
  it('keeps trailing sentence punctuation outside the link', () => {
    const out = linkifyHtml('go to https://example.com.');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('</a>.'); // the dot is outside
  });
  it('leaves non-URL text alone', () => {
    expect(linkifyHtml('no links here')).toBe('no links here');
  });
});

describe('renderLine', () => {
  it('renders an empty line as a non-breaking space', () => {
    expect(renderLine('')).toBe('&nbsp;');
  });
  it('produces linkified, coloured HTML', () => {
    const out = renderLine(`${ESC}[31mred https://x.io/y${ESC}[39m`);
    expect(out).toContain('term-link');
    expect(out).toContain('href="https://x.io/y"');
  });
});

describe('plainText', () => {
  it('strips SGR sequences', () => {
    expect(plainText(`${ESC}[1mbold${ESC}[0m done`)).toBe('bold done');
  });
});

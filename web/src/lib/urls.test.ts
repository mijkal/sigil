import { describe, it, expect } from 'vitest';
import { extractUrls, findUrls, inferWrapWidth, rejoinWrapped, unwrapUrlsForCopy } from './urls';

const ESC = '\x1b';

describe('extractUrls', () => {
  it('extracts a plain URL', () => {
    expect(extractUrls('visit https://example.com/path now')).toEqual(['https://example.com/path']);
  });

  it('strips trailing sentence punctuation', () => {
    expect(extractUrls('see https://example.com/x).')).toEqual(['https://example.com/x']);
  });

  it('extracts an OSC 8 hyperlink URI (out-of-band, wrap-proof)', () => {
    const osc8 = `${ESC}]8;;https://real.example/deep/link${ESC}\\click here${ESC}]8;;${ESC}\\`;
    expect(extractUrls(osc8)).toContain('https://real.example/deep/link');
  });

  it('ignores ANSI colour codes around a URL', () => {
    const colored = `${ESC}[34mhttps://c.io/z${ESC}[0m`;
    expect(extractUrls(colored)).toEqual(['https://c.io/z']);
  });

  it('dedupes repeated URLs', () => {
    expect(extractUrls('https://a.io https://a.io https://a.io')).toEqual(['https://a.io']);
  });

  it('returns nothing when there is no URL', () => {
    expect(extractUrls('just some plain text, no links')).toEqual([]);
  });

  it('caps the result to the most recent N, newest first', () => {
    // In a terminal the link you want is the one just printed, so the list leads
    // with the newest. (This inverts the old tail-in-emission-order behaviour.)
    const many = Array.from({ length: 10 }, (_, i) => `https://h${i}.io`).join(' ');
    expect(extractUrls(many, 3)).toEqual(['https://h9.io', 'https://h8.io', 'https://h7.io']);
  });
});

describe('the login-link regression', () => {
  // Verbatim shape of a real Claude OAuth line captured from a 112-column pane:
  // the TUI emits an OSC 8 hyperlink carrying the exact URI, AND prints a visible
  // copy that the terminal hard-wraps. The old extractor surfaced BOTH plus a
  // shorter fragment, and put the fragments FIRST — so the first link you clicked
  // was always broken.
  const FULL =
    'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
    '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
    '&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=pTvqhG7kUWGahIhH1V2zC6F751KQW_sI43OI' +
    '&code_challenge_method=S256&state=ChB1mcPX9gzHz';

  const WIDTH = 112;

  function wrapped(url: string, width: number): string {
    const parts: string[] = [];
    for (let i = 0; i < url.length; i += width) parts.push(url.slice(i, i + width));
    return parts.join('\n');
  }

  // Filler lines at the wrap column so the width is inferable (3+ sightings).
  const filler = Array.from({ length: 4 }, () => 'x'.repeat(WIDTH)).join('\n');

  it('returns the complete URL, not a wrap fragment', () => {
    const stream =
      `${filler}\nBrowser didn't open? Use this url to sign in (c to copy)\r` +
      `${ESC}]8;id=14zg6tb;${FULL}${ESC}\\Sign in${ESC}]8;;${ESC}\\\n` +
      `${wrapped(FULL, WIDTH)}\n`;
    const urls = extractUrls(stream);
    expect(urls[0]).toBe(FULL);
    expect(urls).toHaveLength(1);
  });

  it('never lists a truncated prefix of a link it already has', () => {
    const stream =
      `${filler}\n${ESC}]8;;${FULL}${ESC}\\x${ESC}]8;;${ESC}\\\n` +
      `${FULL.slice(0, 53)}\n${FULL.slice(0, WIDTH)}\n`;
    const urls = extractUrls(stream);
    expect(urls).toEqual([FULL]);
    expect(urls.some(u => u.length < FULL.length)).toBe(false);
  });

  it('recovers a wrapped URL even with no OSC 8 hyperlink', () => {
    // Programs that print a bare URL get no out-of-band copy — the wrap rejoin is
    // the only way back to a usable link.
    const stream = `${filler}\n${wrapped(FULL, WIDTH)}\n`;
    expect(extractUrls(stream)).toEqual([FULL]);
  });

  it('marks the exact source so the UI can say which is trustworthy', () => {
    const stream = `${ESC}]8;;${FULL}${ESC}\\x${ESC}]8;;${ESC}\\\nhttps://plain.example/a\n`;
    const found = findUrls(stream);
    expect(found.find(f => f.url === FULL)?.source).toBe('osc8');
    expect(found.find(f => f.url === 'https://plain.example/a')?.source).toBe('text');
  });
});

describe('wrap inference', () => {
  it('finds the wrap column from repeated full-width lines', () => {
    const s = Array.from({ length: 5 }, () => 'y'.repeat(96)).join('\n') + '\nshort\n';
    expect(inferWrapWidth(s)).toBe(96);
  });

  it('refuses to guess when no width repeats', () => {
    expect(inferWrapWidth('one line only that is quite long but unique in length\n')).toBe(0);
  });

  it('does not rejoin when the width is unknown', () => {
    const s = 'https://a.io/aaaa\nbbbb';
    expect(rejoinWrapped(s, 0)).toBe(s);
  });

  it('does not glue ordinary prose together', () => {
    // Both lines are exactly the wrap width, but neither ends inside a URL.
    const line = 'w'.repeat(20);
    const s = `${line}\n${line}\n`;
    expect(rejoinWrapped(s, 20)).toBe(s);
  });

  it('only joins when the break is inside a URL', () => {
    const head = 'see https://e.io/' + 'a'.repeat(3);   // 20 chars exactly
    expect(head).toHaveLength(20);
    expect(rejoinWrapped(`${head}\nbbb`, 20)).toBe(`${head}bbb`);
  });

  it('leaves a short line alone even if a URL ends it', () => {
    // Not at the wrap column → a real line end, not a terminal break.
    const s = 'https://e.io/x\nnext';
    expect(rejoinWrapped(s, 40)).toBe(s);
  });
});

describe('elided URLs', () => {
  it('drops a program-truncated URL when a real one exists', () => {
    const s = 'https://repo.example/api/v1/repos/someone…\nhttps://good.example/full/path\n';
    expect(extractUrls(s)).toEqual(['https://good.example/full/path']);
  });

  it('catches an ellipsis that was decoded as latin1 rather than UTF-8', () => {
    // A real pipe log yielded a 91-char OAuth "URL" ending in U+2026's raw bytes.
    // It is a display truncation either way, and must not reach the list.
    const mojibake = 'https://claude.com/cai/oauth/authorize?code=true&client_id=59637612-477b\u00e2\u0080\u00a6';
    const s = `${mojibake}\nhttps://good.example/x\n`;
    expect(extractUrls(s)).toEqual(['https://good.example/x']);
  });

  it('keeps it as a last resort so the list is never mysteriously empty', () => {
    const found = findUrls('https://repo.example/api/v1/repos/someone…\n');
    expect(found).toHaveLength(1);
    expect(found[0].elided).toBe(true);
  });
});

describe('navigable hosts', () => {
  it('drops hostless fragments that are not reachable links', () => {
    // Terminal output is full of these (config lines, examples, OSC 8 wrappers
    // around non-links); they made the list longer without making it useful.
    const s = 'http://git\nhttps://someone\nhttps://real.example/ok\n';
    expect(extractUrls(s)).toEqual(['https://real.example/ok']);
  });

  it('keeps localhost and explicit ports', () => {
    expect(extractUrls('http://localhost:3000/x')).toEqual(['http://localhost:3000/x']);
    expect(extractUrls('http://192.0.2.10:4444/y')).toEqual(['http://192.0.2.10:4444/y']);
  });
});

describe('recency', () => {
  it('orders by last sighting, not by emission order', () => {
    const s = 'https://old.io/a\nhttps://new.io/b\nhttps://old.io/a\n';
    // old.io was printed most recently, so it leads.
    expect(extractUrls(s)).toEqual(['https://old.io/a', 'https://new.io/b']);
  });

  it('an OSC 8 sighting upgrades provenance without losing recency', () => {
    const s = `https://x.io/p\n${ESC}]8;;https://x.io/p${ESC}\\t${ESC}]8;;${ESC}\\\n`;
    const found = findUrls(s);
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('osc8');
  });
});

describe('unwrapUrlsForCopy (selection → clipboard)', () => {
  const COLS = 122;
  const fill = (s: string) => s + 'a'.repeat(Math.max(0, COLS - s.length));

  it('rejoins a URL the TUI broke across rows', () => {
    const head = fill('https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a');
    const tail = 'response_type=code&state=ChB1mcPX9gzHz';
    expect(unwrapUrlsForCopy(`${head}\n${tail}`, COLS)).toBe(head + tail);
  });

  it('rejoins a URL spanning three rows', () => {
    const a = fill('https://e.io/');
    const b = 'b'.repeat(COLS);
    const c = 'tail';
    expect(unwrapUrlsForCopy(`${a}\n${b}\n${c}`, COLS)).toBe(a + b + c);
  });

  it('does NOT join a short line that merely ends in a URL', () => {
    // The exact false positive the cols test exists to prevent.
    const s = 'see https://example.com/a\nnext line here';
    expect(unwrapUrlsForCopy(s, COLS)).toBe(s);
  });

  it('does not join when the break is not inside a URL', () => {
    const s = `${fill('plain prose that fills the row')}\ncontinues here`;
    expect(unwrapUrlsForCopy(s, COLS)).toBe(s);
  });

  it('does not join when the continuation is indented', () => {
    // Leading whitespace means a new line of layout, not a wrap.
    const s = `${fill('https://e.io/x')}\n    indented`;
    expect(unwrapUrlsForCopy(s, COLS)).toBe(s);
  });

  it('handles CRLF selections', () => {
    const head = fill('https://e.io/q?a=1');
    expect(unwrapUrlsForCopy(`${head}\r\nmore`, COLS)).toBe(head + 'more');
  });

  it('leaves single-line and empty selections untouched', () => {
    expect(unwrapUrlsForCopy('https://e.io/x', COLS)).toBe('https://e.io/x');
    expect(unwrapUrlsForCopy('', COLS)).toBe('');
  });

  it('is inert without a usable grid width', () => {
    const s = `${fill('https://e.io/x')}\nmore`;
    expect(unwrapUrlsForCopy(s, 0)).toBe(s);
  });

  it('preserves genuinely separate lines around a repaired one', () => {
    const head = fill('https://e.io/p?x=1');
    const s = `before\n${head}\ntail\nafter`;
    expect(unwrapUrlsForCopy(s, COLS)).toBe(`before\n${head}tail\nafter`);
  });
});

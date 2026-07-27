// extractUrls pulls URLs out of a *raw* terminal byte stream (the tmux pipe-pane
// log), preserving the exact URI.
//
// The hard part is that ONE link routinely appears in the stream THREE ways, and
// only one of them is usable:
//
//   1. An OSC 8 hyperlink — `ESC ] 8 ; params ; URI ST text ESC ] 8 ; ; ST`. The
//      URI is carried out-of-band, so it is exact and wrap-proof. Best source.
//   2. A visible copy of the same URL, printed so you can select it by hand — and
//      HARD-WRAPPED at the pane width, because the terminal broke it. Reading that
//      naively yields a fragment cut at exactly N columns.
//   3. An ELIDED copy the program truncated itself for display ("https://…/x").
//      Those characters were never written; nothing can recover them.
//
// A real Claude OAuth login line in a 112-column pane produced, from a single
// link: a 53-char fragment, a 112-char fragment, and the true 420-char URI. The
// old extractor emitted all three and, after its "most recent first" reverse, put
// the two FRAGMENTS at the top of the list — so the first link you clicked was
// always broken. Hence:
//
//   * fragments (a strict prefix of a longer URL) are dropped,
//   * hard wraps are rejoined using the stream's inferred wrap width,
//   * elided URLs are dropped unless nothing better exists,
//   * ordering is by LAST OCCURRENCE in the stream — genuine recency, not the
//     order the regexes happened to run in.

export type UrlSource = 'osc8' | 'text';

export interface FoundUrl {
  url: string;
  /** 'osc8' is exact (carried out-of-band); 'text' was reconstructed from pixels. */
  source: UrlSource;
  /** Offset of the last occurrence — higher is more recent. */
  at: number;
  /** True when the program itself elided the URL for display (unusable, but shown as a hint). */
  elided: boolean;
}

// OSC 8: capture the URI between the second ';' and the string terminator (BEL
// or ESC-backslash). The closing `8;;ST` has no URI and is skipped.
const OSC8_RE = /\x1b\]8;[^;]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;

// Strip OSC sequences, CSI sequences, charset selects, and stray two-byte escapes.
const ESC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][\dAB]|\x1b[@-_]/g;

// A run of URL-safe characters. Stops at whitespace and characters that almost
// always sit *outside* a URL in terminal output (quotes, brackets, backticks).
const URL_RE = /https?:\/\/[^\s<>"'`\]\\}|]+/g;

// Trailing punctuation that is usually sentence/markup, not part of the URL.
const TRAIL_RE = /[)\].,;:!?'"»>]+$/;

// Characters a program substitutes when it truncates a URL for display. The
// mojibake forms matter: a pipe log can carry mixed encodings, and a UTF-8 `…`
// read as latin1 becomes "â€¦"/"â¦" — still an elision, still unusable.
// (`â¦` is U+2026's UTF-8 bytes E2 80 A6 read as single-byte
// characters — what you get when a log is decoded as latin1 rather than UTF-8.)
const ELIDED_RE = /[…]|â¦|â€¦|\.\.\.$/;

// A host we could actually reach. Terminal output is full of `http://git`-style
// strings (config fragments, examples, OSC 8 wrappers around non-links) that are
// not navigable; requiring a dotted host, an explicit port, or localhost keeps
// them out of the list without discarding anything real.
const NAVIGABLE_HOST_RE = /^https?:\/\/(localhost|[^/?#\s]*[.:][^/?#\s]*)/i;

function clean(u: string): string {
  return u.trim().replace(TRAIL_RE, '');
}

/**
 * Infer the terminal's wrap column from the stream.
 *
 * A hard wrap emits a line of EXACTLY the pane width with no trailing space, so
 * that width shows up far more often than any other long-line length. Picking the
 * most common length among long lines finds it without needing to know the pane
 * size — which the log does not record, and which changes when a pane resizes.
 * Returns 0 when there is no clear mode, in which case rejoining is skipped
 * entirely rather than guessed at.
 */
export function inferWrapWidth(plain: string): number {
  const counts = new Map<number, number>();
  for (const line of plain.split('\n')) {
    const len = line.replace(/\r$/, '').length;
    if (len >= 40) counts.set(len, (counts.get(len) ?? 0) + 1);
  }
  let best = 0;
  let bestN = 0;
  for (const [len, n] of counts) {
    // Ties go to the WIDER candidate: a wrap column is an upper bound, and the
    // narrower lengths below it are ordinary content that happens to recur.
    if (n > bestN || (n === bestN && len > best)) { best = len; bestN = n; }
  }
  // One or two lines of the same length is coincidence, not a wrap column.
  return bestN >= 3 ? best : 0;
}

/**
 * Rejoin URLs the terminal hard-wrapped.
 *
 * Only joins at a line that is EXACTLY the wrap column and whose successor starts
 * with a URL-safe character — the precise signature of a terminal break. A line
 * that merely ends without punctuation is left alone, so ordinary prose never
 * gets glued together.
 */
export function rejoinWrapped(plain: string, wrapWidth: number): string {
  if (!wrapWidth) return plain;
  const lines = plain.split('\n');
  const out: string[] = [];
  // Length of the last PHYSICAL segment appended, which is what carries the
  // "filled the pane exactly" signal. The accumulated line stops being
  // wrapWidth-long the moment we join once, so testing the joined length would
  // recover only the first continuation of a URL that spans three or more rows —
  // and a login URL routinely spans three.
  let lastSegLen = -1;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const prev = out.length ? out[out.length - 1] : null;
    const joinable =
      prev !== null &&
      lastSegLen === wrapWidth &&             // previous segment filled the pane exactly
      !/\s$/.test(prev) &&                    // and was not a natural line end
      /^[^\s]/.test(line) &&                  // continuation starts immediately
      /https?:\/\/\S*$/.test(prev);           // and the break is INSIDE a URL
    if (joinable) out[out.length - 1] = prev + line;
    else out.push(line);
    lastSegLen = line.length;
  }
  return out.join('\n');
}

/**
 * Find every URL in a raw terminal stream, best-quality first.
 *
 * Ordered by recency (last occurrence), because in a terminal the link you want
 * is nearly always the one that was just printed.
 */
export function findUrls(raw: string, cap = 100, knownCols = 0): FoundUrl[] {
  const byUrl = new Map<string, FoundUrl>();

  const push = (u: string, source: UrlSource, at: number) => {
    const c = clean(u);
    if (c.length < 8 || !/^https?:\/\//.test(c)) return;
    if (!NAVIGABLE_HOST_RE.test(c)) return;
    const prev = byUrl.get(c);
    if (prev) {
      // Keep the most recent sighting, and prefer the exact provenance.
      prev.at = Math.max(prev.at, at);
      if (source === 'osc8') prev.source = 'osc8';
      return;
    }
    byUrl.set(c, { url: c, source, at, elided: ELIDED_RE.test(c) });
  };

  let m: RegExpExecArray | null;
  OSC8_RE.lastIndex = 0;
  while ((m = OSC8_RE.exec(raw)) !== null) push(m[1], 'osc8', m.index);

  // Prefer the REAL pty width when the caller knows it. Inference needs a line
  // length to recur 3+ times, which a quiet pane never produces: a 340-char URL
  // fills 4 rows at 80 cols but only 2 at 120, so on a wide pane a login URL
  // alone on screen was never rejoined. Inference stays as the fallback for
  // callers with no terminal to ask (tests, pasted text).
  const stripped = raw.replace(ESC_RE, '');
  const plain = rejoinWrapped(stripped, knownCols || inferWrapWidth(stripped));
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(plain)) !== null) push(m[0], 'text', m.index);

  let found = [...byUrl.values()];

  // Drop wrap fragments: a URL that is a strict prefix of a longer one is the
  // same link seen truncated. This is what buried the working login link under
  // two broken copies of itself.
  const sorted = [...found].sort((a, b) => b.url.length - a.url.length);
  const keep = new Set<string>();
  for (const cand of sorted) {
    let isFragment = false;
    for (const longer of keep) {
      if (longer.startsWith(cand.url)) { isFragment = true; break; }
    }
    if (!isFragment) keep.add(cand.url);
  }
  found = found.filter(f => keep.has(f.url));

  // An elided URL is unusable. Drop it if any real URL survived; keep it only as
  // a last resort so the popover can say "this is all the program printed".
  const usable = found.filter(f => !f.elided);
  if (usable.length) found = usable;

  // Most recent first — the link you want is the one just printed.
  found.sort((a, b) => b.at - a.at);
  return found.slice(0, cap);
}

/** Back-compat: plain string list, same ordering and filtering as findUrls. */
export function extractUrls(raw: string, cap = 100, knownCols = 0): string[] {
  return findUrls(raw, cap, knownCols).map(f => f.url);
}

// Characters that can legally continue a URL on the next row.
const URL_CONT_RE = /^[A-Za-z0-9%\-._~:/?#[\]@!$&'()*+,;=]/;

/**
 * Repair URLs broken across rows in text the user just SELECTED and copied.
 *
 * Selection-copy cannot be fixed at the terminal layer. When a TUI lays out its
 * own text (Claude Code's Ink renderer does) it emits a REAL newline at the wrap
 * point rather than letting the terminal auto-wrap — verified in the pipe log,
 * where the login URL breaks on a literal CR-LF. tmux therefore never marks the
 * row `wrapped`, so `capture-pane -J` will not join it and xterm's own
 * wrapped-row handling has nothing to act on. Both are behaving correctly; the
 * break is genuinely in the stream. So the repair has to happen on the way to
 * the clipboard.
 *
 * `cols` is the live grid width and is what makes this safe: a row is only a
 * wrap candidate if it FILLED the pane. Without that test, this line —
 *
 *     see https://example.com/a
 *     next line here
 *
 * — would join into ".../anext", because it too ends in a URL and is followed by
 * a non-space. With it, a short line is left alone. When the pane has since been
 * resized wider than the text was printed at, no join happens and you get exactly
 * today's behaviour; nothing is ever corrupted.
 */
export function unwrapUrlsForCopy(text: string, cols: number): string {
  if (!text || !cols || cols < 20 || !text.includes('\n')) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let lastSegLen = -1;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const prev = out.length ? out[out.length - 1] : null;
    const joinable =
      prev !== null &&
      // Filled the row (±2 for a trailing wide glyph or a trimmed cell).
      lastSegLen >= cols - 2 &&
      !/\s$/.test(prev) &&
      URL_CONT_RE.test(line) &&
      /https?:\/\/\S*$/.test(prev);   // the break is INSIDE a URL
    if (joinable) out[out.length - 1] = prev + line;
    else out.push(line);
    lastSegLen = line.length;
  }
  return out.join('\n');
}

// lib/scrollback — the pure text pipeline that turns a captured terminal line
// into safe, themed, linkified HTML for the scrollback view. No React, no I/O:
// this is the "logic layer" and is unit-tested (scrollback.test.ts).
import AnsiToHtml from 'ansi-to-html';

const ansi = new AnsiToHtml({
  fg: '#E2E8F0',
  bg: '#0A0A0C',
  newline: false,
  escapeXML: true,
  stream: false,
});

// sanitizeSGRParams keeps only the SGR (colour/style) parameters ansi-to-html
// understands, dropping the rest of a `\x1b[...m` sequence. Returns null when
// nothing is left (the whole sequence should be dropped). Cursor-positioning and
// other CSI sequences are handled by stripNonSGR, not here.
export function sanitizeSGRParams(params: string): string | null {
  if (!params) return params;
  const parts = params.split(';');
  const kept: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const n = parseInt(parts[i] || '0', 10);
    if (
      n === 0 || (n >= 1 && n <= 9) || (n >= 22 && n <= 29) ||
      (n >= 30 && n <= 37) || n === 39 || (n >= 40 && n <= 47) || n === 49 ||
      (n >= 90 && n <= 97) || (n >= 100 && n <= 107)
    ) { kept.push(parts[i]); i++; }
    else if ((n === 38 || n === 48) && i + 1 < parts.length) {
      const mode = parseInt(parts[i + 1], 10);
      if (mode === 5 && i + 2 < parts.length) { kept.push(parts[i], parts[i + 1], parts[i + 2]); i += 3; }
      else if (mode === 2 && i + 4 < parts.length) { kept.push(parts[i], parts[i + 1], parts[i + 2], parts[i + 3], parts[i + 4]); i += 5; }
      else { i++; }
    } else { i++; }
  }
  return kept.length > 0 ? kept.join(';') : null;
}

// stripNonSGR reduces a raw captured line to SGR-only ANSI (colour/style codes),
// removing OSC sequences, cursor positioning, and stray control chars — the only
// input ansi-to-html can render correctly.
//
// IMPORTANT: the final control-char strip must NOT include 0x1b (ESC). The step
// above preserves SGR as `\x1b[...m`, and 0x1b lives in \x0e-\x1f — including it
// nuked the ESC off every colour code, leaking "[38;5;153m" as literal text.
export function stripNonSGR(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[([^A-Za-z~]*)([A-Za-z~])/g, (_m, params, final) => {
      if (final !== 'm') return '';
      const s = sanitizeSGRParams(params);
      return s === null ? '' : `\x1b[${s}m`;
    })
    .replace(/\x1b[^[]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, '');
}

// linkifyHtml wraps bare http(s) URLs in ANSI-rendered HTML as clickable anchors.
// It runs on the XML-escaped ansi-to-html output (URLs never contain a raw '<'),
// so it can't corrupt markup; the run stops at '<', so a URL split by a mid-URL
// colour change linkifies up to that boundary. Trailing sentence punctuation is
// kept outside the link. Because history is captured as LOGICAL lines (tmux -J),
// a URL wrapped at the pane width is a single text run here and linkifies whole.
const LINK_RE = /https?:\/\/[^\s<>"'`]+/g;
const LINK_TRAIL = /[)\].,;:!?'"»]+$/;
export function linkifyHtml(html: string): string {
  return html.replace(LINK_RE, (m) => {
    const trail = LINK_TRAIL.exec(m);
    const url = trail ? m.slice(0, m.length - trail[0].length) : m;
    const tail = trail ? trail[0] : '';
    if (url.length < 8) return m;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="term-link">${url}</a>${tail}`;
  });
}

// renderLine is the full pipeline: SGR-only ANSI → HTML → linkified. Empty lines
// become a non-breaking space so they occupy a row.
export function renderLine(line: string): string {
  if (line.length === 0) return '&nbsp;';
  return linkifyHtml(ansi.toHtml(line));
}

// plainText strips SGR sequences for the searchable/selectable text mirror.
export function plainText(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, '');
}

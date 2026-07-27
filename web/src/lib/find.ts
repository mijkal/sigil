// Pure find-in-scrollback logic: locate case-insensitive matches across the
// terminal history's plain-text lines, and render a line with its matches
// highlighted. DOM-free so it can be unit-tested; the terminal tile consumes it.

export interface FindMatch {
  row: number;   // index into the history lines
  start: number; // char offset of the match within the line
  end: number;
}

// findMatches returns every non-overlapping, case-insensitive occurrence of
// `query` across `lines`, in document order (top row first).
export function findMatches(lines: string[], query: string): FindMatch[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: FindMatch[] = [];
  for (let row = 0; row < lines.length; row++) {
    const hay = lines[row].toLowerCase();
    let i = 0;
    while ((i = hay.indexOf(q, i)) !== -1) {
      out.push({ row, start: i, end: i + q.length });
      i += q.length;
    }
  }
  return out;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESC[c]);
}

// highlightLine renders one line's plain text to HTML with every match wrapped in
// <mark class="sigil-find">, and the match at char offset `currentStart` (the
// active match, if it's on this line; pass -1 otherwise) additionally tagged
// sigil-find-cur. HTML is escaped, so this is safe to dangerouslySetInnerHTML.
export function highlightLine(text: string, query: string, currentStart: number): string {
  const q = query.toLowerCase();
  if (!q) return esc(text);
  const hay = text.toLowerCase();
  let out = '';
  let i = 0;
  let idx = 0;
  while ((idx = hay.indexOf(q, i)) !== -1) {
    out += esc(text.slice(i, idx));
    const cls = idx === currentStart ? 'sigil-find sigil-find-cur' : 'sigil-find';
    out += `<mark class="${cls}">${esc(text.slice(idx, idx + q.length))}</mark>`;
    i = idx + q.length;
  }
  out += esc(text.slice(i));
  return out;
}

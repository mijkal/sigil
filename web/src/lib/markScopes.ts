// Identity marks (custom image / line icon / image adjustments) are keyed by the
// shared scope key — `h:<host>` / `s:<host>::<session>` (see sessionColorStore's
// scopeKeyFor). Renaming a session changes that key, so every map keyed by the old
// scope has to move across or the mark silently disappears.
//
// Pure re-keying only: no React, no store, no I/O. The server-side image blob is a
// separate concern (SigilClient.copyImage) — this just moves the map entries.

// rekeyScope moves `from`'s entry to `to`, dropping the old key. Returns the SAME
// object when there's nothing to move (no entry, or from === to) so zustand can skip
// the re-render; otherwise a fresh copy — the input is never mutated. An existing
// `to` entry is overwritten, matching "the rename wins".
export function rekeyScope<T>(map: Record<string, T>, from: string, to: string): Record<string, T> {
  if (from === to || !(from in map)) return map;
  const out = { ...map };
  out[to] = out[from];
  delete out[from];
  return out;
}

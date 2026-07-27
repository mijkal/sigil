// Terminal *identity* report responses (DA1 / DA2 / DA3) that xterm.js emits
// automatically when a device-attributes QUERY is written into it. In sigil
// these queries arrive in the (often replayed) tmux output stream — tmux and TUI
// apps probe the "client terminal" on attach/resize. xterm's reply is delivered
// through onData and forwarded as PTY *input*; because of the browser round-trip
// the querier (tmux) frequently isn't in a state to consume it, so the reply
// leaks onto the shell prompt as visible garbage like `1;2c0;276;0c`
// (the `\x1b[?…` / `\x1b[>…` introducers get eaten by readline).
//
// A DA response is uniquely shaped: CSI, then a `?` / `>` / `=` intermediate,
// optional numeric params, and a final `c`. No key a human presses and no paste
// produces that shape (arrow/function keys have no intermediate and end in a
// letter; mouse reports use a `<` intermediate and end in M/m). And unlike
// cursor-position reports (`…R`), DSR (`…n`), DECRPM (`…$y`) or XTGETTCAP
// (`…+r…`), these identity reports are never consumed by a shell app via stdin.
// So it is safe to strip them from the input path, which kills the leak at the
// point of injection regardless of whether the query was live or replayed.
const DEVICE_ATTR_REPORT = /\x1b\[[?>=][0-9;]*c/g;

/** Remove DA1/DA2/DA3 identity-report responses from a terminal input chunk. */
export function stripDeviceAttrReports(data: string): string {
  // Fast path: no ESC → nothing to strip.
  if (data.indexOf('\x1b') === -1) return data;
  return data.replace(DEVICE_ATTR_REPORT, '');
}

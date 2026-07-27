// ScrollbackTap — turns a raw tmux pane byte stream into rendered LOGICAL lines
// incrementally, using a headless xterm.js Terminal + SerializeAddon.
//
// Why this exists: the VISIBLE terminal is permanently in xterm's ALTERNATE
// buffer (tmux draws its client UI there), which keeps no scrollback — so we
// cannot read history out of it. Instead we feed the raw `pipe-pane` byte stream
// (the program's actual output, not tmux's client UI) into a SECOND, offscreen
// Terminal whose NORMAL buffer accumulates real scrollback. As lines scroll off
// the top of that buffer's live screen they are FINALIZED; we serialize just the
// newly-finalized rows (SGR intact) and emit them as logical lines. Cost is
// O(new bytes), not O(whole buffer) like the old per-burst `capture-pane`.
//
// This is the same approach VS Code's terminal uses for scrollback restore
// (SerializeAddon). SerializeAddon joins wrapped continuation rows with '' and
// separates logical lines with '\r\n', so splitting on '\r\n' yields exactly the
// tmux-`-J`-style logical lines our renderer wants — width-independent, so each
// web client can still reflow them itself.

import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';

// Keep the offscreen buffer bounded so absolute row indices never drift from
// eviction (which would desync our pointer). We reset well below this ceiling.
const OFFSCREEN_SCROLLBACK = 50000;
// When finalized scrollback in the offscreen buffer passes this, reset it: the
// finalized lines are already emitted to (and owned by) the caller's history
// list, so the offscreen copy is disposable. Resetting keeps memory flat and
// indices low. A reset can split at most one in-flight logical line (cosmetic).
const RESET_THRESHOLD = 20000;

export interface ScrollbackTapOptions {
  cols: number;
  rows: number;
  /** Called with newly-finalized logical lines (raw SGR ANSI, no trailing \r\n). */
  onLines: (lines: string[]) => void;
}

export class ScrollbackTap {
  private term: Terminal;
  private serialize: SerializeAddon;
  private onLines: (lines: string[]) => void;
  private lastY = 0; // next un-emitted scrollback row (absolute buffer index)
  private disposed = false;

  constructor({ cols, rows, onLines }: ScrollbackTapOptions) {
    this.onLines = onLines;
    // Headless: no .open() → no renderer/DOM, just the parser + buffer.
    this.term = new Terminal({
      cols: Math.max(2, cols),
      rows: Math.max(2, rows),
      scrollback: OFFSCREEN_SCROLLBACK,
      allowProposedApi: true,
    });
    this.serialize = new SerializeAddon();
    this.term.loadAddon(this.serialize);
    // onWriteParsed fires at most once per frame after a write is fully parsed —
    // the buffer is in a consistent state and it's naturally coalesced.
    this.term.onWriteParsed(() => this.drain());
  }

  /** Feed raw pane bytes (from pipe-pane). */
  feed(bytes: Uint8Array): void {
    if (this.disposed || bytes.length === 0) return;
    this.term.write(bytes);
  }

  /** True when a full-screen TUI is on the alternate screen. The tap is fed the
   *  real pane byte stream (not tmux's client UI), so unlike the visible xterm
   *  its buffer type reflects the PROGRAM's actual alt-screen state — the reliable
   *  signal for "shell vs TUI". */
  isAltScreen(): boolean {
    return !this.disposed && this.term.buffer.active.type === 'alternate';
  }

  /** Keep the offscreen width in sync with the visible pane (affects wrapping,
   *  not logical-line content). Reflow renumbers rows, so re-seat the pointer. */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.term.resize(Math.max(2, cols), Math.max(2, rows));
    this.lastY = this.term.buffer.active.baseY;
  }

  /** The current (not-yet-finalized) live screen as logical lines — used by the
   *  soft-wrap live-tail view so it too reflows per-client. Cheap: O(rows). */
  liveTail(): string[] {
    if (this.disposed) return [];
    const b = this.term.buffer.active;
    if (b.length <= b.baseY) return [];
    const ansi = this.serialize.serialize({ range: { start: b.baseY, end: b.length - 1 } });
    const lines = ansi.split('\r\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  private drain(): void {
    const b = this.term.buffer.active;
    let stop = b.baseY; // rows [0, baseY) are finalized scrollback
    // Don't finalize a logical line whose wrapped continuation is still on the
    // live screen — walk back over the trailing isWrapped run.
    while (stop > this.lastY && b.getLine(stop)?.isWrapped) stop--;
    if (stop > this.lastY) {
      const ansi = this.serialize.serialize({ range: { start: this.lastY, end: stop - 1 } });
      this.lastY = stop;
      const lines = ansi.split('\r\n');
      // A serialize range ending exactly at a logical-line boundary yields a
      // trailing '' — drop a single one.
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      if (lines.length) this.onLines(lines);
    }
    // Reset only when nothing straddles the scrollback/live boundary (lastY has
    // caught up to baseY), so we never drop the start of an in-flight line.
    if (this.lastY === b.baseY && b.baseY > RESET_THRESHOLD) {
      this.term.reset();
      this.lastY = 0;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.term.dispose();
  }
}

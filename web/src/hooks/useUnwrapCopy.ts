import { useEffect } from 'react';
import type { Terminal } from '@xterm/xterm';
import { unwrapUrlsForCopy } from '../lib/urls';

/**
 * Repair wrap-broken URLs on their way to the clipboard.
 *
 * Selecting a long link in a pane and hitting copy yields the link in pieces,
 * because a TUI that lays out its own text (Claude Code's Ink renderer) emits a
 * REAL newline at the wrap point instead of letting the terminal auto-wrap. tmux
 * never marks such a row `wrapped`, so `capture-pane -J` won't join it and
 * xterm's wrapped-row handling has nothing to act on — both are correct, the
 * break really is in the byte stream. The only place left to fix it is the copy
 * itself.
 *
 * Deliberately passive: if the selection needs no repair the event is left
 * completely alone, so ordinary copying keeps the browser's native behaviour
 * (including any rich-text flavours) rather than being round-tripped through us.
 */
export function useUnwrapCopy(
  containerRef: React.RefObject<HTMLElement | null>,
  terminalRef: React.RefObject<Terminal | null>,
  fallbackCols = 0,
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onCopy = (e: ClipboardEvent) => {
      // xterm keeps its selection in a helper textarea, where
      // window.getSelection() reports nothing in some browsers — ask the
      // terminal directly first, then fall back to the DOM selection used by
      // the scrollback rows.
      const term = terminalRef.current;
      const text = (term?.hasSelection?.() ? term.getSelection() : '')
        || window.getSelection()?.toString()
        || '';
      if (!text) return;

      // The grid width the text was laid out at. The terminal is authoritative;
      // the caller's computed column count covers the case where no terminal is
      // mounted yet (scrollback-only selection right after attach).
      const cols = term?.cols || fallbackCols;
      const fixed = unwrapUrlsForCopy(text, cols);
      if (fixed === text) return;

      e.clipboardData?.setData('text/plain', fixed);
      e.preventDefault();
    };

    el.addEventListener('copy', onCopy);
    return () => el.removeEventListener('copy', onCopy);
  }, [containerRef, terminalRef, fallbackCols]);
}

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useToastStore } from './toastStore';

// Regression cover for the 2026-07-29 attach storm: a pane re-attached to a
// pruned session ~1/sec for 45 minutes. Every failure pushed its own toast, so
// the UI was unusable and the 200-entry history was flooded with one repeating
// event, evicting everything worth reading. Identical events must collapse.

// vitest runs with environment: 'node' (vite.config.ts), so there is no
// localStorage. toastStore guards its own access in try/catch, but the tests
// need a real store to assert against history persistence.
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => { mem.clear(); },
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
} as Storage;

const reset = () => {
  mem.clear();
  useToastStore.setState({ toasts: [], history: [], panelOpen: false, unseen: 0 });
};

describe('toastStore coalescing', () => {
  beforeEach(reset);

  it('collapses identical toasts into one card with a count', () => {
    const push = useToastStore.getState().push;
    for (let i = 0; i < 50; i++) {
      push({ type: 'error', title: 'Channel error', message: 'boom' });
    }
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].count).toBe(50);
  });

  it('does not flood history — one entry, count mirrored', () => {
    const push = useToastStore.getState().push;
    for (let i = 0; i < 300; i++) {
      push({ type: 'error', title: 'Channel error', message: 'boom' });
    }
    const { history } = useToastStore.getState();
    expect(history).toHaveLength(1);
    expect(history[0].count).toBe(300);
  });

  it('keeps genuinely different events separate', () => {
    const push = useToastStore.getState().push;
    push({ type: 'error', title: 'Channel error', message: 'a' });
    push({ type: 'error', title: 'Channel error', message: 'b' });
    push({ type: 'info', title: 'Channel error', message: 'a' });
    expect(useToastStore.getState().toasts).toHaveLength(3);
  });

  it('coalesces on dedupeKey even when the message text varies', () => {
    const push = useToastStore.getState().push;
    // This is the real storm shape: same target, different channel id each time.
    for (let i = 0; i < 20; i++) {
      push({
        type: 'error',
        title: 'Channel error — buildbox:api-dev',
        message: `ch_${i} exited with status 1`,
        dedupeKey: 'channel.error|buildbox:api-dev',
      });
    }
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].count).toBe(20);
  });

  it('bounds the on-screen stack while history keeps everything', () => {
    const push = useToastStore.getState().push;
    for (let i = 0; i < 12; i++) {
      push({ type: 'info', title: `distinct ${i}` });
    }
    const { toasts, history } = useToastStore.getState();
    expect(toasts.length).toBeLessThanOrEqual(4);
    expect(history).toHaveLength(12);
    // The newest survive on screen.
    expect(toasts[toasts.length - 1].title).toBe('distinct 11');
  });

  it('extends the dismiss timer while a count is climbing', () => {
    vi.useFakeTimers();
    try {
      const push = useToastStore.getState().push;
      push({ type: 'error', title: 'Channel error', durationMs: 1000 });
      vi.advanceTimersByTime(900);
      expect(useToastStore.getState().toasts).toHaveLength(1);
      // A repeat at 900ms must reset the clock, not let the original expire.
      push({ type: 'error', title: 'Channel error', durationMs: 1000 });
      vi.advanceTimersByTime(600); // 1500ms since the first push
      expect(useToastStore.getState().toasts).toHaveLength(1);
      expect(useToastStore.getState().toasts[0].count).toBe(2);
      vi.advanceTimersByTime(500); // 1100ms since the repeat
      expect(useToastStore.getState().toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a new burst after dismissal starts a fresh card', () => {
    vi.useFakeTimers();
    try {
      const push = useToastStore.getState().push;
      push({ type: 'error', title: 'Channel error', durationMs: 500 });
      vi.advanceTimersByTime(600);
      expect(useToastStore.getState().toasts).toHaveLength(0);
      push({ type: 'error', title: 'Channel error', durationMs: 500 });
      const { toasts } = useToastStore.getState();
      expect(toasts).toHaveLength(1);
      expect(toasts[0].count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismiss clears the pending timer', () => {
    vi.useFakeTimers();
    try {
      const { push, dismiss } = useToastStore.getState();
      const id = push({ type: 'info', title: 'x', durationMs: 1000 });
      dismiss(id);
      expect(useToastStore.getState().toasts).toHaveLength(0);
      // Re-push the same key: the stale timer must not remove the new toast.
      push({ type: 'info', title: 'x', durationMs: 1000 });
      vi.advanceTimersByTime(1001);
      expect(useToastStore.getState().toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

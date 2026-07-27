import { create } from 'zustand';

// Transient visual-effect state for UI triggers. Flash is a one-shot pulse
// (re-armed by bumping `nonce` so identical repeats replay the animation); tint
// is a sustained wash that clears itself after its duration. Audio and toast are
// fire-and-forget and don't live here.
interface TriggerState {
  flash: { color: string; durationMs: number; nonce: number } | null;
  tint: { color: string } | null;
  triggerFlash: (color: string, durationMs: number) => void;
  showTint: (color: string, durationMs: number) => void;
  clearTint: () => void;
}

let flashNonce = 0;
let tintTimer: ReturnType<typeof setTimeout> | null = null;

export const useTriggerStore = create<TriggerState>((set) => ({
  flash: null,
  tint: null,
  triggerFlash: (color, durationMs) => {
    flashNonce += 1;
    set({ flash: { color, durationMs, nonce: flashNonce } });
  },
  showTint: (color, durationMs) => {
    if (tintTimer) clearTimeout(tintTimer);
    set({ tint: { color } });
    tintTimer = setTimeout(() => {
      tintTimer = null;
      set({ tint: null });
    }, durationMs);
  },
  clearTint: () => {
    if (tintTimer) { clearTimeout(tintTimer); tintTimer = null; }
    set({ tint: null });
  },
}));

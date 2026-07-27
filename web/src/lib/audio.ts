// Tiny WebAudio beep for the `audio` trigger action. Self-contained (no asset,
// no network) so it works under the app's strict CSP. Lazily creates a single
// shared AudioContext and resumes it (browsers start it suspended until a user
// gesture — after the first interaction with the app this just works).

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

// playTone plays a short sine beep. Envelope ramps to avoid clicks. Best-effort:
// silently no-ops if WebAudio is unavailable or blocked.
export function playTone(hz: number, durationMs: number): void {
  const ac = context();
  if (!ac) return;
  const now = ac.currentTime;
  const dur = Math.max(0.04, durationMs / 1000);
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.value = hz;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.15, now + 0.01);
  gain.gain.setValueAtTime(0.15, now + dur - 0.03);
  gain.gain.linearRampToValueAtTime(0, now + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

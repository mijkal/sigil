// Full-screen, non-interactive overlay that renders the visual UI-trigger
// effects (flash pulse + sustained tint). Mounted once near the app root.
// Audio and toast effects are dispatched elsewhere; this layer is purely visual.
import { useEffect, useState } from 'react';
import { useTriggerStore } from '../stores/triggerStore';

export function TriggerEffectsLayer() {
  const flash = useTriggerStore((s) => s.flash);
  const tint = useTriggerStore((s) => s.tint);

  // Drive the flash animation off the store's nonce so repeats replay it.
  const [pulse, setPulse] = useState<{ color: string; durationMs: number; nonce: number } | null>(null);
  useEffect(() => {
    if (!flash) return;
    setPulse(flash);
    const t = setTimeout(() => setPulse(null), flash.durationMs);
    return () => clearTimeout(t);
  }, [flash]);

  return (
    <div aria-hidden style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 2000 }}>
      {/* Sustained tint: a soft edge-vignette wash so it's noticeable without
          obscuring terminal content. */}
      {tint && (
        <div
          style={{
            position: 'absolute', inset: 0,
            boxShadow: `inset 0 0 0 3px ${tint.color}, inset 0 0 60px ${tint.color}`,
            opacity: 0.5,
            transition: 'opacity 300ms ease',
          }}
        />
      )}
      {/* One-shot flash pulse. key=nonce remounts the element so the CSS
          animation restarts even on identical consecutive flashes. */}
      {pulse && (
        <div
          key={pulse.nonce}
          style={{
            position: 'absolute', inset: 0,
            background: pulse.color,
            animation: `sigil-trigger-flash ${pulse.durationMs}ms ease-out forwards`,
          }}
        />
      )}
      <style>{`
        @keyframes sigil-trigger-flash {
          0%   { opacity: 0; }
          12%  { opacity: 0.42; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Sigil } from './Sigil';
import { useSigilAnimStore } from '../stores/sigilAnimStore';

// The "summon": when a session opens into a tab, its sigil inscribes itself large
// and centred over the pane, then fades to reveal the live terminal — a half-second
// ritual that says "this session, now live". Mount-once; self-dismisses. Gated on
// the user's session-sigil animation preference.
export function SummonOverlay({ name, color }: { name: string; color?: string }) {
  const summon = useSigilAnimStore(s => s.summon);
  const [phase, setPhase] = useState<'show' | 'fading' | 'done'>('show');

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('fading'), 1100);
    const t2 = setTimeout(() => setPhase('done'), 1550);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  if (!summon || phase === 'done') return null;

  return (
    <div
      aria-hidden
      style={{
        position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20,
        // Matches the terminal ground so it cleanly veils the loading pane, dark in
        // either theme (the terminal itself is always dark).
        background: 'rgba(10,10,12,0.94)',
        opacity: phase === 'fading' ? 0 : 1,
        transition: 'opacity 0.45s ease',
      }}
    >
      <Sigil name={name} color={color} size={132} animate />
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: '0.2em',
        textTransform: 'uppercase', color: 'var(--color-muted)',
      }}>{name}</div>
    </div>
  );
}

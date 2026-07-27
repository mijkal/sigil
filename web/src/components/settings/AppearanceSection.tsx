import { useSigilAnimStore } from '../../stores/sigilAnimStore';

// Appearance settings — for now, the session-sigil animation preferences. The two
// switches are independent; turning both off is the "no sigil animation" state.
export function AppearanceSection() {
  const { summon, ambient, toggleSummon, toggleAmbient } = useSigilAnimStore();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ fontSize: 11, color: 'var(--color-muted)', lineHeight: 1.4 }}>
        How the session sigil animates. Both off = no sigil animation.
      </div>

      <ToggleRow label="Summon overlay on open" on={summon}
        hint="When a session opens into a tab, its sigil inscribes itself large over the pane, then fades to reveal the terminal."
        onClick={toggleSummon} />

      <ToggleRow label="Ambient empty-pane sigil" on={ambient}
        hint="Gently breathe the large sigil shown on an empty pane / the home screen. Off keeps it static."
        onClick={toggleAmbient} />
    </div>
  );
}

function Label({ text, hint }: { text: string; hint?: string }) {
  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500 }}>{text}</div>
      {hint && <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 2, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}

function ToggleRow({ label, hint, on, onClick }: { label: string; hint?: string; on: boolean; onClick: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}><Label text={label} hint={hint} /></div>
      <button onClick={onClick} aria-pressed={on} style={{
        width: 42, height: 24, borderRadius: 12, flexShrink: 0, position: 'relative', marginTop: 2,
        background: on ? 'var(--color-accent)' : 'var(--color-muted-dim)',
        border: 'none', cursor: 'pointer', transition: 'background 0.15s',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: on ? 20 : 2, width: 20, height: 20,
          borderRadius: '50%', background: '#fff', transition: 'left 0.15s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }} />
      </button>
    </div>
  );
}

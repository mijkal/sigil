import { useTerminalStore } from '../../stores/terminalStore';
import { useConnectionStore } from '../../stores/connectionStore';

// Terminal / performance settings — the buffer size and the wire/scroll toggles
// that also live on the pane toolbar, gathered here for discoverability.
export function TerminalSection() {
  const { overscan, setOverscan, binaryWs, toggleBinaryWs, unified, toggleUnified,
    pauseScrollRefresh, togglePauseScrollRefresh } = useTerminalStore();
  const client = useConnectionStore(s => s.client);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Scroll buffer */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Label text="Scroll buffer (overscan)"
          hint="Rows pre-rendered above/below the viewport. Larger = less black flash on a fast scroll, at the cost of more DOM/memory." />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="range" min={20} max={500} step={10} value={overscan}
            onChange={e => setOverscan(+e.target.value)} style={{ flex: 1 }} />
          <input type="number" min={20} max={500} value={overscan}
            onChange={e => setOverscan(+e.target.value)}
            style={{
              width: 64, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 13,
              background: 'var(--color-panel-alt)', color: 'var(--color-text)',
              border: '1px solid var(--color-border)', borderRadius: 4, padding: '3px 6px',
            }} />
          <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>rows</span>
        </div>
      </div>

      <ToggleRow label="Pause history refresh while scrolled up" on={pauseScrollRefresh}
        hint="Freeze the scrollback list while you're reading back through history so a fast scroll stays smooth. It catches up the instant you return to the live bottom."
        onClick={togglePauseScrollRefresh} />

      <ToggleRow label="Binary WS protocol" on={binaryWs}
        hint="Send terminal output/input as raw binary frames instead of base64-in-JSON — less bandwidth + CPU under heavy output. Applies live."
        onClick={() => { toggleBinaryWs(); client?.setBinary(!binaryWs); }} />

      <ToggleRow label="Unified scrollback" on={unified}
        hint="Seamless scrollback history above the live terminal (vs the classic terminal)."
        onClick={toggleUnified} />
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

import { useSessionStore } from '../../stores/sessionStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { useWidgetStore, type WidgetConfig, type WidgetKind } from '../../stores/widgetStore';

const input: React.CSSProperties = {
  background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 4,
  color: 'var(--color-text)', fontFamily: 'var(--font-mono)', fontSize: 12, padding: '4px 7px',
};
const lbl: React.CSSProperties = {
  fontSize: 10, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.06em',
  fontFamily: 'var(--font-mono)', marginBottom: 2, display: 'block',
};

const KIND_LABEL: Record<WidgetKind, string> = {
  'claude-usage': 'Claude usage',
  'codex-usage': 'Codex usage',
  'command': 'Command monitor',
};

export function WidgetsSection() {
  const hosts = useSessionStore(s => s.hosts);
  const serverUrl = useConnectionStore(s => s.serverUrl);
  const widgets = useWidgetStore(s => s.widgets);
  const add = useWidgetStore(s => s.add);
  const remove = useWidgetStore(s => s.remove);
  const update = useWidgetStore(s => s.update);
  const move = useWidgetStore(s => s.move);

  const firstConnected = hosts.find(h => h.status === 'connected')?.name ?? hosts[0]?.name ?? '';
  // The hub host (the box sigild runs on) is the best default for usage widgets:
  // same account, local scan, low latency. The hub is its own "self" host, whose
  // address is loopback (127.0.0.1) — that's the reliable signal (the browser may
  // reach sigild by a LAN IP or domain that matches no host's address). Fall back to
  // a server-URL address match, then the first connected host.
  const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
  const hubName =
    hosts.find(h => LOCAL.has(h.hostname) && h.status === 'connected')?.name
    || (() => {
      try {
        const hub = new URL(serverUrl).hostname;
        return hosts.find(h => h.hostname === hub && h.status === 'connected')?.name;
      } catch { return undefined; }
    })()
    || '';
  const usageHost = hubName || firstConnected;

  const addPreset = (kind: WidgetKind) => {
    if (kind === 'command') {
      add({ kind, name: 'Command', host: firstConnected, command: 'df -h /', intervalSec: 60 });
    } else {
      add({ kind, name: kind === 'codex-usage' ? 'Codex usage' : 'Claude usage', host: usageHost, intervalSec: 90 });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <p style={{ margin: '0 0 4px', fontSize: 12.5, color: 'var(--color-text)' }}>Sidebar widgets</p>
        <p style={{ margin: 0, fontSize: 11.5, color: 'var(--color-muted)', lineHeight: 1.5 }}>
          Glanceable monitors pinned to the sidebar. <strong>Claude / Codex usage</strong> read the agent's local
          transcripts on a host and show a 5-hour / today / 7-day token burndown. A <strong>Command monitor</strong>
          runs any command on a host every N seconds and displays its output.
        </p>
        <p style={{ margin: '5px 0 0', fontSize: 10.5, color: 'var(--color-muted-dim)', lineHeight: 1.5 }}>
          Note: there is no scriptable <code>claude usage</code> — the usage widgets compute a real token/message
          burndown from transcripts, not the official Max limit percentages (those are only shown in the CLI's
          interactive <code>/usage</code>).
        </p>
      </div>

      {/* Add buttons */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(['claude-usage', 'codex-usage', 'command'] as WidgetKind[]).map(k => (
          <button key={k} onClick={() => addPreset(k)} style={{
            ...input, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
            color: 'var(--color-accent)', borderColor: 'color-mix(in srgb, var(--color-accent) 45%, var(--color-border))',
          }}>+ {KIND_LABEL[k]}</button>
        ))}
      </div>

      {/* Existing widgets */}
      {widgets.length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--color-muted-dim)', fontFamily: 'var(--font-mono)' }}>No widgets yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {widgets.map((w, i) => (
            <WidgetEditor
              key={w.id} cfg={w} hosts={hosts.map(h => h.name)}
              onChange={p => update(w.id, p)} onRemove={() => remove(w.id)}
              onUp={i > 0 ? () => move(w.id, -1) : undefined}
              onDown={i < widgets.length - 1 ? () => move(w.id, 1) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WidgetEditor({ cfg, hosts, onChange, onRemove, onUp, onDown }: {
  cfg: WidgetConfig; hosts: string[];
  onChange: (patch: Partial<Omit<WidgetConfig, 'id'>>) => void;
  onRemove: () => void; onUp?: () => void; onDown?: () => void;
}) {
  const isCmd = cfg.kind === 'command';
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, color: 'var(--color-muted-dim)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{KIND_LABEL[cfg.kind]}</span>
        <span style={{ flex: 1 }} />
        {onUp && <button onClick={onUp} title="Move up" style={{ ...input, cursor: 'pointer', padding: '2px 6px' }}>↑</button>}
        {onDown && <button onClick={onDown} title="Move down" style={{ ...input, cursor: 'pointer', padding: '2px 6px' }}>↓</button>}
        <button onClick={onRemove} title="Remove" style={{ ...input, cursor: 'pointer', padding: '2px 8px', color: 'var(--color-danger)', borderColor: 'color-mix(in srgb, var(--color-danger) 40%, var(--color-border))' }}>Remove</button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ flex: '2 1 120px' }}>
          <span style={lbl}>Name</span>
          <input style={{ ...input, width: '100%' }} value={cfg.name} onChange={e => onChange({ name: e.target.value })} />
        </label>
        <label style={{ flex: '2 1 120px' }}>
          <span style={lbl}>Host</span>
          <select style={{ ...input, width: '100%' }} value={cfg.host} onChange={e => onChange({ host: e.target.value })}>
            {!hosts.includes(cfg.host) && <option value={cfg.host}>{cfg.host || '— pick a host —'}</option>}
            {hosts.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </label>
        <label style={{ flex: '1 1 80px' }}>
          <span style={lbl}>Every (s)</span>
          <input type="number" min={isCmd ? 10 : 20} style={{ ...input, width: '100%' }} value={cfg.intervalSec}
            onChange={e => onChange({ intervalSec: Math.max(isCmd ? 10 : 20, parseInt(e.target.value || '0', 10) || 0) })} />
        </label>
      </div>

      {isCmd ? (
        <label>
          <span style={lbl}>Command</span>
          <textarea rows={2} style={{ ...input, width: '100%', resize: 'vertical' }}
            placeholder="e.g. docker ps --format '{{.Names}}: {{.Status}}'"
            value={cfg.command ?? ''} onChange={e => onChange({ command: e.target.value })} />
        </label>
      ) : (
        <label style={{ maxWidth: 220 }}>
          <span style={lbl}>5h soft target (work tokens, optional)</span>
          <input type="number" min={0} style={{ ...input, width: '100%' }}
            placeholder="e.g. 2000000 for a % bar"
            value={cfg.softTarget ?? ''} onChange={e => onChange({ softTarget: e.target.value ? Math.max(0, parseInt(e.target.value, 10) || 0) : undefined })} />
        </label>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { Button } from '../../ui/Button';

export function ConnectionSection({ onClose }: { onClose?: () => void }) {
  const servers = useServerStore((s) => s.servers);
  const activeId = useServerStore((s) => s.activeId);
  const addAndConnect = useServerStore((s) => s.addAndConnect);
  const switchTo = useServerStore((s) => s.switchTo);
  const remove = useServerStore((s) => s.remove);
  const logout = useServerStore((s) => s.logout);

  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');

  const addServer = () => {
    if (!url.trim() || !token.trim()) return;
    addAndConnect(url, token, label); // connects in place
    onClose?.();
  };
  const doSwitch = (id: string) => { switchTo(id); onClose?.(); };
  const doLogout = () => { logout(); onClose?.(); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--color-muted)' }}>
        Saved sigil servers. Switch between instances, add another, or log out. Switching
        reconnects to the selected server.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {servers.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: '8px 0' }}>No saved servers.</div>
        )}
        {servers.map((s) => {
          const active = s.id === activeId;
          return (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 6,
              background: 'var(--color-panel-alt)',
              border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: active ? 'var(--color-success)' : 'var(--color-muted-dim)',
                boxShadow: active ? '0 0 6px var(--color-success)' : 'none',
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.label}{active && <span style={{ fontSize: 10, color: 'var(--color-success)', fontWeight: 500, marginLeft: 6 }}>active</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.url}</div>
              </div>
              {!active && <button style={linkBtn} onClick={() => doSwitch(s.id)}>switch</button>}
              <button style={{ ...linkBtn, color: 'var(--color-danger)' }} onClick={() => remove(s.id)}>remove</button>
            </div>
          );
        })}
      </div>

      {adding ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 11, borderRadius: 6, border: '1px solid var(--color-border)' }}>
          <Field label="Label (optional)"><input style={inp} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Home / Work / …" /></Field>
          <Field label="Server URL"><input style={{ ...inp, fontFamily: 'var(--font-mono)' }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://sigil.example.com" /></Field>
          <Field label="Token"><input style={{ ...inp, fontFamily: 'var(--font-mono)' }} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="bearer token" /></Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={addServer} disabled={!url.trim() || !token.trim()}>Add &amp; connect</Button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>+ Add server</Button>
          <span style={{ flex: 1 }} />
          <Button variant="danger" size="sm" onClick={doLogout}>Log out</Button>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>{label}</span>
      {children}
    </label>
  );
}

const linkBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-accent)', fontSize: 12, padding: '2px 4px', flexShrink: 0 };
const inp: React.CSSProperties = {
  background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 5,
  color: 'var(--color-text)', fontSize: 12, padding: '6px 8px', width: '100%', boxSizing: 'border-box',
};

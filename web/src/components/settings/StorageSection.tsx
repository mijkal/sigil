import { useCallback, useEffect, useState } from 'react';
import { useConnectionStore } from '../../stores/connectionStore';
import { useToastStore } from '../../stores/toastStore';
import { Button } from '../../ui/Button';
import type { Settings } from '../../types';

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function StorageSection() {
  const client = useConnectionStore((s) => s.client);
  const push = useToastStore((s) => s.push);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [dbSize, setDbSize] = useState<number | null>(null);
  const [chunks, setChunks] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    if (!client) return;
    try {
      const st = await client.getStatus() as { stats?: Record<string, number> };
      setDbSize(st.stats?.db_size_bytes ?? null);
      setChunks(st.stats?.scrollback_chunks ?? null);
    } catch { /* non-fatal */ }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    client.getSettings().then(setSettings).catch((e) => push({ type: 'error', title: 'Load settings failed', message: String(e) }));
    loadStats();
  }, [client, push, loadStats]);

  const save = async () => {
    if (!client || !settings) return;
    setSaving(true);
    try {
      const next = await client.updateSettings(settings);
      setSettings(next);
      push({ type: 'success', title: 'Settings saved', durationMs: 2500 });
    } catch (e) { push({ type: 'error', title: 'Save failed', message: String(e) }); }
    finally { setSaving(false); }
  };

  const maintenance = async (action: 'prune' | 'vacuum' | 'vacuum_full', confirmMsg?: string) => {
    if (!client) return;
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(action);
    try {
      const res = await client.runMaintenance(action);
      if (res.db_size_bytes != null) setDbSize(res.db_size_bytes);
      await loadStats();
      push({ type: 'success', title: `${action.replace('_', ' ')} done`, message: res.db_size_bytes != null ? `DB now ${fmtBytes(res.db_size_bytes)}` : undefined, durationMs: 4000 });
    } catch (e) { push({ type: 'error', title: `${action} failed`, message: String(e) }); }
    finally { setBusy(null); }
  };

  if (!settings) return <div style={{ color: 'var(--color-muted)', fontSize: 12, padding: '10px 0' }}>Loading…</div>;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings({ ...settings, [k]: v });
  const mb = Math.round((settings.max_bytes_per_session || 0) / (1024 * 1024));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Live stats */}
      <div style={{ display: 'flex', gap: 16, padding: '10px 12px', background: 'var(--color-panel-alt)', border: '1px solid var(--color-border)', borderRadius: 6 }}>
        <Stat label="Database size" value={dbSize != null ? fmtBytes(dbSize) : '—'} />
        <Stat label="Scrollback rows" value={chunks != null ? chunks.toLocaleString() : '—'} />
      </div>

      <p style={{ margin: 0, fontSize: 12, color: 'var(--color-muted)' }}>
        Scrollback is captured to SQLite. Retention keeps the database bounded; changes apply on the
        next hourly pass (or immediately via <em>Prune now</em>).
      </p>

      <Field label="Retention (days) — 0 keeps forever (age-based)">
        <input style={inp} type="number" min={0} value={settings.retention_days}
          onChange={(e) => set('retention_days', Math.max(0, Number(e.target.value) || 0))} />
      </Field>
      <Field label="Max scrollback per session (MB) — 0 disables the byte cap">
        <input style={inp} type="number" min={0} value={mb}
          onChange={(e) => set('max_bytes_per_session', Math.max(0, Number(e.target.value) || 0) * 1024 * 1024)} />
      </Field>
      <Field label="Events to keep (most recent)">
        <input style={inp} type="number" min={1} value={settings.event_keep}
          onChange={(e) => set('event_keep', Math.max(1, Number(e.target.value) || 1))} />
      </Field>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text)', cursor: 'pointer' }}>
        <input type="checkbox" checked={settings.auto_vacuum} onChange={(e) => set('auto_vacuum', e.target.checked)} />
        Auto-reclaim freed pages (incremental vacuum each pass)
      </label>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
      </div>

      {/* Maintenance actions */}
      <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>Maintenance</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="secondary" size="sm" disabled={busy !== null}
            onClick={() => maintenance('prune')}>{busy === 'prune' ? '…' : 'Prune now'}</Button>
          <Button variant="secondary" size="sm" disabled={busy !== null}
            onClick={() => maintenance('vacuum')}>{busy === 'vacuum' ? '…' : 'Reclaim (incremental)'}</Button>
          <Button variant="danger" size="sm" disabled={busy !== null}
            onClick={() => maintenance('vacuum_full', 'Full VACUUM rebuilds the entire database file to reclaim all free space. It briefly locks the database and can take a while on a large file. Continue?')}>
            {busy === 'vacuum_full' ? 'Rebuilding…' : 'Full VACUUM (rebuild)'}
          </Button>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--color-muted)' }}>
          Full VACUUM is the one-time operation that shrinks an already-large file on disk — run it
          at a quiet moment.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text)' }}>{value}</span>
      <span style={{ fontSize: 10, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
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

const inp: React.CSSProperties = {
  background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 5,
  color: 'var(--color-text)', fontSize: 12, padding: '6px 8px', width: '160px', boxSizing: 'border-box',
};

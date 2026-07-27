import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '../../stores/connectionStore';
import type { WidgetConfig } from '../../stores/widgetStore';
import type { ExecResult } from '../../types';
import { Freshness } from './WidgetBits';

// Generic monitor: run a command on a host every intervalSec, show its output.
export function CommandWidget({ cfg }: { cfg: WidgetConfig }) {
  const client = useConnectionStore(s => s.client);
  const [res, setRes] = useState<ExecResult | null>(null);
  const [ts, setTs] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!client || !cfg.host || !cfg.command) { setErr(!cfg.command ? 'no command' : 'no host'); return; }
      try {
        const r = await client.execOnHost(cfg.host, cfg.command);
        if (!alive.current) return;
        setRes(r); setTs(Date.now()); setStale(!!r.error); setErr(r.error ?? null);
      } catch (e) {
        if (!alive.current) return;
        setStale(true); setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive.current) timer = setTimeout(tick, Math.max(10, cfg.intervalSec) * 1000);
      }
    };
    tick();
    return () => { alive.current = false; clearTimeout(timer); };
  }, [client, cfg.host, cfg.command, cfg.intervalSec]);

  const out = (res?.stdout ?? '').trimEnd();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '2px 2px 4px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 10.5, color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={`${cfg.command} · on ${cfg.host}`}>
          {cfg.host} · <span style={{ color: 'var(--color-muted-dim)' }}>{cfg.command}</span>
        </span>
        <span style={{ flex: 1 }} />
        <Freshness ts={ts} stale={stale} />
      </div>

      {err && (
        <div style={{ fontSize: 10, color: 'var(--color-warning)', fontFamily: 'var(--font-mono)' }} title={err}>{err.slice(0, 80)}</div>
      )}

      {out ? (
        <pre style={{
          margin: 0, maxHeight: 132, overflow: 'auto',
          fontFamily: 'var(--font-mono)', fontSize: 10.5, lineHeight: 1.35,
          color: 'var(--color-text)', whiteSpace: 'pre', opacity: stale ? 0.6 : 1,
          background: 'color-mix(in srgb, var(--color-bg) 60%, transparent)',
          border: '1px solid var(--color-border)', borderRadius: 4, padding: '5px 7px',
        }}>{out}</pre>
      ) : (!err && (
        <div style={{ fontSize: 11, color: 'var(--color-muted-dim)', fontFamily: 'var(--font-mono)', padding: '4px 0' }}>
          {res ? '(no output)' : 'running…'}
        </div>
      ))}
      {res && (
        <div style={{ fontSize: 9.5, color: 'var(--color-muted-dim)', fontFamily: 'var(--font-mono)' }}>
          {res.ms}ms{res.truncated ? ' · output trimmed' : ''}
        </div>
      )}
    </div>
  );
}

// HostStatsPopover — the at-a-glance resource panel for one host.
// Desktop: a floating card anchored near the badge. Mobile: a centered modal.
// Reads live from the session store (WS metrics.update keeps it fresh while open).
import { useEffect } from 'react';
import type { CSSProperties } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { Sparkline, NetChart, Gauge, UsageBar, healthColor, fmtBytes } from './MetricCharts';
import { OsIcon } from './OsIcon';

function pctColor(pct: number): string {
  if (pct > 90) return 'var(--color-danger)';
  if (pct > 75) return 'var(--color-warning)';
  return 'var(--color-success)';
}

export function HostStatsPopover({
  host,
  address,
  anchor,
  isMobile,
  persistent = false,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: {
  host: string;
  address?: string;
  anchor: { x: number; y: number } | null;
  isMobile: boolean;
  persistent?: boolean;
  onClose: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const metrics = useSessionStore((s) => s.metricsByHost[host]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const card = (maxHeight: number | string) => (
    <div
      style={{ ...st.card, maxHeight }}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      {!metrics ? (
        <div style={{ padding: 24, color: 'var(--color-muted)', fontSize: 13 }}>
          No metrics yet for {host} — collecting…
        </div>
      ) : (
        <StatsBody host={host} address={address} m={metrics} onClose={onClose} />
      )}
    </div>
  );

  if (isMobile) {
    return (
      <div style={st.modalOverlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
        {card('86vh')}
      </div>
    );
  }

  // Desktop: viewport-aware placement. Open on whichever side of the badge has
  // more room (below vs above) and cap the card's height to that space so it
  // scrolls internally instead of running off the top/bottom of the screen.
  const M = 12;               // viewport margin
  const CARD_W = 300;         // matches st.card width
  const BADGE_H = 20;         // approx badge height (anchor.y is its bottom)
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ax = anchor?.x ?? M;
  const ay = anchor?.y ?? M;
  const left = Math.max(M, Math.min(ax, vw - CARD_W - M));
  const spaceBelow = vh - ay - M;
  const spaceAbove = ay - BADGE_H - M;
  const openDown = spaceBelow >= spaceAbove;
  const maxH = Math.max(160, (openDown ? spaceBelow : spaceAbove) - 6);
  const vpos: import('react').CSSProperties = openDown
    ? { top: ay + 6 }
    : { bottom: vh - (ay - BADGE_H) + 6 };
  const positioned = (
    <div style={{ position: 'fixed', left, ...vpos, zIndex: 950 }}>{card(maxH)}</div>
  );

  // Click-opened: full-screen backdrop for outside-click dismissal.
  // Hover-opened: NO backdrop — a screen-covering div would sit over the badge
  // and steal the pointer, causing enter/leave flicker. Hover close is driven
  // by the card's own onMouseLeave (onPointerLeave).
  if (persistent) {
    return (
      <div style={st.floatWrap} onClick={onClose}>
        {positioned}
      </div>
    );
  }
  return positioned;
}

function StatsBody({ host, address, m, onClose }: { host: string; address?: string; m: import('../types').HostMetrics; onClose: () => void }) {
  const info = m.info;
  const cur = m.current;
  const hist = m.history ?? [];

  const memPct = cur.mem_total > 0 ? (cur.mem_used / cur.mem_total) * 100 : 0;
  const swapPct = cur.swap_total > 0 ? (cur.swap_used / cur.swap_total) * 100 : 0;
  const diskPct = cur.disk_total > 0 ? (cur.disk_used / cur.disk_total) * 100 : 0;
  const loadPerCore = info.cores > 0 ? cur.load1 / info.cores : cur.load1;

  // Derived series.
  const loadSeries = hist.map((h) => h.load1);
  const pressureRing = info.has_psi ? Math.min(100, cur.psi_mem) : memPct;
  const pressureLabel = info.has_psi ? `${cur.psi_mem.toFixed(0)}%` : `${memPct.toFixed(0)}%`;
  const pressureSub = info.has_psi ? 'mem PSI' : 'mem used';

  // Net rates (bytes/s) from cumulative counters; guard counter resets.
  const rxRate: number[] = [];
  const txRate: number[] = [];
  for (let i = 1; i < hist.length; i++) {
    const dt = Math.max(1, hist[i].t - hist[i - 1].t);
    rxRate.push(Math.max(0, (hist[i].net_rx - hist[i - 1].net_rx) / dt));
    txRate.push(Math.max(0, (hist[i].net_tx - hist[i - 1].net_tx) / dt));
  }
  const lastRx = rxRate.length ? rxRate[rxRate.length - 1] : 0;
  const lastTx = txRate.length ? txRate[txRate.length - 1] : 0;

  return (
    <>
      {/* Header */}
      <div style={st.header}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: healthColor(m.health), boxShadow: `0 0 5px ${healthColor(m.health)}` }} />
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--color-text)' }}>{host}</span>
        {m.stale && <span style={st.staleTag}>stale</span>}
        <span style={{ flex: 1 }} />
        <button style={st.close} onClick={onClose} title="Close">✕</button>
      </div>

      {/* Static host info — label/value rows */}
      <div style={st.infoGrid}>
        <span style={st.infoK}>Host</span><span style={st.infoV}>{host}</span>
        {address && (<><span style={st.infoK}>Address</span><span style={st.infoV}>{address}</span></>)}
        <span style={st.infoK}>OS</span>
        <span style={{ ...st.infoV, display: 'flex', alignItems: 'center', gap: 5 }}>
          <OsIcon osPretty={info.os_pretty} os={info.os} size={13} opacity={0.9} color="var(--color-muted)" />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{info.os_pretty || info.os || '—'}</span>
        </span>
        <span style={st.infoK}>Kernel</span><span style={st.infoV}>{info.kernel || '—'} · {info.arch}</span>
        <span style={st.infoK}>CPU</span><span style={st.infoV}>{info.cpu_model || '—'}</span>
        <span style={st.infoK}>Cores</span><span style={st.infoV}>{info.cores}</span>
        <span style={st.infoK}>Memory</span><span style={st.infoV}>{fmtBytes(info.mem_total)}</span>
        <span style={st.infoK}>Disk</span><span style={st.infoV}>{fmtBytes(info.disk_total)}</span>
      </div>

      {/* Gauges */}
      <div style={st.gaugeRow}>
        <Gauge pct={pressureRing} label={pressureLabel} sub={pressureSub} color={pctColor(info.has_psi ? cur.psi_mem : memPct)} />
        <Gauge pct={memPct} label={`${memPct.toFixed(0)}%`} sub="memory" color={pctColor(memPct)} />
        <Gauge pct={Math.min(100, loadPerCore * 25)} label={cur.load1.toFixed(2)} sub={`load / ${info.cores}c`} color={pctColor(loadPerCore * 25)} />
      </div>

      {/* Load sparkline */}
      <div style={st.section}>
        <div style={st.label}>LOAD (1m) · {cur.load1.toFixed(2)}</div>
        <Sparkline values={loadSeries} color="var(--color-accent)" />
      </div>

      {/* Network */}
      <div style={st.section}>
        <div style={st.label}>
          NET · <span style={{ color: 'var(--color-success)' }}>▲ in {fmtBytes(lastRx)}/s</span>{' '}
          <span style={{ color: 'var(--color-accent)' }}>▼ out {fmtBytes(lastTx)}/s</span>
        </div>
        <NetChart rx={rxRate} tx={txRate} />
      </div>

      {/* Disk + swap bars */}
      <div style={st.section}>
        <div style={st.label}>DISK / · {fmtBytes(cur.disk_used)} / {fmtBytes(cur.disk_total)} ({diskPct.toFixed(0)}%)</div>
        <UsageBar pct={diskPct} color={pctColor(diskPct)} />
        {cur.swap_total > 0 && (
          <>
            <div style={{ ...st.label, marginTop: 8 }}>SWAP · {fmtBytes(cur.swap_used)} / {fmtBytes(cur.swap_total)} ({swapPct.toFixed(0)}%)</div>
            <UsageBar pct={swapPct} color={pctColor(swapPct)} />
          </>
        )}
      </div>

      {/* Top processes */}
      <div style={st.section}>
        <div style={st.label}>TOP PROCESSES</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {m.procs.length === 0 && <div style={{ color: 'var(--color-muted)', fontSize: 11 }}>—</div>}
          {m.procs.map((p, i) => (
            <div key={i} style={st.procRow}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <span style={{ color: 'var(--color-accent)', width: 48, textAlign: 'right' }}>{p.cpu.toFixed(0)}% cpu</span>
              <span style={{ color: 'var(--color-muted)', width: 48, textAlign: 'right' }}>{p.mem.toFixed(0)}% mem</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

const st: Record<string, CSSProperties> = {
  floatWrap: { position: 'fixed', inset: 0, zIndex: 900 },
  modalOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
  },
  card: {
    width: 300, maxWidth: '94vw', maxHeight: '86vh', overflowY: 'auto',
    background: 'var(--color-panel)', border: '1px solid var(--color-border)',
    borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
    padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
    fontFamily: 'var(--font-ui)',
  },
  header: { display: 'flex', alignItems: 'center', gap: 8 },
  staleTag: { fontSize: 9, color: 'var(--color-warning)', border: '1px solid var(--color-warning)', borderRadius: 4, padding: '0 4px' },
  close: { background: 'transparent', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', fontSize: 13 },
  infoGrid: {
    display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 3,
    fontSize: 11, fontFamily: 'var(--font-mono)', alignItems: 'baseline',
    padding: '6px 0', borderTop: '1px solid var(--color-border)', borderBottom: '1px solid var(--color-border)',
  },
  infoK: { color: 'var(--color-muted)', whiteSpace: 'nowrap' },
  infoV: { color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  gaugeRow: { display: 'flex', justifyContent: 'space-around', gap: 4 },
  section: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 10, color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', letterSpacing: 0.5 },
  procRow: { display: 'flex', gap: 6, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text)' },
};

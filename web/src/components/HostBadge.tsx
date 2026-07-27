// HostBadge — a small health pill shown to the LEFT of a host name in the
// sidebar. Fixed width so every host's name starts at the same x (no ragged
// alignment) and it never shifts when hover-only action buttons appear on the
// right. Health color: blue = nominal, amber = warn, red = err. Click or hover
// opens the HostStatsPopover. Renders nothing when the host has no metrics yet.
import { healthColor } from './MetricCharts';
import type { HostMetrics } from '../types';

const LABEL: Record<string, string> = {
  healthy: 'OK',
  warn: 'WARN',
  err: 'ERR',
  unknown: '—',
};

export function HostBadge({
  metrics,
  onOpen,
  onHoverOpen,
  onHoverClose,
}: {
  metrics: HostMetrics | undefined;
  onOpen: (e: React.MouseEvent) => void;
  onHoverOpen?: (e: React.MouseEvent) => void;
  onHoverClose?: () => void;
}) {
  if (!metrics) return null;
  const color = healthColor(metrics.health);
  const s = metrics.current;
  const memPct = s && s.mem_total > 0 ? Math.round((s.mem_used / s.mem_total) * 100) : 0;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onOpen(e);
      }}
      onMouseEnter={onHoverOpen}
      onMouseLeave={onHoverClose}
      title={`${metrics.host}: ${metrics.health}${metrics.stale ? ' (stale)' : ''} — click or hover for stats`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        flexShrink: 0,
        width: 46,
        padding: '1px 0',
        borderRadius: 6,
        border: `1px solid ${color}`,
        background: 'transparent',
        color,
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        lineHeight: 1.4,
        cursor: 'pointer',
        opacity: metrics.stale ? 0.55 : 1,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
          boxShadow: metrics.health !== 'unknown' ? `0 0 4px ${color}` : 'none',
          flexShrink: 0,
        }}
      />
      {memPct > 0 ? `${memPct}%` : LABEL[metrics.health]}
    </button>
  );
}

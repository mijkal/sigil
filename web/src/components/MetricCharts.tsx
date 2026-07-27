// Small, dependency-free SVG chart primitives for the host-stats popover.
// Everything is theme-token styled (var(--color-*)) so it tracks light/dark.
import type { CSSProperties } from 'react';

// Healthy is BLUE (not the bright --color-success green) — calmer, and reads as
// "nominal" rather than "actively good". Warn/err keep amber/red.
const HEALTH_COLOR: Record<string, string> = {
  healthy: 'var(--color-info)',
  warn: 'var(--color-warning)',
  err: 'var(--color-danger)',
  unknown: 'var(--color-muted)',
};

export function healthColor(h: string): string {
  return HEALTH_COLOR[h] ?? 'var(--color-muted)';
}

export function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

// Sparkline: a filled line chart over a numeric series, auto-scaled.
export function Sparkline({
  values,
  width = 240,
  height = 44,
  color = 'var(--color-accent)',
  max,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  max?: number;
}) {
  if (values.length < 2) {
    return <div style={{ height, ...emptyStyle }}>collecting…</div>;
  }
  const hi = max ?? Math.max(...values, 0.0001);
  const lo = Math.min(...values, 0);
  const span = hi - lo || 1;
  const stepX = width / (values.length - 1);
  const y = (v: number) => height - ((v - lo) / span) * (height - 4) - 2;
  const pts = values.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={area} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// Mirrored net in/out chart: a shared center baseline, inbound (rx) filled
// UPWARD, outbound (tx) filled DOWNWARD — so up = download, down = upload.
// Both halves share one scale so their magnitudes are directly comparable.
export function NetChart({
  rx,
  tx,
  width = 240,
  height = 48,
}: {
  rx: number[];
  tx: number[];
  width?: number;
  height?: number;
}) {
  if (rx.length < 2) return <div style={{ height, ...emptyStyle }}>collecting…</div>;
  const mid = height / 2;
  const hi = Math.max(...rx, ...tx, 1);
  const stepX = width / (rx.length - 1);
  const amp = mid - 2;
  const up = (v: number) => mid - (v / hi) * amp; // rx above center
  const dn = (v: number) => mid + (v / hi) * amp; // tx below center
  const line = (arr: number[], y: (v: number) => number) =>
    arr.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(' L');
  const rxArea = `M${line(rx, up)} L${width},${mid} L0,${mid} Z`;
  const txArea = `M${line(tx, dn)} L${width},${mid} L0,${mid} Z`;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={rxArea} fill="var(--color-success)" opacity={0.16} />
      <path d={`M${line(rx, up)}`} fill="none" stroke="var(--color-success)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <path d={txArea} fill="var(--color-accent)" opacity={0.16} />
      <path d={`M${line(tx, dn)}`} fill="none" stroke="var(--color-accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <line x1={0} y1={mid} x2={width} y2={mid} stroke="var(--color-border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// Gauge ring: a circular progress arc for a 0–100 percentage.
export function Gauge({
  pct,
  label,
  sub,
  color,
  size = 84,
}: {
  pct: number;
  label: string;
  sub?: string;
  color: string;
  size?: number;
}) {
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * c;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-border)" strokeWidth={6} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x="50%" y="48%" textAnchor="middle" dominantBaseline="middle" fontSize={16} fontWeight={600} fill="var(--color-text)">
          {label}
        </text>
        {sub && (
          <text x="50%" y="66%" textAnchor="middle" dominantBaseline="middle" fontSize={8} fill="var(--color-muted)">
            {sub}
          </text>
        )}
      </svg>
    </div>
  );
}

// Horizontal usage bar (disk).
export function UsageBar({ pct, color }: { pct: number; color: string }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ height: 8, borderRadius: 4, background: 'var(--color-border)', overflow: 'hidden' }}>
      <div style={{ width: `${w}%`, height: '100%', background: color, borderRadius: 4 }} />
    </div>
  );
}

const emptyStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 11,
  color: 'var(--color-muted)',
  fontFamily: 'var(--font-mono)',
};

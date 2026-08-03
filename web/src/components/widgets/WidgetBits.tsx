import type { CSSProperties } from 'react';

// Tiny inline sparkline (SVG polyline + soft area fill + emphasized endpoint).
export function Sparkline({ data, width = 200, height = 26, accent = 'var(--color-accent)' }: {
  data: number[]; width?: number; height?: number; accent?: string;
}) {
  const n = data.length;
  if (n === 0) return null;
  const max = Math.max(1, ...data);
  const dx = n > 1 ? width / (n - 1) : width;
  const pts = data.map((v, i) => [i * dx, height - (v / max) * (height - 2) - 1] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `0,${height} ${line} ${width},${height}`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden style={{ display: 'block' }}>
      <polygon points={area} fill={accent} opacity={0.12} />
      <polyline points={line} fill="none" stroke={accent} strokeWidth={1.3} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
      <circle cx={lx} cy={ly} r={1.8} fill={accent} />
    </svg>
  );
}

// A labelled horizontal bar (0..1 fill), with a value on the right.
//
// labelWidth is in `ch` by default because every label here renders in the mono
// font, where 1ch is exactly one character — so "5ch" fits five characters with
// no guesswork. The old fixed 30px truncated "quota" to "quo…" and clipped every
// model name; a pixel width cannot know how wide the user's font is.
export function Bar({ label, frac, value, accent = 'var(--color-accent)', danger = false, labelWidth }: {
  label: string; frac: number; value: string; accent?: string; danger?: boolean;
  labelWidth?: number | string;
}) {
  // Default to the label's own length, so a caller that says nothing still gets
  // a readable label rather than a clipped one.
  const width = labelWidth == null
    ? `${Math.max(2, label.length)}ch`
    : (typeof labelWidth === 'number' ? labelWidth : labelWidth);
  const col = danger ? 'var(--color-danger)' : accent;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
      <span style={{ color: 'var(--color-muted)', width, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={label}>{label}</span>
      <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'color-mix(in srgb, var(--color-border) 60%, transparent)', overflow: 'hidden' }}>
        <div style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%`, height: '100%', background: col, borderRadius: 3, transition: 'width 0.4s ease-out' }} />
      </div>
      <span style={{ color: 'var(--color-text)', flexShrink: 0, fontVariantNumeric: 'tabular-nums', minWidth: 52, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

// A small "just now / 42s ago" freshness label + optional stale/error dot.
export function Freshness({ ts, stale, style }: { ts: number | null; stale?: boolean; style?: CSSProperties }) {
  const label = ts == null ? '—' : (() => {
    const s = (Date.now() - ts) / 1000;
    if (s < 5) return 'just now';
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  })();
  return (
    <span title={stale ? 'stale — last refresh failed' : 'last refresh'} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10,
      fontFamily: 'var(--font-mono)', color: 'var(--color-muted-dim)', ...style,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: stale ? 'var(--color-warning)' : 'var(--color-success)', opacity: stale ? 1 : 0.7 }} />
      {label}
    </span>
  );
}

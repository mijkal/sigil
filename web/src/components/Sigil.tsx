import { useId, useMemo, type CSSProperties } from 'react';
import { activityStyle, activityDotStyle } from './ActivityDot';
import type { Session } from '../types';
import { useConnectionStore } from '../stores/connectionStore';
import { useSessionColorStore, resolveIdentity, type ImageAdjust } from '../stores/sessionColorStore';
import { ICON_BY_ID, LineIconGlyph } from '../lib/iconLibrary';

// A session's "sigil": a deterministic constellation generated from its name.
// Scattered stars (varying magnitude) joined by non-crossing lines, layered with
// a soft nebula haze + glow. The ink is `color` (a session/host accent, or the
// theme accent) applied via `currentColor`, so it works with a hex or a CSS var.
//
// Three perf/legibility tiers by size:
//   < 10px  → a single glowing dot (tab/tiny),
//   10–23px → the constellation without the blur filter (sidebar rows — cheap),
//   ≥ 24px  → the full mark with the feGaussianBlur nebula (header/modal/hero).

function hashStr(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface StarNode { a: number; x: number; y: number; mag: number; }
function build(name: string) {
  const rng = mulberry32(hashStr(name || ' '));
  const c = 50, R = 34, rad = (d: number) => (d * Math.PI) / 180;
  const N = 5 + Math.floor(rng() * 3);
  const sect = [...Array(12).keys()];
  for (let i = 11; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [sect[i], sect[j]] = [sect[j], sect[i]]; }
  const nodes: StarNode[] = [];
  for (let n = 0; n < N; n++) {
    const ang = sect[n] * 30 + (rng() * 20 - 10);
    const r = R * (0.34 + rng() * 0.62);
    nodes.push({ a: ang, x: c + r * Math.cos(rad(ang)), y: c + r * Math.sin(rad(ang)), mag: 1.3 + rng() * 2.2 });
  }
  const ord = [...nodes].sort((p, q) => p.a - q.a);
  const bright = nodes.reduce((m, n, i) => (n.mag > nodes[m].mag ? i : m), 0);
  const cx = nodes.reduce((s, n) => s + n.x, 0) / N;
  const cy = nodes.reduce((s, n) => s + n.y, 0) / N;
  const chord = rng() > 0.5 && N > 3 ? { A: ord[0], B: ord[Math.floor(N / 2)] } : null;
  return { nodes, ord, bright, cx, cy, chord };
}

export function Sigil({ name, color, size = 20, glow = true, animate = false }: {
  name: string; color?: string; size?: number; glow?: boolean; animate?: boolean;
}) {
  const uid = useId().replace(/:/g, '');
  const g = useMemo(() => build(name), [name]);
  const style: CSSProperties = {
    color: color ?? 'var(--color-accent)',
    overflow: 'visible', flexShrink: 0, display: 'block',
    // drop-shadow with no colour uses currentColor → the ink.
    filter: glow ? `drop-shadow(0 0 ${Math.max(1, size * 0.05).toFixed(1)}px) drop-shadow(0 0 ${Math.max(2, size * 0.15).toFixed(1)}px)` : undefined,
  };
  // When animating, tag strokes (data-s, drawn) and fills (data-f, bloomed).
  const dS = animate ? { 'data-s': '' } : {};
  const dF = animate ? { 'data-f': '' } : {};
  const cls = animate ? 'sigil-draw' : undefined;

  if (size < 10) {
    return (
      <svg width={size} height={size} viewBox="0 0 100 100" style={style} aria-hidden>
        <circle cx="50" cy="50" r="42" fill="currentColor" opacity="0.18" />
        <circle cx="50" cy="50" r="24" fill="currentColor" />
      </svg>
    );
  }

  const full = size >= 24;
  const line = g.ord.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
  return (
    <svg className={cls} width={size} height={size} viewBox="0 0 100 100" style={style} aria-hidden>
      {full && (
        <>
          <defs>
            <filter id={`neb-${uid}`} x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="6" /></filter>
          </defs>
          <g {...dF} filter={`url(#neb-${uid})`}>
            <circle cx={g.cx.toFixed(1)} cy={g.cy.toFixed(1)} r="20" fill="currentColor" opacity="0.10" />
            <circle cx={g.nodes[g.bright].x.toFixed(1)} cy={g.nodes[g.bright].y.toFixed(1)} r="11" fill="currentColor" opacity="0.14" />
          </g>
        </>
      )}
      <path {...dS} pathLength={1} d={line} fill="none" stroke="currentColor" strokeWidth={1.2} opacity={0.5} strokeLinecap="round" strokeLinejoin="round" />
      {g.chord && (
        <path {...dS} pathLength={1} d={`M${g.chord.A.x.toFixed(1)} ${g.chord.A.y.toFixed(1)} L${g.chord.B.x.toFixed(1)} ${g.chord.B.y.toFixed(1)}`}
          stroke="currentColor" strokeWidth={0.9} opacity={0.28} />
      )}
      {g.nodes.map((n, i) => (
        <g key={i} {...dF}>
          <circle cx={n.x.toFixed(1)} cy={n.y.toFixed(1)} r={(n.mag * 2.6).toFixed(1)} fill="currentColor" opacity={0.13} />
          <circle cx={n.x.toFixed(1)} cy={n.y.toFixed(1)} r={n.mag.toFixed(1)} fill="currentColor" />
        </g>
      ))}
    </svg>
  );
}

function adjustFilter(a: ImageAdjust): string | undefined {
  const parts: string[] = [];
  if (a.mono) parts.push('grayscale(1)');
  if (a.sat !== 1) parts.push(`saturate(${a.sat})`);
  return parts.length ? parts.join(' ') : undefined;
}

// IdentityMark — the resolved identity for a host/session: a custom uploaded image,
// a picked line-icon, or (default) the generative sigil. Falls back to the sigil
// whenever no host is given or nothing custom is set.
export function IdentityMark({ host, session, name, color, size = 20, glow = true, animate = false, bust }: {
  host?: string; session?: string; name: string; color?: string; size?: number; glow?: boolean; animate?: boolean; bust?: number;
}) {
  const images = useSessionColorStore(s => s.images);
  const icons = useSessionColorStore(s => s.icons);
  const adjust = useSessionColorStore(s => s.adjust);
  const client = useConnectionStore(s => s.client);
  const ink = color ?? 'var(--color-accent)';
  if (host) {
    const id = resolveIdentity({ images, icons, adjust }, host, session);
    if (id.kind === 'image' && client) {
      return (
        <img
          src={client.imageUrl(id.scope) + (bust ? `&v=${bust}` : '')} alt="" aria-hidden width={size} height={size}
          style={{
            width: size, height: size, borderRadius: '24%', objectFit: 'cover', flexShrink: 0,
            display: 'block', opacity: id.adjust.opacity, filter: adjustFilter(id.adjust),
            boxShadow: glow ? `0 0 ${Math.max(2, size * 0.14).toFixed(0)}px color-mix(in srgb, ${ink} 45%, transparent)` : undefined,
          }}
        />
      );
    }
    if (id.kind === 'icon' && id.iconId && ICON_BY_ID[id.iconId]) {
      return (
        <span style={{ display: 'inline-flex', flexShrink: 0, opacity: id.adjust.opacity,
          filter: glow ? `drop-shadow(0 0 ${Math.max(1, size * 0.06).toFixed(1)}px currentColor)` : undefined }}>
          <LineIconGlyph icon={ICON_BY_ID[id.iconId]} size={size} color={ink} />
        </span>
      );
    }
  }
  return <Sigil name={name} color={color} size={size} glow={glow} animate={animate} />;
}

// SessionGlyph — the sigil plus a small corner activity pip, so it carries BOTH
// identity (the mark, in the session's ink) and live state. The pip uses the SAME
// shape system as the status-footer ActivityDot (activityStyle → circle/triangle/
// diamond/square + glow/anim), via the shared activityDotStyle, so a state looks
// identical in the sidebar and the footer. Idle falls back to the attached(green)/
// detached(muted) circle. Drop-in replacement for ActivityDot wherever a session
// is listed.
export function SessionGlyph({ name, color, size = 16, activity, active, idleColor, host, session }: {
  name: string; color?: string; size?: number; activity?: Session['activity'];
  active?: boolean; idleColor?: string; host?: string; session?: string;
}) {
  const st = activityStyle(activity);
  const shape = st.shape ?? 'circle';
  const pip = st.bg ?? idleColor ?? (active ? 'var(--color-success)' : 'var(--color-muted-dim)');
  const ps = Math.max(4, Math.round(size * 0.34));
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, width: size, height: size }}>
      {/* The mark itself breathes while working — a whole-glyph cue you catch in
          peripheral vision, where a 5px pip alone is easy to miss. */}
      <span style={activity === 'working'
        ? { display: 'inline-flex', animation: 'sigil-mark-pulse 1.9s ease-in-out infinite' }
        : { display: 'inline-flex' }}>
        <IdentityMark host={host} session={session} name={name} color={color} size={size} glow={false} />
      </span>
      {activity === 'working' ? (
        // A spinning ring, not a filled pip: motion is what separates "mid-task"
        // from "stopped" at a glance, and nothing else in the sidebar rotates.
        <span key="working" title={st.title} className="sigil-working-arc"
          style={{ position: 'absolute', right: -1, bottom: -1, width: ps + 1, height: ps + 1,
            filter: 'drop-shadow(0 0 0.7px var(--color-panel)) drop-shadow(0 0 0.7px var(--color-panel))' }} />
      ) : (
        <span key={activity ?? (active ? 'active' : 'idle')} title={st.title}
          style={{ position: 'absolute', right: -1, bottom: -1,
            ...activityDotStyle({ st, size: ps, background: pip, shape, ring: 'var(--color-panel)' }) }} />
      )}
    </span>
  );
}

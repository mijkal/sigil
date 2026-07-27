import type { CSSProperties } from 'react';
import type { Session } from '../types';

// activityStyle maps the daemon's activity signal to the indicator's look. Each
// state gets a distinct SHAPE (not just a colour) so it reads at a glance even at
// 6px, where colour alone is ambiguous:
//   working   → circle,  accent, soft continuous breathe (alive / streaming)
//   waiting   → triangle, amber + glow, continuous breathe (NEEDS YOU — a decision)
//   attention → diamond, amber (stopped — maybe needs you; heuristic)
//   error     → square,  red + glow (API error / blocked)
//   done      → circle,  green (finished a turn)
type Shape = 'circle' | 'triangle' | 'diamond' | 'square';
export function activityStyle(a: string | undefined): {
  bg?: string; anim?: string; glow?: string; title?: string; shape?: Shape;
} {
  switch (a) {
    case 'working':   return { bg: 'var(--color-accent)',  shape: 'circle',   anim: 'sigil-breathe 2.6s ease-in-out infinite', title: 'Working…' };
    case 'waiting':   return { bg: 'var(--color-warning)', shape: 'triangle', anim: 'sigil-breathe 1.8s ease-in-out infinite', glow: 'var(--color-warning)', title: 'Needs you — waiting for your input' };
    case 'attention': return { bg: 'var(--color-warning)', shape: 'diamond',  anim: 'sigil-pop 0.42s ease-out', glow: 'var(--color-warning)', title: 'Stopped — may need you' };
    case 'error':     return { bg: 'var(--color-danger)',  shape: 'square',   anim: 'sigil-pop 0.42s ease-out', glow: 'var(--color-danger)',  title: 'Error / blocked' };
    case 'done':      return { bg: 'var(--color-success)', shape: 'circle',   anim: 'sigil-pop 0.42s ease-out', title: 'Done' };
    default: return {};
  }
}


// activityTint — a WASH behind the whole session row, to go with the pip.
//
// A 15px glyph in a dense list is easy to miss when you are scanning for the one
// session that stopped. Tinting the row itself makes the state legible
// peripherally, without adding another element to read. Kept very low-alpha so
// the list still reads as a list: the pip remains the precise signal, the tint is
// only what draws the eye to it.
//
// `done` deliberately gets NO tint — a finished turn needs nothing from you, and
// tinting it would compete with the states that do.
export function activityTint(a: string | undefined, hovered = false): string {
  const wash = (c: string, pct: number) => `color-mix(in srgb, var(${c}) ${pct}%, transparent)`;
  switch (a) {
    case 'waiting':   return wash('--color-warning', hovered ? 22 : 15);
    case 'attention': return wash('--color-warning', hovered ? 13 : 8);
    case 'error':     return wash('--color-danger',  hovered ? 20 : 13);
    case 'working':   return wash('--color-accent',  hovered ? 12 : 7);
    default:          return hovered ? 'rgba(99,102,241,0.1)' : 'transparent';
  }
}

const CLIP: Record<Shape, string | undefined> = {
  circle: undefined,
  square: undefined,
  triangle: 'polygon(50% 4%, 96% 96%, 4% 96%)',
  diamond: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
};

// activityDotStyle — the pip's visual: shape geometry + fill + anim + glow. Shared
// by ActivityDot (status footer) and SessionGlyph (sidebar corner pip) so the same
// state renders IDENTICALLY in both places. `ring` (optional) adds a panel-coloured
// halo that follows the clipped shape, separating a corner pip from the mark behind
// it — drop-shadow (not box-shadow/outline) so it tracks triangles/diamonds too.
export function activityDotStyle({ st, size, background, shape, ring }: {
  st: ReturnType<typeof activityStyle>; size: number; background: string; shape: Shape; ring?: string;
}): CSSProperties {
  const geo: CSSProperties =
    shape === 'circle' ? { borderRadius: '50%' }
    : shape === 'square' ? { borderRadius: 1 }
    : { clipPath: CLIP[shape] };
  const shadows: string[] = [];
  if (ring) shadows.push(`drop-shadow(0 0 0.6px ${ring})`, `drop-shadow(0 0 0.6px ${ring})`);
  if (st.glow) shadows.push(`drop-shadow(0 0 2px ${st.glow})`, `drop-shadow(0 0 3px color-mix(in srgb, ${st.glow} 55%, transparent))`);
  return {
    width: size, height: size, flexShrink: 0, display: 'inline-block',
    background, animation: st.anim, ...geo,
    filter: shadows.length ? shadows.join(' ') : undefined,
  };
}

// ActivityDot — the small per-session status indicator. Distinct shape per state so
// waiting (needs-you) is unmistakable; "working"/"waiting" breathe continuously, the
// rest pop once. Falls back to the attached(green)/detached(muted) circle when idle.
export function ActivityDot({ session, size = 6 }: { session: Session; size?: number }) {
  const a = session.activity;
  const st = activityStyle(a);
  const state = a ?? (session.status === 'active' ? 'active' : 'detached');
  const shape = st.shape ?? 'circle';
  const background = st.bg ?? (session.status === 'active' ? 'var(--color-success)' : 'var(--color-muted-dim)');
  const title = st.title
    ?? (session.status === 'active' ? 'Attached' : 'Detached');
  // "working" renders as a rotating ring rather than a filled pip: motion is what
  // distinguishes "mid-task" from "stopped" at a glance, and the ring is hollow so
  // it never competes with the solid amber of a session that actually needs you.
  if (a === 'working') {
    return (
      <span
        key={state}
        title={title}
        className="sigil-working-arc"
        style={{ width: size, height: size, flexShrink: 0, display: 'inline-block' }}
      />
    );
  }
  return (
    <span key={state} title={title} style={activityDotStyle({ st, size, background, shape })} />
  );
}

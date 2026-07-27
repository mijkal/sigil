import type { CSSProperties } from 'react';

// BrandMark — the FIXED 'S' constellation. Same visual language as the generative
// session sigils (star nodes + a hairline spine, ink via `currentColor`), but
// hand-placed and DETERMINISTIC: this is the stable brand mark, the one that has
// to survive being a 16px browser-tab icon.
//
// This IS the official Sigil logo — `SigilLogo`/`SigilLogoBig` render it, so the
// fixed 'S' appears everywhere the app shows its own mark (header, About, sidebar,
// tiles, empty pane) AND as the favicon / PWA / home-screen icon. The GENERATIVE
// sigils (Sigil.tsx) remain for per-SESSION marks — a mark per session — not for
// the brand. `animate` inscribes the mark in via the shared `sigil-draw` CSS.
//
// The node table below is the canonical source; `web/public/{favicon,icon,
// mask-icon}.svg` (and the PNGs cut from them) are hand-inlined from the SAME
// numbers — change them together.
//
// Geometry: 9 stars with exact 180° rotational symmetry about (50,50) — the
// letterform's own symmetry — walked as one open polyline. Terminals curl
// vertically (that hook, not the diagonal, is what separates an 'S' from a 'Z'
// once the mark is only 16 pixels tall).
const STARS: Array<[x: number, y: number, mag: number]> = [
  [71, 40, 2.0], // top-right terminal
  [66, 22, 2.4],
  [45, 15, 3.0], // apex
  [28, 27, 3.4], // top-bowl shoulder
  [50, 50, 4.2], // waist — brightest
  [72, 73, 3.4], // bottom-bowl shoulder
  [55, 85, 3.0],
  [34, 78, 2.4],
  [29, 60, 2.0], // bottom-left terminal
];
const SPINE = STARS.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');

// Weights by rendered size. A hairline spine is right at hero sizes and simply
// disappears in a tab, so the spine thickens and the stars swell as the mark
// shrinks. No nebula/blur at any size — it turns to mud below 32px, and a
// favicon has to stay crisp.
function weights(size: number) {
  if (size <= 20) return { spine: 9, star: 1.3, ink: 0.95 };
  if (size <= 32) return { spine: 7, star: 1.2, ink: 0.92 };
  if (size <= 64) return { spine: 4.5, star: 1.05, ink: 0.8 };
  return { spine: 3.2, star: 1, ink: 0.7 };
}

export function BrandMark({ size = 28, color, glow = false, animate = false, style, className }: {
  size?: number; color?: string; glow?: boolean; animate?: boolean; className?: string; style?: CSSProperties;
}) {
  const w = weights(size);
  // Reuse the shared draw-in: `sigil-draw` + [data-s] inscribes the spine
  // (stroke-dasharray) and [data-f] blooms the stars — same keyframes as Sigil.
  const cls = [animate ? 'sigil-draw' : '', className].filter(Boolean).join(' ') || undefined;
  const dS = animate ? { 'data-s': '' } : {};
  const dF = animate ? { 'data-f': '' } : {};
  return (
    <svg
      className={cls}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden
      style={{
        color: color ?? 'var(--color-accent)',
        flexShrink: 0,
        display: 'block',
        // drop-shadow with no colour uses currentColor → the ink (as in Sigil).
        filter: glow && size > 32 ? `drop-shadow(0 0 ${Math.max(2, size * 0.08).toFixed(1)}px)` : undefined,
        ...style,
      }}
    >
      <path
        {...dS}
        pathLength={1}
        d={SPINE}
        fill="none"
        stroke="currentColor"
        strokeWidth={w.spine}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={w.ink}
      />
      {STARS.map(([x, y, mag], i) => (
        <circle key={i} {...dF} cx={x} cy={y} r={(mag * w.star).toFixed(2)} fill="currentColor" />
      ))}
    </svg>
  );
}

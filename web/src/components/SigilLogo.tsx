import { useState, type CSSProperties } from 'react';
import { BrandMark } from './BrandMark';

// The logo is the OFFICIAL Sigil mark — the fixed 'S' constellation (BrandMark),
// the one true logo everywhere the app shows its own identity. Ink follows the
// theme accent. `animate` inscribes it in; `summonOnce` inscribes only the first
// time the logo appears in an app session (the app-init "summon"). The generative
// sigils are for per-SESSION marks, not the brand.
let appSummoned = false;

export function SigilLogo({ size = 28, style, className, animate, summonOnce }: {
  size?: number; className?: string; style?: CSSProperties;
  animate?: boolean; summonOnce?: boolean;
}) {
  const [draw] = useState(() => {
    if (summonOnce) {
      if (appSummoned) return false;
      appSummoned = true;
      return true;
    }
    return !!animate;
  });
  return (
    <span className={className} aria-label="Sigil" style={{ display: 'inline-flex', flexShrink: 0, ...style }}>
      <BrandMark size={size} color="var(--color-accent)" glow animate={draw} />
    </span>
  );
}

export function SigilLogoBig({ size = 64, animate }: { size?: number; animate?: boolean }) {
  return (
    <span aria-label="Sigil" style={{ display: 'inline-flex' }}>
      <BrandMark size={size} color="var(--color-accent)" glow animate={!!animate} />
    </span>
  );
}

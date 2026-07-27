import { useEffect, useRef, useState } from 'react';
import { PALETTE } from '../stores/sessionColorStore';
import { Popover } from '../ui/Popover';

// ── colour maths (hex/rgba ↔ hsv) ──────────────────────────────────────────────
function parseColor(c: string): [number, number, number, number] | null {
  const s = c.trim();
  const hm = s.match(/^#?([0-9a-f]{3,8})$/i);
  if (hm) {
    let h = hm[1];
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    if (h.length === 6) h += 'ff';
    if (h.length !== 8) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16) / 255];
  }
  const rm = s.match(/rgba?\(([^)]+)\)/i);
  if (rm) { const p = rm[1].split(',').map(v => parseFloat(v)); return [p[0] || 0, p[1] || 0, p[2] || 0, p[3] === undefined ? 1 : p[3]]; }
  return null;
}
function toHex(r: number, g: number, b: number, a = 1): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return a >= 1 ? `#${h(r)}${h(g)}${h(b)}` : `#${h(r)}${h(g)}${h(b)}${h(a * 255)}`;
}
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx];
}
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// ColorSpectrum — a hue/sat/value picker + hex/rgba input, for arbitrary custom
// colours beyond the quick palette. Emits a hex (with alpha when < 1).
export function ColorSpectrum({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parsed = parseColor(value) ?? [59, 130, 246, 1];
  const [h, s, v] = rgbToHsv(parsed[0], parsed[1], parsed[2]);
  const a = parsed[3];
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(value);
  useEffect(() => { if (/^#|^rgb/i.test(value)) setText(value); }, [value]);

  const emit = (nh: number, ns: number, nv: number, na = a) => {
    const [r, g, b] = hsvToRgb(nh, ns, nv);
    const hex = toHex(r, g, b, na);
    setText(hex); onChange(hex);
  };
  const drag = (ref: React.RefObject<HTMLDivElement>, e: React.PointerEvent, fn: (fx: number, fy: number) => void) => {
    const el = ref.current; if (!el) return;
    const at = (cx: number, cy: number) => { const r = el.getBoundingClientRect(); fn(Math.max(0, Math.min(1, (cx - r.left) / r.width)), Math.max(0, Math.min(1, (cy - r.top) / r.height))); };
    at(e.clientX, e.clientY);
    const mv = (ev: PointerEvent) => at(ev.clientX, ev.clientY);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const hueColor = `hsl(${h.toFixed(0)}, 100%, 50%)`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} onClick={e => e.stopPropagation()}>
      <div ref={svRef} onPointerDown={e => drag(svRef, e, (fx, fy) => emit(h, fx, 1 - fy))}
        style={{
          position: 'relative', height: 96, borderRadius: 8, cursor: 'crosshair', touchAction: 'none',
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${hueColor}`,
          border: '1px solid var(--color-border)',
        }}>
        <span style={{ position: 'absolute', left: `${s * 100}%`, top: `${(1 - v) * 100}%`, width: 12, height: 12, borderRadius: '50%', transform: 'translate(-50%,-50%)', border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,.5)', pointerEvents: 'none' }} />
      </div>
      <div ref={hueRef} onPointerDown={e => drag(hueRef, e, (fx) => emit(fx * 360, s || 1, v || 1))}
        style={{ position: 'relative', height: 12, borderRadius: 6, cursor: 'pointer', touchAction: 'none', background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)', border: '1px solid var(--color-border)' }}>
        <span style={{ position: 'absolute', left: `${(h / 360) * 100}%`, top: '50%', width: 12, height: 12, borderRadius: '50%', transform: 'translate(-50%,-50%)', border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,.5)', pointerEvents: 'none' }} />
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ width: 20, height: 20, borderRadius: 5, flexShrink: 0, background: /^#|^rgb/i.test(value) ? value : hueColor, border: '1px solid var(--color-border)' }} />
        <input value={text} spellCheck={false}
          onChange={e => { const t = e.target.value; setText(t); const p = parseColor(t); if (p) onChange(toHex(p[0], p[1], p[2], p[3])); }}
          placeholder="#rrggbb / rgba(…)"
          style={{ flex: 1, minWidth: 0, background: 'var(--color-panel-alt)', border: '1px solid var(--color-border)', borderRadius: 6, color: 'var(--color-text)', fontFamily: 'var(--font-mono)', fontSize: 12, padding: '5px 8px', outline: 'none' }} />
      </div>
    </div>
  );
}

// A popover of quick swatches + spectrum + hex, anchored at a screen point.
export function ColorPickerMenu({ x, y, current, label, onPick, onClose }: {
  x: number; y: number;
  current: string | null;
  label?: string;
  onPick: (color: string | null) => void;
  onClose: () => void;
}) {
  return (
    <Popover x={x} y={y} width={220} maxHeight={360} onClose={onClose}
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {label && <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>{label}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: 6 }}>
        {PALETTE.map(c => (
          <button key={c.value} title={c.name} onClick={() => onPick(c.value)}
            style={{ aspectRatio: '1', borderRadius: '50%', cursor: 'pointer', background: c.value, border: current === c.value ? '2px solid var(--color-text)' : '2px solid transparent', boxShadow: current === c.value ? '0 0 0 1px var(--color-text)' : 'none' }} />
        ))}
      </div>
      <ColorSpectrum value={current ?? 'var(--color-accent)'} onChange={onPick} />
      <button onClick={() => { onPick(null); onClose(); }}
        style={{ width: '100%', padding: '5px 0', borderRadius: 6, cursor: 'pointer', background: 'none', border: '1px solid var(--color-border)', color: current ? 'var(--color-muted)' : 'var(--color-text)', fontSize: 11 }}>Default</button>
    </Popover>
  );
}

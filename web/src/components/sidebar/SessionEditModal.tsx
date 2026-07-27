import { useRef, useState } from 'react';
import { Modal } from '../../ui/Modal';
import { IdentityMark } from '../Sigil';
import {
  useSessionColorStore, PALETTE, scopeKeyFor, DEFAULT_ADJUST, type ImageAdjust,
} from '../../stores/sessionColorStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { ICON_LIBRARY, LineIconGlyph } from '../../lib/iconLibrary';
import { downscaleToSquare } from '../../lib/imageProcessing';
import { ColorSpectrum } from '../ColorPickerMenu';
import { Button } from '../../ui/Button';
import type { Session } from '../../types';

// Full session editor: rename, accent, and the identity MARK — the generative
// sigil, a custom uploaded image, or a picked line-icon (+ image adjustments).
export function SessionEditModal({ session, onClose, onRename }: {
  session: Session;
  onClose: () => void;
  onRename: (newName: string) => void;
}) {
  const host = session.host_name;
  const scope = scopeKeyFor(host, session.name);
  const hosts = useSessionColorStore(s => s.hosts);
  const sessions = useSessionColorStore(s => s.sessions);
  const images = useSessionColorStore(s => s.images);
  const icons = useSessionColorStore(s => s.icons);
  const adjustMap = useSessionColorStore(s => s.adjust);
  const setSessionColor = useSessionColorStore(s => s.setSessionColor);
  const markImage = useSessionColorStore(s => s.markImage);
  const unmarkImage = useSessionColorStore(s => s.unmarkImage);
  const setIcon = useSessionColorStore(s => s.setIcon);
  const setAdjustStore = useSessionColorStore(s => s.setAdjust);
  const migrateMarks = useSessionColorStore(s => s.migrateMarks);
  const client = useConnectionStore(s => s.client);

  const [name, setName] = useState(session.name);
  const [color, setColor] = useState<string | null>(sessions[`${host}::${session.name}`] ?? null);
  const [busy, setBusy] = useState(false);
  const [bust, setBust] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const hostDefault = hosts[host] ?? null;
  const previewInk = color ?? hostDefault ?? 'var(--color-accent)';
  const hasImage = !!images[scope];
  const curIcon = icons[scope];
  const adjust = adjustMap[scope] ?? DEFAULT_ADJUST;
  const markKind: 'image' | 'icon' | 'sigil' = hasImage ? 'image' : curIcon ? 'icon' : 'sigil';

  // Mark edits apply IMMEDIATELY (they're server actions, keyed to the current
  // name); name/colour apply on Save.
  const onFile = async (f?: File | null) => {
    if (!client || !f) return;
    setBusy(true);
    try {
      const blob = await downscaleToSquare(f, 256);
      await client.uploadImage(scope, blob);
      setIcon(scope, null);   // image supersedes an icon
      markImage(scope);
      setBust(b => b + 1);
    } catch { /* ignore — leave prior mark */ } finally { setBusy(false); }
  };
  const pickIcon = (id: string) => { client?.deleteImage(scope).catch(() => {}); unmarkImage(scope); setIcon(scope, id); };
  const useSigil = () => { client?.deleteImage(scope).catch(() => {}); unmarkImage(scope); setIcon(scope, null); };
  const patchAdjust = (p: Partial<ImageAdjust>) => setAdjustStore(scope, { ...adjust, ...p });

  // A rename changes the scope key, so the mark has to move with it: the server
  // image is copied to the new scope (then the old one dropped, best-effort), and
  // the icon/adjust maps are re-keyed. If the copy fails we keep the old image and
  // let the renamed session fall back to its generative sigil.
  const save = async () => {
    const finalName = name.trim() || session.name;
    if (finalName !== session.name) {
      const nextScope = scopeKeyFor(host, finalName);
      let copiedImage = false;
      if (hasImage && client) {
        setBusy(true);
        try { await client.copyImage(scope, nextScope); copiedImage = true; } catch { /* keep the old image */ } finally { setBusy(false); }
      }
      migrateMarks(scope, nextScope, copiedImage);
      if (copiedImage) client?.deleteImage(scope).catch(() => {});
      onRename(finalName);
      setSessionColor(host, session.name, null);
    }
    setSessionColor(host, finalName, color);
    onClose();
  };

  const label = (t: string) => (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-muted)' }}>{t}</span>
  );

  return (
    <Modal open onClose={onClose} width={460} labelledBy="session-edit-title">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '22px 22px 20px', maxHeight: '86vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 id="session-edit-title" style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--color-text)' }}>Edit session</h2>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--color-muted)', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        {/* Live mark preview */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 18, padding: '16px 18px', borderRadius: 12,
          background: 'radial-gradient(140px 90px at 22% 45%, var(--color-panel-alt), var(--color-panel))',
          border: '1px solid var(--color-border)',
        }}>
          <IdentityMark host={host} session={session.name} name={name.trim() || session.name} color={previewInk} size={72} bust={bust} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name.trim() || session.name}</div>
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 3 }}>
              {markKind === 'image' ? 'custom image' : markKind === 'icon' ? 'line icon' : 'generative sigil'} &middot; on {host}
            </div>
          </div>
        </div>

        {/* Name */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {label('Name')}
          <input value={name} spellCheck={false} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
            style={{ background: 'var(--color-panel-alt)', border: '1px solid var(--color-border)', borderRadius: 8, color: 'var(--color-text)', fontFamily: 'var(--font-mono)', fontSize: 14, padding: '9px 11px', outline: 'none' }} />
        </label>

        {/* Mark: sigil / upload image / pick icon */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {label('Mark')}
          <div style={{ display: 'flex', gap: 8 }}>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
              onChange={e => { onFile(e.target.files?.[0]); e.currentTarget.value = ''; }} />
            <MarkBtn active={markKind === 'sigil'} onClick={useSigil}>Sigil</MarkBtn>
            <MarkBtn active={markKind === 'image'} onClick={() => fileRef.current?.click()}>{busy ? 'Uploading…' : hasImage ? 'Replace image' : 'Upload image'}</MarkBtn>
            <MarkBtn active={markKind === 'icon'} onClick={() => { if (markKind !== 'icon') pickIcon(ICON_LIBRARY[0].id); }}>Icon</MarkBtn>
          </div>

          {/* Icon library grid */}
          {markKind === 'icon' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: 6, marginTop: 2 }}>
              {ICON_LIBRARY.map(ic => (
                <button key={ic.id} title={ic.label} onClick={() => pickIcon(ic.id)}
                  style={{
                    aspectRatio: '1', display: 'grid', placeItems: 'center', borderRadius: 8, cursor: 'pointer',
                    background: curIcon === ic.id ? 'color-mix(in srgb, var(--color-accent) 16%, transparent)' : 'var(--glass-1, rgba(255,255,255,.04))',
                    border: `1px solid ${curIcon === ic.id ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  }}>
                  <LineIconGlyph icon={ic} size={18} color={curIcon === ic.id ? previewInk : 'var(--color-muted)'} />
                </button>
              ))}
            </div>
          )}

          {/* Adjustments (image only) */}
          {markKind === 'image' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 }}>
              <Slider label="Saturation" min={0} max={2} step={0.05} value={adjust.sat} onChange={v => patchAdjust({ sat: v })} />
              <Slider label="Opacity" min={0.2} max={1} step={0.05} value={adjust.opacity} onChange={v => patchAdjust({ opacity: v })} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-muted)', cursor: 'pointer' }}>
                <input type="checkbox" checked={adjust.mono} onChange={e => patchAdjust({ mono: e.target.checked })} />
                Monochrome
              </label>
            </div>
          )}
        </div>

        {/* Accent */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {label('Accent')}
          <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', alignItems: 'center' }}>
            {PALETTE.map(c => (
              <button key={c.value} title={c.name} onClick={() => setColor(c.value)}
                style={{ width: 26, height: 26, borderRadius: '50%', cursor: 'pointer', background: c.value, border: color === c.value ? '2px solid var(--color-text)' : '2px solid transparent', boxShadow: color === c.value ? '0 0 0 1px var(--color-text)' : 'none' }} />
            ))}
            <button onClick={() => setColor(null)}
              style={{ height: 26, padding: '0 12px', borderRadius: 14, cursor: 'pointer', fontSize: 12, background: 'none', color: color ? 'var(--color-muted)' : 'var(--color-text)', border: `1px solid ${color ? 'var(--color-border)' : 'var(--color-accent)'}` }}>
              {hostDefault ? 'Inherit host' : 'Default'}
            </button>
          </div>
          {/* Spectrum + hex/rgba */}
          <ColorSpectrum value={color ?? previewInk} onChange={setColor} />
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}

function MarkBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button variant={active ? 'primary' : 'glass'} size="sm" onClick={onClick} style={{ flex: 1 }}>{children}</Button>
  );
}

function Slider({ label, min, max, step, value, onChange }: {
  label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--color-muted)' }}>
      <span style={{ width: 78, flexShrink: 0 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ flex: 1, accentColor: 'var(--color-accent)' }} />
      <span style={{ width: 34, textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>{value.toFixed(2)}</span>
    </label>
  );
}

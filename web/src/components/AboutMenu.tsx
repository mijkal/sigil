// AboutMenu — a centered "About" modal opened from the top-left SIGIL banner.
// Shows build/version info for the web client (baked in at build time) and the
// hub daemon (fetched live from /api/v1/status).
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useConnectionStore } from '../stores/connectionStore';
import { SigilLogoBig } from './SigilLogo';
import { Modal } from '../ui/Modal';

// Single source of truth for the project's public home. Referenced by the About
// box and anywhere else that links "source" — change it here only.
export const REPO_URL = 'https://github.com/mijkal/sigil';


function fmtUptime(sec: number): string {
  if (!sec || sec < 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function shortDate(iso?: string): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z?$/, '').slice(0, 16);
}

export function AboutMenu({ onClose }: { onClose: () => void }) {
  const client = useConnectionStore((s) => s.client);
  const [hub, setHub] = useState<{ version: string; git_commit?: string; build_date?: string; uptime_seconds: number } | null>(null);

  useEffect(() => {
    let alive = true;
    client?.getStatus().then((s) => alive && setHub(s)).catch(() => {});
    return () => { alive = false; };
  }, [client]);

  const year = new Date().getFullYear();

  return (
    <Modal open onClose={onClose} labelledBy="about-title" width={340} placement="center">
      <button style={st.close} onClick={onClose} title="Close" aria-label="Close">✕</button>

        {/* Brand header */}
        <div style={st.header}>
          <SigilLogoBig size={58} animate />
          <div id="about-title" style={st.wordmark}>SIGIL</div>
          <div style={st.tagline}>Terminal session hub</div>
        </div>

        {/* Version blocks */}
        <div style={st.body}>
          <VersionBlock
            label="Web client"
            version={__SIGIL_VERSION__}
            commit={__SIGIL_COMMIT__}
            built={shortDate(__SIGIL_BUILD__)}
          />
          <VersionBlock
            label="Hub daemon"
            version={hub?.version}
            commit={hub?.git_commit}
            built={hub ? shortDate(hub.build_date) : undefined}
            uptime={hub ? fmtUptime(hub.uptime_seconds) : undefined}
            loading={!hub}
          />
        </div>

        <div style={st.footer}>
          <div style={st.links}>
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer" style={st.link}>Source</a>
            <span style={st.dot}>·</span>
            <a href={`${REPO_URL}/blob/main/docs/SETUP.md`} target="_blank" rel="noopener noreferrer" style={st.link}>Docs</a>
            <span style={st.dot}>·</span>
            <a href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer" style={st.link}>Issues</a>
          </div>
          <div style={{ marginBottom: 2 }}>
            MIT licensed · terminals by{' '}
            <a href="https://xtermjs.org" target="_blank" rel="noopener noreferrer" style={st.link}>xterm.js</a>
          </div>
          <div style={{ marginBottom: 2, opacity: 0.75 }}>
            Full third-party attribution in{' '}
            <a href={`${REPO_URL}/blob/main/NOTICE`} target="_blank" rel="noopener noreferrer" style={st.link}>NOTICE</a>
          </div>
          <div>
            © {year}{' '}
            <a
              href="https://michaelgifford.com"
              target="_blank"
              rel="noopener noreferrer"
              style={st.link}
            >
              Michael Gifford-Santos
            </a>
          </div>
        </div>
    </Modal>
  );
}

function VersionBlock({
  label, version, commit, built, uptime, loading,
}: {
  label: string;
  version?: string;
  commit?: string;
  built?: string;
  uptime?: string;
  loading?: boolean;
}) {
  return (
    <div style={st.block}>
      <div style={st.blockHead}>
        <span style={st.blockLabel}>{label}</span>
        <span style={st.blockVer}>{loading ? '…' : `v${version ?? '—'}`}</span>
      </div>
      <div style={st.metaGrid}>
        <span style={st.metaK}>commit</span><span style={st.metaV}>{loading ? '…' : (commit || '—')}</span>
        <span style={st.metaK}>built</span><span style={st.metaV}>{loading ? '…' : (built || '—')}</span>
        {uptime !== undefined && (<><span style={st.metaK}>uptime</span><span style={st.metaV}>{uptime}</span></>)}
      </div>
    </div>
  );
}

const st: Record<string, CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000, padding: 16,
  },
  card: {
    position: 'relative', width: 340, maxWidth: '92vw',
    background: 'var(--color-panel)', border: '1px solid var(--color-border)',
    borderRadius: 16, boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
    overflow: 'hidden', fontFamily: 'var(--font-ui)',
  },
  close: {
    position: 'absolute', top: 12, right: 12, zIndex: 1,
    width: 26, height: 26, borderRadius: 7,
    background: 'transparent', border: '1px solid transparent',
    color: 'var(--color-muted)', cursor: 'pointer', fontSize: 13, lineHeight: 1,
  },
  header: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
    padding: '28px 20px 18px',
    background: 'radial-gradient(120% 90% at 50% 0%, var(--color-accent-dim), transparent 70%)',
    borderBottom: '1px solid var(--color-border)',
  },
  wordmark: {
    fontSize: 22, fontWeight: 700, letterSpacing: '0.32em', paddingLeft: '0.32em',
    background: 'linear-gradient(180deg, #A5B4FC, #4F46E5)',
    WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
  },
  tagline: { fontSize: 11, color: 'var(--color-muted)', letterSpacing: '0.04em' },
  body: { display: 'flex', flexDirection: 'column', gap: 10, padding: '16px 18px' },
  block: {
    background: 'var(--color-panel-alt)', border: '1px solid var(--color-border)',
    borderRadius: 10, padding: '10px 12px',
  },
  blockHead: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
    marginBottom: 6,
  },
  blockLabel: {
    fontSize: 10, color: 'var(--color-accent)', textTransform: 'uppercase', letterSpacing: '0.09em', fontWeight: 600,
  },
  blockVer: { fontSize: 13, fontWeight: 600, color: 'var(--color-text)', fontFamily: 'var(--font-mono)' },
  metaGrid: {
    display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 2,
    fontSize: 11, fontFamily: 'var(--font-mono)',
  },
  metaK: { color: 'var(--color-muted)' },
  metaV: { color: 'var(--color-text)', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  footer: {
    padding: '11px 20px', textAlign: 'center',
    fontSize: 10, color: 'var(--color-muted)',
    borderTop: '1px solid var(--color-border)', background: 'var(--color-panel-alt)',
  },
  links: {
    display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6,
    marginBottom: 7, fontSize: 11,
  },
  link: { color: 'var(--color-accent)', textDecoration: 'none' },
  dot: { opacity: 0.4 },
};

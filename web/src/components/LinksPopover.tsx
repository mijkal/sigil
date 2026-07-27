import React, { useCallback, useEffect, useState } from 'react';
import { useConnectionStore } from '../stores/connectionStore';
import { useInputStore } from '../stores/inputStore';
import { findUrls, type FoundUrl } from '../lib/urls';
import { useTerminalStore } from '../stores/terminalStore';

// LinksPopover — on open, scans the session's raw pipe-pane log for URLs
// (exact, wrap-proof; see extractUrls) and lists them with Copy / Open / Hand
// to Claude. Rendered in the pane's flex flow above the input bar, so it never
// overlays the live terminal or the bottom input (the old bottom-overlay URL
// bar's core problem).

function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // Non-secure-context fallback (plain HTTP). Less reliable — Phase 1 HTTPS fixes this.
  return new Promise<void>((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    Object.assign(ta.style, { position: 'fixed', top: '-9999px', opacity: '0' });
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); resolve(); } catch (e) { reject(e); }
    document.body.removeChild(ta);
  });
}

// Scan the RECENT tail first. The link you want is almost always the one just
// printed, and reading a whole session log (which grows for the life of the
// session and is capped at 50MiB) to find it made the popover slow enough to be
// useless mid-login — which is exactly when you need it. Widen only if the recent
// window came up empty, so the deep scan is the exception rather than every open.
const RECENT_BYTES = 96 * 1024;
const DEEP_BYTES = 1024 * 1024;

interface Props {
  sessionId: string;
  onClose: () => void;
}

export function LinksPopover({ sessionId, onClose }: Props) {
  const client = useConnectionStore(s => s.client);
  // The pty's real wrap column, published by the terminal tile. Without it the
  // scanner has to infer the width from repeated line lengths, which a quiet
  // pane (a login URL on an otherwise clean screen) never gives it.
  const cols = useTerminalStore(s => s.sessionCols[sessionId] ?? 0);
  const insertIntoFocused = useInputStore(s => s.insertIntoFocused);
  const [urls, setUrls] = useState<FoundUrl[]>([]);
  const [scannedDeep, setScannedDeep] = useState(false);
  const [loading, setLoading] = useState(true);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [framed, setFramed] = useState<string | null>(null);

  const scan = useCallback(async (deep = false) => {
    if (!client) return;
    setLoading(true);
    setScannedDeep(deep);
    try {
      // Negative offset = "the last N bytes" (the ranged pipe read).
      const { text } = await client.getPipedScrollbackFrom(
        sessionId, -(deep ? DEEP_BYTES : RECENT_BYTES));
      setUrls(findUrls(text, 100, cols));
    } catch {
      setUrls([]);
    } finally {
      setLoading(false);
    }
  }, [client, sessionId, cols]);

  useEffect(() => { scan(false); }, [scan]);

  const onCopy = (url: string, idx: number) => {
    copyText(url).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(c => (c === idx ? null : c)), 1400);
    }).catch(() => { /* best effort */ });
  };

  return (
    <>
    {framed && <LinkFrameModal url={framed} onClose={() => setFramed(null)} />}
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>LINKS</span>
        <span style={styles.count}>{loading ? '…' : urls.length}</span>
        <div style={{ flex: 1 }} />
        <button style={styles.iconBtn} title="Rescan" onMouseDown={e => { e.preventDefault(); scan(); }}>↺</button>
        <button style={styles.iconBtn} title="Close" onMouseDown={e => { e.preventDefault(); onClose(); }}>✕</button>
      </div>
      <div style={styles.body}>
        {loading && <div style={styles.empty}>Scanning session…</div>}
        {!loading && urls.length === 0 && (
          <div style={styles.empty}>
            {scannedDeep ? 'No links found in this session' : 'No links in recent output'}
            {!scannedDeep && (
              <button
                style={{ ...styles.iconBtn, marginLeft: 8, fontSize: 11, width: 'auto', padding: '0 6px' }}
                title="Scan further back through the session log"
                onMouseDown={e => { e.preventDefault(); scan(true); }}
              >scan further back</button>
            )}
          </div>
        )}
        {!loading && urls.map(({ url, source, elided }, idx) => (
          <div key={`${idx}-${url}`} style={styles.row}>
            <span
              style={{ ...styles.url, opacity: elided ? 0.55 : 1 }}
              title={elided
                ? `${url}\n\n(the program truncated this for display — the full link was never printed)`
                : source === 'osc8'
                  ? `${url}\n\n(exact: carried out-of-band as a terminal hyperlink)`
                  : url}
            >{url}</span>
            <div style={styles.actions}>
              <button
                style={{ ...styles.actBtn, color: copiedIdx === idx ? 'var(--color-success)' : 'var(--color-accent)' }}
                title="Copy URL"
                onMouseDown={e => { e.preventDefault(); onCopy(url, idx); }}
              >{copiedIdx === idx ? '✓' : '⎘'}</button>
              <button
                style={{ ...styles.actBtn, color: 'var(--color-accent)', display: 'inline-flex', alignItems: 'center' }}
                title="Open in a frame (keep context)"
                onMouseDown={e => { e.preventDefault(); setFramed(url); }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
                  <path d="M3 8h18" stroke="currentColor" strokeWidth="2" />
                </svg>
              </button>
              <button
                style={{ ...styles.actBtn, color: 'var(--color-accent)' }}
                title="Open in new tab"
                onMouseDown={e => { e.preventDefault(); window.open(url, '_blank', 'noopener'); }}
              >↗</button>
              <button
                style={{ ...styles.actBtn, color: 'var(--color-accent)' }}
                title="Hand to terminal (insert into input)"
                onMouseDown={e => { e.preventDefault(); insertIntoFocused(url); onClose(); }}
              >→</button>
            </div>
          </div>
        ))}
      </div>
    </div>
    </>
  );
}

// LinkFrameModal — open a link inside sigil (keep context). Direct iframe by
// default (the real site's origin, so it behaves normally); a "proxy" toggle routes
// through sigild's framable proxy for sites that block embedding. The proxied frame
// runs in an opaque origin (no allow-same-origin).
function LinkFrameModal({ url, onClose }: { url: string; onClose: () => void }) {
  const client = useConnectionStore(s => s.client);
  const [proxied, setProxied] = useState(false);
  const src = proxied && client ? client.proxyUrl(url) : url;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div style={modal.backdrop} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal.card}>
        <div style={modal.head}>
          <span style={modal.url} title={url}>{url}</span>
          <div style={{ flex: 1 }} />
          <button
            style={{ ...modal.hbtn, color: proxied ? 'var(--color-accent)' : 'var(--color-muted)', border: `1px solid ${proxied ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 5, padding: '2px 8px', fontSize: 11 }}
            title="Route through the proxy — frames sites that block embedding"
            onMouseDown={e => { e.preventDefault(); setProxied(p => !p); }}
          >proxy</button>
          <button style={modal.hbtn} title="Open in new tab" onMouseDown={e => { e.preventDefault(); window.open(url, '_blank', 'noopener'); }}>↗</button>
          <button style={modal.hbtn} title="Close (Esc)" onMouseDown={e => { e.preventDefault(); onClose(); }}>✕</button>
        </div>
        <iframe
          key={src}
          src={src}
          title={url}
          style={modal.frame}
          sandbox={proxied ? 'allow-scripts allow-forms allow-popups' : 'allow-scripts allow-same-origin allow-forms allow-popups'}
        />
      </div>
    </div>
  );
}

const modal: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '3vh 3vw',
    animation: 'sigil-fade-in 0.15s ease',
  },
  card: {
    width: 'min(1100px, 96vw)', height: 'min(90vh, 900px)', display: 'flex', flexDirection: 'column',
    background: 'var(--color-panel)', border: '1px solid var(--color-border)', borderRadius: 10,
    overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.55)',
  },
  head: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', flexShrink: 0,
    borderBottom: '1px solid var(--color-border)', background: 'var(--color-panel-alt, var(--color-panel))',
  },
  url: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' },
  hbtn: { background: 'none', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', fontSize: 13, padding: '2px 6px', lineHeight: 1 },
  frame: { flex: 1, width: '100%', border: 'none', background: '#fff' },
};

const styles: Record<string, React.CSSProperties> = {
  panel: {
    flexShrink: 0,
    maxHeight: '40vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--color-panel)',
    borderTop: '1px solid var(--color-border)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px',
    borderBottom: '1px solid var(--color-border)', flexShrink: 0,
  },
  title: { color: 'var(--color-accent)', fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em' },
  count: { color: 'var(--color-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' },
  iconBtn: { background: 'none', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', fontSize: 13, padding: '2px 5px', lineHeight: 1 },
  body: { overflowY: 'auto', overflowX: 'hidden' },
  empty: { padding: '14px 12px', color: 'var(--color-muted)', fontSize: 12, fontFamily: 'var(--font-mono)', textAlign: 'center' },
  row: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
    borderBottom: '1px solid var(--color-border)',
  },
  url: {
    flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 12,
    color: 'var(--color-text)', wordBreak: 'break-all', lineHeight: 1.35,
  },
  actions: { display: 'flex', gap: 2, flexShrink: 0 },
  actBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '3px 6px', lineHeight: 1, borderRadius: 4 },
};

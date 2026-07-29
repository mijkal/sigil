import { useEffect, useState } from 'react';
import { useToastStore } from '../stores/toastStore';
import type { Toast } from '../stores/toastStore';

const TYPE_COLOR: Record<string, string> = {
  info:    'var(--color-accent)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  error:   'var(--color-danger)',
};

// Beyond this many on-screen at once, collapse into a "view all" pill so a burst
// of notifications can't bury the UI. The full list stays available in the panel.
const MAX_VISIBLE = 3;

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToastStore(s => s.dismiss);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 16);
    return () => clearTimeout(t);
  }, []);

  const color = TYPE_COLOR[toast.type] ?? TYPE_COLOR.info;

  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-start', gap: '10px',
        padding: '12px 14px',
        // Frosted panel: opaque enough for crisp text, translucent enough that the
        // backdrop blur reads as frosted glass over terminal content.
        background: `linear-gradient(color-mix(in srgb, ${color} 12%, transparent), color-mix(in srgb, ${color} 12%, transparent)), color-mix(in srgb, var(--color-panel) 88%, transparent)`,
        backdropFilter: 'blur(18px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.6)',
        border: `1px solid ${color}`, borderLeft: `4px solid ${color}`,
        borderRadius: '8px', boxShadow: '0 10px 34px rgba(0,0,0,0.6)',
        maxWidth: '360px', minWidth: '260px',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateX(0)' : 'translateX(20px)',
        transition: 'opacity 0.2s, transform 0.2s',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color, marginBottom: toast.message ? '3px' : 0, lineHeight: 1.3, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{toast.title}</span>
          {/* Repeat count for coalesced bursts — see toastStore MAX_VISIBLE/keyOf. */}
          {(toast.count ?? 1) > 1 && (
            <span
              title={`${toast.count} identical events`}
              style={{
                flexShrink: 0, fontSize: '11px', fontWeight: 700, lineHeight: 1,
                padding: '2px 6px', borderRadius: '999px',
                background: `color-mix(in srgb, ${color} 26%, transparent)`,
                border: `1px solid ${color}`, color,
              }}
            >×{toast.count}</span>
          )}
        </div>
        {toast.message && (
          <div style={{ fontSize: '12px', color: 'var(--color-text)', lineHeight: 1.4, wordBreak: 'break-word' }}>
            {toast.message}
          </div>
        )}
      </div>
      <button
        onClick={() => dismiss(toast.id)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-muted)', fontSize: '14px', lineHeight: 1, padding: '0 2px', flexShrink: 0, marginTop: '1px' }}
      >×</button>
    </div>
  );
}

// Relative "time ago" for a history entry — compact (12s, 4m, 2h, 3d).
function timeAgo(ts?: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Compact one-line row for the coalesced panel.
function HistoryRow({ toast }: { toast: Toast }) {
  const color = TYPE_COLOR[toast.type] ?? TYPE_COLOR.info;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '8px 4px', borderBottom: '1px solid var(--color-border)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0, marginTop: 6 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text)', lineHeight: 1.3, wordBreak: 'break-word' }}>{toast.title}</div>
        {toast.message && (
          <div style={{ fontSize: '11px', color: 'var(--color-muted)', lineHeight: 1.35, wordBreak: 'break-word' }}>{toast.message}</div>
        )}
      </div>
      <span style={{ fontSize: '10px', color: 'var(--color-muted)', flexShrink: 0, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}
        title={toast.ts ? new Date(toast.ts).toLocaleString() : undefined}>{timeAgo(toast.ts)}</span>
    </div>
  );
}

function NotificationPanel() {
  const history = useToastStore(s => s.history);
  const closePanel = useToastStore(s => s.closePanel);
  const clearHistory = useToastStore(s => s.clearHistory);
  // Newest first.
  const rows = [...history].reverse();

  return (
    <div style={{
      pointerEvents: 'auto',
      width: 340, maxWidth: '92vw',
      maxHeight: '60vh', display: 'flex', flexDirection: 'column',
      background: 'color-mix(in srgb, var(--color-panel) 90%, transparent)',
      backdropFilter: 'blur(18px) saturate(1.6)', WebkitBackdropFilter: 'blur(18px) saturate(1.6)',
      border: '1px solid var(--color-border)',
      borderRadius: 10, boxShadow: '0 10px 34px rgba(0,0,0,0.6)', overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>Notifications</span>
        <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>{history.length}</span>
        <span style={{ flex: 1 }} />
        <button onClick={clearHistory} style={panelBtn}>Clear</button>
        <button onClick={closePanel} style={panelBtn} aria-label="Close">×</button>
      </div>
      <div style={{ overflowY: 'auto', padding: '2px 12px 8px' }}>
        {rows.length === 0
          ? <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: '12px 0' }}>No notifications</div>
          : rows.map(t => <HistoryRow key={t.id} toast={t} />)}
      </div>
    </div>
  );
}

const panelBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  color: 'var(--color-muted)', fontSize: 12, padding: '2px 6px', borderRadius: 4,
};

export function ToastContainer() {
  const toasts = useToastStore(s => s.toasts);
  const panelOpen = useToastStore(s => s.panelOpen);
  const openPanel = useToastStore(s => s.openPanel);

  const wrap: React.CSSProperties = {
    position: 'fixed', bottom: '20px', right: '20px', zIndex: 9999,
    display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end',
    pointerEvents: 'none',
  };

  if (panelOpen) {
    return <div style={wrap}><NotificationPanel /></div>;
  }

  if (toasts.length === 0) return null;

  // Coalesce: show only the newest MAX_VISIBLE, with a pill for the remainder.
  const shown = toasts.slice(-MAX_VISIBLE);
  const overflow = toasts.length - shown.length;

  return (
    <div style={wrap}>
      {overflow > 0 && (
        <button
          onClick={openPanel}
          style={{
            pointerEvents: 'auto', cursor: 'pointer',
            background: 'color-mix(in srgb, var(--color-panel) 88%, transparent)',
            backdropFilter: 'blur(18px) saturate(1.6)', WebkitBackdropFilter: 'blur(18px) saturate(1.6)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)', borderRadius: 999, padding: '5px 12px',
            fontSize: 12, fontWeight: 600, boxShadow: '0 8px 24px rgba(0,0,0,0.55)',
          }}
        >
          +{overflow} more · view all
        </button>
      )}
      {shown.map(t => (
        <div key={t.id} style={{ pointerEvents: 'auto' }}>
          <ToastItem toast={t} />
        </div>
      ))}
    </div>
  );
}

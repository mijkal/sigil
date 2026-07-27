import { useWidgetStore, type WidgetConfig, type WidgetKind } from '../../stores/widgetStore';
import { UsageWidget } from './UsageWidget';
import { CommandWidget } from './CommandWidget';

// ── Monochrome inline icons (sigil chrome uses SVG, never emoji) ────────────────
function IconGauge() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 15a8 8 0 0 1 16 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 15l4-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="15" r="1.4" fill="currentColor" />
    </svg>
  );
}
function IconCommand() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M7 9l3 2.5L7 14M12 14h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconChevron({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden
      style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconGear() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function IconX() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const KIND_ICON: Record<WidgetKind, JSX.Element> = {
  'claude-usage': <IconGauge />,
  'codex-usage': <IconGauge />,
  'command': <IconCommand />,
};

function WidgetCard({ cfg }: { cfg: WidgetConfig }) {
  const remove = useWidgetStore(s => s.remove);
  return (
    <div style={{
      border: '1px solid var(--color-border)', borderRadius: 6,
      background: 'color-mix(in srgb, var(--color-panel) 55%, transparent)',
      padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ color: 'var(--color-accent)', display: 'inline-flex' }}>{KIND_ICON[cfg.kind]}</span>
        <span style={{ flex: 1, fontSize: 11.5, fontWeight: 600, color: 'var(--color-text)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {cfg.name}
        </span>
        <button
          onClick={() => remove(cfg.id)}
          title="Remove widget"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-muted-dim)', display: 'flex', padding: 2, borderRadius: 3 }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-danger)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-muted-dim)'; }}
        >
          <IconX />
        </button>
      </div>
      {cfg.kind === 'command'
        ? <CommandWidget cfg={cfg} />
        : <UsageWidget cfg={cfg} />}
    </div>
  );
}

// The sidebar Widgets dock — a collapsible section pinned above the footer.
export function WidgetDock({ onManage }: { onManage?: () => void }) {
  const widgets = useWidgetStore(s => s.widgets);
  const collapsed = useWidgetStore(s => s.collapsed);
  const toggleCollapsed = useWidgetStore(s => s.toggleCollapsed);

  return (
    <div style={{ borderTop: '1px solid var(--color-border)', flexShrink: 0, display: 'flex', flexDirection: 'column', maxHeight: '46%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 5px', userSelect: 'none' }}>
        <button
          onClick={toggleCollapsed}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-muted)', display: 'inline-flex', padding: 0 }}
          title={collapsed ? 'Expand widgets' : 'Collapse widgets'}
          aria-label={collapsed ? 'Expand widgets' : 'Collapse widgets'}
        >
          <IconChevron open={!collapsed} />
        </button>
        <span style={{ flex: 1, fontSize: 10, fontWeight: 700, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: 'var(--font-mono)' }}>
          Widgets{widgets.length ? ` · ${widgets.length}` : ''}
        </span>
        {onManage && (
          <button
            onClick={onManage}
            title="Manage widgets & plugins"
            aria-label="Manage widgets"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-muted)', display: 'inline-flex', padding: 2 }}
          >
            <IconGear />
          </button>
        )}
      </div>

      {/* Body */}
      {!collapsed && (
        <div style={{ overflowY: 'auto', padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {widgets.length === 0 ? (
            <button
              onClick={onManage}
              style={{
                background: 'none', border: '1px dashed var(--color-border)', borderRadius: 6,
                color: 'var(--color-muted)', cursor: 'pointer', fontFamily: 'var(--font-mono)',
                fontSize: 11, padding: '9px 8px', textAlign: 'center',
              }}
            >
              + Add a widget
              <div style={{ fontSize: 9.5, color: 'var(--color-muted-dim)', marginTop: 2 }}>Claude usage · a command monitor</div>
            </button>
          ) : (
            widgets.map(w => <WidgetCard key={w.id} cfg={w} />)
          )}
        </div>
      )}
    </div>
  );
}

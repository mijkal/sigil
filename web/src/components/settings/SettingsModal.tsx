import { useEffect, useState } from 'react';
import { Modal } from '../../ui/Modal';
import { TriggersSection } from './TriggersSection';
import { StorageSection } from './StorageSection';
import { ConnectionSection } from './ConnectionSection';
import { TerminalSection } from './TerminalSection';
import { AppearanceSection } from './AppearanceSection';
import { WidgetsSection } from './WidgetsSection';
import { useWidgetStore } from '../../stores/widgetStore';

type Tab = 'connection' | 'terminal' | 'appearance' | 'widgets' | 'triggers' | 'storage';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'connection', label: 'Servers' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'widgets', label: 'Widgets' },
  { id: 'triggers', label: 'Triggers' },
  { id: 'storage', label: 'Storage' },
];

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('connection');

  // When the sidebar dock's "manage" control opened us, land on the Widgets tab.
  useEffect(() => {
    if (open && useWidgetStore.getState().consumeManage()) setTab('widgets');
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} width={560} labelledBy="settings-title">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 id="settings-title" style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--color-text)' }}>Settings</h2>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--color-muted)', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)' }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '6px 10px', fontSize: 13,
                color: tab === t.id ? 'var(--color-text)' : 'var(--color-muted)',
                borderBottom: `2px solid ${tab === t.id ? 'var(--color-accent)' : 'transparent'}`,
                marginBottom: -1, fontWeight: tab === t.id ? 600 : 400,
              }}
            >{t.label}</button>
          ))}
        </div>

        <div style={{ maxHeight: '64vh', overflowY: 'auto', paddingRight: 2 }}>
          {tab === 'connection' && <ConnectionSection onClose={onClose} />}
          {tab === 'terminal' && <TerminalSection />}
          {tab === 'appearance' && <AppearanceSection />}
          {tab === 'widgets' && <WidgetsSection />}
          {tab === 'triggers' && <TriggersSection />}
          {tab === 'storage' && <StorageSection />}
        </div>
      </div>
    </Modal>
  );
}

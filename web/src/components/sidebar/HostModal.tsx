import React from 'react';
import type { Host, HostInput } from '../../types';
import { modalSt } from './styles';
import { Modal } from '../../ui/Modal';
import { Button } from '../../ui/Button';

export function HostModal({ onClose, onAdd, onEdit, initialHost }: {
  onClose: () => void;
  onAdd?: (h: HostInput) => Promise<void>;
  onEdit?: (name: string, h: Omit<HostInput, 'name'>) => Promise<void>;
  initialHost?: Host;
}) {
  const isEdit = !!initialHost;
  const [form, setForm] = React.useState<HostInput>(() => initialHost ? {
    name: initialHost.name,
    hostname: initialHost.hostname,
    port: initialHost.port,
    user: initialHost.user,
    auth_method: (initialHost.auth_method as HostInput['auth_method']) ?? 'key',
    private_key_path: '',   // never returned by API; leave blank = preserve on server
    tags: [...(initialHost.tags ?? [])],
    auto_connect: initialHost.auto_connect ?? true,
  } : {
    name: '', hostname: '', port: 22, user: '',
    auth_method: 'key', private_key_path: '~/.ssh/id_ed25519',
    tags: [], auto_connect: true,
  });
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');

  const set = (k: keyof HostInput, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.hostname || !form.user || (!isEdit && !form.name)) {
      setError('Name, hostname, and user are required');
      return;
    }
    setLoading(true); setError('');
    try {
      if (isEdit && onEdit) {
        const { name: _n, ...rest } = form;
        await onEdit(initialHost!.name, rest);
      } else if (onAdd) {
        await onAdd(form);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open onClose={onClose} labelledBy="hostmodal-title" width={420} placement="center">
      <div style={{ padding: '18px 20px 20px' }}>
        <div style={modalSt.header}>
          <span id="hostmodal-title" style={modalSt.title}>{isEdit ? `Edit: ${initialHost!.name}` : 'Add Host'}</span>
          <button style={modalSt.closeBtn} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={submit} style={modalSt.form}>
          {!isEdit && (
            <Row>
              <Field label="Name *" style={{ flex: 1 }}>
                <Input value={form.name} onChange={v => set('name', v)} placeholder="my-server" autoFocus />
              </Field>
            </Row>
          )}
          <Row>
            <Field label="Hostname / IP *" style={{ flex: 1 }}>
              <Input value={form.hostname} onChange={v => set('hostname', v)} placeholder="192.168.1.10" autoFocus={isEdit} />
            </Field>
            <Field label="Port" style={{ width: '72px' }}>
              <Input value={String(form.port ?? 22)} onChange={v => set('port', parseInt(v) || 22)} />
            </Field>
          </Row>
          <Row>
            <Field label="User *" style={{ flex: 1 }}>
              <Input value={form.user} onChange={v => set('user', v)} placeholder="root" />
            </Field>
            <Field label="Auth" style={{ width: '110px' }}>
              <select style={modalSt.input} value={form.auth_method}
                onChange={e => set('auth_method', e.target.value as HostInput['auth_method'])}>
                <option value="key">SSH Key</option>
                <option value="agent">Agent</option>
                <option value="password">Password</option>
              </select>
            </Field>
          </Row>
          {form.auth_method === 'key' && (
            <Field label={isEdit ? 'Key Path (blank = unchanged)' : 'Key Path'}>
              <Input value={form.private_key_path ?? ''} onChange={v => set('private_key_path', v)}
                placeholder="~/.ssh/id_ed25519" />
            </Field>
          )}
          {form.auth_method === 'password' && (
            <Field label={isEdit ? 'Password (blank = unchanged)' : 'Password'}>
              <input style={modalSt.input} type="password" value={form.password ?? ''}
                onChange={e => set('password', e.target.value)} />
            </Field>
          )}
          <Field label="Tags (comma separated)">
            <Input
              value={(form.tags ?? []).join(', ')}
              onChange={v => set('tags', v.split(',').map(t => t.trim()).filter(Boolean))}
              placeholder="local, lan, prod…"
            />
          </Field>
          <label style={modalSt.checkRow}>
            <input type="checkbox" checked={form.auto_connect ?? true}
              onChange={e => set('auto_connect', e.target.checked)} />
            <span style={{ fontSize: '13px', color: 'var(--color-text)' }}>Auto-connect on startup</span>
          </label>
          {error && <div style={modalSt.error}>{error}</div>}
          <div style={modalSt.actions}>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={loading}>
              {loading ? (isEdit ? 'Saving…' : 'Connecting…') : (isEdit ? 'Save Changes' : 'Add Host')}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

function Field({ label, children, style }: {
  label: string; children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <div style={{ marginBottom: '10px', ...style }}>
      <div style={modalSt.label}>{label}</div>
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: '8px' }}>{children}</div>;
}

function Input({ value, onChange, placeholder, autoFocus }: {
  value: string; onChange: (v: string) => void;
  placeholder?: string; autoFocus?: boolean;
}) {
  return (
    <input style={modalSt.input} value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
    />
  );
}

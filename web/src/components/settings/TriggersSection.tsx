import { useCallback, useEffect, useState } from 'react';
import { useConnectionStore } from '../../stores/connectionStore';
import { useToastStore } from '../../stores/toastStore';
import { Button } from '../../ui/Button';
import type { Trigger } from '../../types';
import {
  emptyTriggerForm, triggerToForm, validateTriggerForm,
  TRIGGER_ACTIONS, type TriggerFormState,
} from '../../lib/triggerForm';

// Which config fields each action exposes in the editor.
const FIELDS: Record<string, Array<'color' | 'durationMs' | 'toneHz' | 'level' | 'title' | 'message' | 'url' | 'secret'>> = {
  toast: ['level', 'title', 'message', 'durationMs'],
  flash: ['color', 'durationMs'],
  tint: ['color', 'durationMs'],
  audio: ['toneHz', 'durationMs'],
  webhook: ['url', 'secret'],
};

export function TriggersSection() {
  const client = useConnectionStore((s) => s.client);
  const push = useToastStore((s) => s.push);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ id: string | null; form: TriggerFormState } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try { setTriggers(await client.getTriggers()); }
    catch (e) { push({ type: 'error', title: 'Load triggers failed', message: String(e) }); }
    finally { setLoading(false); }
  }, [client, push]);

  useEffect(() => { reload(); }, [reload]);

  const startNew = () => { setErrors({}); setEditing({ id: null, form: emptyTriggerForm() }); };
  const startEdit = (t: Trigger) => { setErrors({}); setEditing({ id: t.id, form: triggerToForm(t) }); };
  const cancel = () => { setEditing(null); setErrors({}); };

  const save = async () => {
    if (!client || !editing) return;
    const { errors: errs, trigger } = validateTriggerForm(editing.form);
    if (!trigger) { setErrors(errs); return; }
    setSaving(true);
    try {
      if (editing.id) await client.updateTrigger(editing.id, trigger);
      else await client.createTrigger(trigger);
      push({ type: 'success', title: editing.id ? 'Trigger updated' : 'Trigger created', durationMs: 2500 });
      setEditing(null);
      await reload();
    } catch (e) {
      push({ type: 'error', title: 'Save failed', message: String(e) });
    } finally { setSaving(false); }
  };

  const toggleEnabled = async (t: Trigger) => {
    if (!client) return;
    try {
      const { id: _id, ...rest } = t;
      void _id;
      await client.updateTrigger(t.id, { ...rest, enabled: !t.enabled });
      await reload();
    } catch (e) { push({ type: 'error', title: 'Update failed', message: String(e) }); }
  };

  const remove = async (t: Trigger) => {
    if (!client) return;
    if (!window.confirm(`Delete trigger "${t.name}"?`)) return;
    try { await client.deleteTrigger(t.id); await reload(); }
    catch (e) { push({ type: 'error', title: 'Delete failed', message: String(e) }); }
  };

  if (editing) {
    return <TriggerEditor
      form={editing.form}
      isNew={editing.id === null}
      errors={errors}
      saving={saving}
      onChange={(form) => setEditing({ ...editing, form })}
      onSave={save}
      onCancel={cancel}
    />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--color-muted)', flex: 1 }}>
          Fire an effect when a session's output matches a regex. Effects: on-screen flash,
          background tint, an audio beep, a toast, or an HMAC webhook.
        </p>
        <Button variant="primary" size="sm" onClick={startNew}>+ New trigger</Button>
      </div>

      {loading ? (
        <div style={{ color: 'var(--color-muted)', fontSize: 12, padding: '10px 0' }}>Loading…</div>
      ) : triggers.length === 0 ? (
        <div style={{ color: 'var(--color-muted)', fontSize: 12, padding: '16px 0', textAlign: 'center' }}>
          No triggers yet. Create one to react to output across your sessions.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {triggers.map((t) => (
            <div key={t.id} style={row}>
              <button
                onClick={() => toggleEnabled(t)}
                title={t.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                style={{ ...dot, background: t.enabled ? 'var(--color-success)' : 'var(--color-muted-dim)' }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>{t.name}</div>
                <div style={{ fontSize: 11, color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  /{t.pattern}/ → {t.action}
                </div>
              </div>
              <button style={linkBtn} onClick={() => startEdit(t)}>edit</button>
              <button style={{ ...linkBtn, color: 'var(--color-danger)' }} onClick={() => remove(t)}>delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TriggerEditor({ form, isNew, errors, saving, onChange, onSave, onCancel }: {
  form: TriggerFormState;
  isNew: boolean;
  errors: Record<string, string>;
  saving: boolean;
  onChange: (f: TriggerFormState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (k: keyof TriggerFormState, v: string | boolean) => onChange({ ...form, [k]: v });
  const fields = FIELDS[form.action] ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>{isNew ? 'New trigger' : 'Edit trigger'}</div>

      <Field label="Name" error={errors.name}>
        <input style={inp} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="build-failed" />
      </Field>
      <Field label="Pattern (regex, matched per output line)" error={errors.pattern}>
        <input style={{ ...inp, fontFamily: 'var(--font-mono)' }} value={form.pattern} onChange={(e) => set('pattern', e.target.value)} placeholder="ERROR|FAILED" />
      </Field>
      <Field label="Action">
        <select style={inp} value={form.action} onChange={(e) => set('action', e.target.value)}>
          {TRIGGER_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </Field>

      {fields.includes('level') && (
        <Field label="Level">
          <select style={inp} value={form.level} onChange={(e) => set('level', e.target.value)}>
            {['info', 'success', 'warning', 'error'].map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </Field>
      )}
      {fields.includes('title') && <Field label="Title"><input style={inp} value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="defaults to trigger name" /></Field>}
      {fields.includes('message') && <Field label="Message"><input style={inp} value={form.message} onChange={(e) => set('message', e.target.value)} placeholder="defaults to the matched line" /></Field>}
      {fields.includes('color') && <Field label="Colour (accent / danger / warning / success / info, or #hex)"><input style={inp} value={form.color} onChange={(e) => set('color', e.target.value)} placeholder="danger" /></Field>}
      {fields.includes('toneHz') && <Field label="Tone (Hz)" error={errors.toneHz}><input style={inp} value={form.toneHz} onChange={(e) => set('toneHz', e.target.value)} placeholder="880" /></Field>}
      {fields.includes('durationMs') && <Field label="Duration (ms)" error={errors.durationMs}><input style={inp} value={form.durationMs} onChange={(e) => set('durationMs', e.target.value)} placeholder="optional" /></Field>}
      {fields.includes('url') && <Field label="Webhook URL" error={errors.url}><input style={inp} value={form.url} onChange={(e) => set('url', e.target.value)} placeholder="https://…" /></Field>}
      {fields.includes('secret') && <Field label="Webhook HMAC secret"><input style={inp} type="password" value={form.secret} onChange={(e) => set('secret', e.target.value)} placeholder="optional" /></Field>}

      <Field label="Debounce (ms) — min gap between repeat fires" error={errors.debounceMs}>
        <input style={inp} value={form.debounceMs} onChange={(e) => set('debounceMs', e.target.value)} placeholder="default 3000" />
      </Field>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text)', cursor: 'pointer' }}>
        <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        Enabled
      </label>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>{label}</span>
      {children}
      {error && <span style={{ fontSize: 11, color: 'var(--color-danger)' }}>{error}</span>}
    </label>
  );
}

const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 10px', borderRadius: 6,
  background: 'var(--color-panel-alt)', border: '1px solid var(--color-border)',
};
const dot: React.CSSProperties = { width: 10, height: 10, borderRadius: '50%', border: 'none', cursor: 'pointer', flexShrink: 0, padding: 0 };
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-accent)', fontSize: 12, padding: '2px 4px', flexShrink: 0 };
const inp: React.CSSProperties = {
  background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 5,
  color: 'var(--color-text)', fontSize: 12, padding: '6px 8px', fontFamily: 'var(--font-ui)', width: '100%', boxSizing: 'border-box',
};

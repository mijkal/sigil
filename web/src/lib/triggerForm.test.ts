import { describe, it, expect } from 'vitest';
import { validateTriggerForm, triggerToForm, emptyTriggerForm } from './triggerForm';

const base = () => ({ ...emptyTriggerForm(), name: 'boom', pattern: 'ERROR' });

describe('validateTriggerForm', () => {
  it('requires name and pattern', () => {
    const { errors } = validateTriggerForm({ ...emptyTriggerForm(), name: '', pattern: '' });
    expect(errors.name).toBeTruthy();
    expect(errors.pattern).toBeTruthy();
  });

  it('rejects an invalid regex', () => {
    const { errors, trigger } = validateTriggerForm({ ...base(), pattern: '([' });
    expect(errors.pattern).toMatch(/Invalid regex/);
    expect(trigger).toBeUndefined();
  });

  it('builds a toast config', () => {
    const { errors, trigger } = validateTriggerForm({
      ...base(), action: 'toast', level: 'error', title: 'Down', message: 'boom', durationMs: '8000',
    });
    expect(errors).toEqual({});
    expect(trigger).toEqual({
      name: 'boom', pattern: 'ERROR', action: 'toast', enabled: true,
      config: { level: 'error', title: 'Down', message: 'boom', duration_ms: 8000 },
    });
  });

  it('builds a flash config with colour + duration', () => {
    const { trigger } = validateTriggerForm({ ...base(), action: 'flash', color: 'danger', durationMs: '400' });
    expect(trigger?.config).toEqual({ color: 'danger', duration_ms: 400 });
  });

  it('requires a webhook url', () => {
    const { errors } = validateTriggerForm({ ...base(), action: 'webhook', url: '' });
    expect(errors.url).toBeTruthy();
  });

  it('carries debounce_ms across actions', () => {
    const { trigger } = validateTriggerForm({ ...base(), action: 'audio', toneHz: '660', debounceMs: '5000' });
    expect(trigger?.config).toEqual({ tone_hz: 660, debounce_ms: 5000 });
  });

  it('flags a non-numeric duration', () => {
    const { errors } = validateTriggerForm({ ...base(), action: 'flash', durationMs: 'abc' });
    expect(errors.durationMs).toBeTruthy();
  });

  it('omits blank optional numeric fields', () => {
    const { trigger } = validateTriggerForm({ ...base(), action: 'audio' });
    expect(trigger?.config).toEqual({}); // nothing set
  });
});

describe('triggerToForm', () => {
  it('round-trips a stored trigger into form state', () => {
    const f = triggerToForm({
      id: 't1', name: 'n', pattern: 'P', action: 'flash', enabled: false,
      config: { color: '#ff0000', duration_ms: 500, debounce_ms: 2000 },
    });
    expect(f).toMatchObject({ name: 'n', pattern: 'P', action: 'flash', enabled: false, color: '#ff0000', durationMs: '500', debounceMs: '2000' });
  });
});

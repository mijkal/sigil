import { describe, it, expect } from 'vitest';
import { resolveTriggerEffect, resolveColor } from './triggerEffects';

describe('resolveColor', () => {
  it('maps named intents to theme tokens', () => {
    expect(resolveColor('danger')).toBe('var(--color-danger)');
    expect(resolveColor('SUCCESS')).toBe('var(--color-success)');
  });
  it('accepts #hex', () => {
    expect(resolveColor('#f00')).toBe('#f00');
    expect(resolveColor('#ffcc00')).toBe('#ffcc00');
  });
  it('rejects arbitrary strings and non-strings', () => {
    expect(resolveColor('red; content: hack')).toBe('var(--color-accent)');
    expect(resolveColor(42)).toBe('var(--color-accent)');
    expect(resolveColor(undefined, 'var(--color-warning)')).toBe('var(--color-warning)');
  });
});

describe('resolveTriggerEffect', () => {
  it('returns null for unknown actions', () => {
    expect(resolveTriggerEffect({ action: 'webhook', trigger: 't' })).toBeNull();
  });

  it('resolves a flash with defaults', () => {
    const e = resolveTriggerEffect({ action: 'flash', trigger: 'boom' });
    expect(e).toEqual({ kind: 'flash', color: 'var(--color-danger)', durationMs: 450, label: 'boom' });
  });

  it('clamps flash duration to the allowed range', () => {
    const e = resolveTriggerEffect({ action: 'flash', trigger: 't', config: { duration_ms: 999999 } });
    expect(e).toMatchObject({ kind: 'flash', durationMs: 4000 });
  });

  it('resolves tint colour from config', () => {
    const e = resolveTriggerEffect({ action: 'tint', trigger: 't', config: { color: 'info', duration_ms: 3000 } });
    expect(e).toEqual({ kind: 'tint', color: 'var(--color-info)', durationMs: 3000, label: 't' });
  });

  it('resolves audio tone with clamping', () => {
    const e = resolveTriggerEffect({ action: 'audio', trigger: 't', config: { tone_hz: 50 } });
    expect(e).toMatchObject({ kind: 'audio', tone: 100 }); // clamped up to min
  });

  it('maps notify to a toast', () => {
    const e = resolveTriggerEffect({ action: 'notify', trigger: 'done', match: 'Build finished OK' });
    expect(e).toMatchObject({ kind: 'toast', level: 'info', title: 'done', message: 'Build finished OK' });
  });

  it('toast uses config level/title/message and falls back to match', () => {
    const e = resolveTriggerEffect({
      action: 'toast', trigger: 't', match: 'raw line',
      config: { level: 'error', title: 'Failure' },
    });
    expect(e).toMatchObject({ kind: 'toast', level: 'error', title: 'Failure', message: 'raw line' });
  });

  it('toast ignores an invalid level', () => {
    const e = resolveTriggerEffect({ action: 'toast', trigger: 't', config: { level: 'bogus' } });
    expect(e).toMatchObject({ kind: 'toast', level: 'info' });
  });
});

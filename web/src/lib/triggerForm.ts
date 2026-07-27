// Pure form logic for the trigger editor: validation + mapping between the flat
// form state (all strings, as the inputs hold them) and the Trigger wire model.
// Kept DOM-free for unit testing.
import type { Trigger } from '../types';

export const TRIGGER_ACTIONS = ['toast', 'flash', 'tint', 'audio', 'webhook'] as const;
export type TriggerAction = (typeof TRIGGER_ACTIONS)[number];

export interface TriggerFormState {
  name: string;
  pattern: string;
  action: string;
  enabled: boolean;
  // config fields (kept as strings; blank = unset)
  color: string;
  durationMs: string;
  toneHz: string;
  level: string;
  title: string;
  message: string;
  url: string;
  secret: string;
  debounceMs: string;
}

export function emptyTriggerForm(): TriggerFormState {
  return {
    name: '', pattern: '', action: 'toast', enabled: true,
    color: '', durationMs: '', toneHz: '', level: 'info',
    title: '', message: '', url: '', secret: '', debounceMs: '',
  };
}

// triggerToForm hydrates the editor from an existing trigger.
export function triggerToForm(t: Trigger): TriggerFormState {
  const c = t.config ?? {};
  const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  return {
    name: t.name, pattern: t.pattern, action: t.action, enabled: t.enabled,
    color: s(c.color), durationMs: s(c.duration_ms), toneHz: s(c.tone_hz),
    level: s(c.level) || 'info', title: s(c.title), message: s(c.message),
    url: s(c.url), secret: s(c.secret), debounceMs: s(c.debounce_ms),
  };
}

export interface ValidatedTrigger {
  name: string;
  pattern: string;
  action: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

function numOrUndef(v: string): number | undefined {
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN; // NaN signals a bad value to the caller
}

// validateTriggerForm returns field errors and, when clean, the wire model.
export function validateTriggerForm(f: TriggerFormState): {
  errors: Record<string, string>;
  trigger?: ValidatedTrigger;
} {
  const errors: Record<string, string> = {};

  if (!f.name.trim()) errors.name = 'Name is required';
  if (!f.pattern.trim()) {
    errors.pattern = 'Pattern is required';
  } else {
    try { new RegExp(f.pattern); } catch (e) { errors.pattern = `Invalid regex: ${(e as Error).message}`; }
  }
  if (!TRIGGER_ACTIONS.includes(f.action as TriggerAction)) {
    errors.action = 'Unknown action';
  }

  const config: Record<string, unknown> = {};
  const putNum = (key: string, raw: string, field: string) => {
    const n = numOrUndef(raw);
    if (Number.isNaN(n)) { errors[field] = 'Must be a number'; return; }
    if (n !== undefined) config[key] = n;
  };

  putNum('debounce_ms', f.debounceMs, 'debounceMs');

  switch (f.action) {
    case 'toast':
      if (f.level) config.level = f.level;
      if (f.title.trim()) config.title = f.title.trim();
      if (f.message.trim()) config.message = f.message.trim();
      putNum('duration_ms', f.durationMs, 'durationMs');
      break;
    case 'flash':
    case 'tint':
      if (f.color.trim()) config.color = f.color.trim();
      putNum('duration_ms', f.durationMs, 'durationMs');
      break;
    case 'audio':
      putNum('tone_hz', f.toneHz, 'toneHz');
      putNum('duration_ms', f.durationMs, 'durationMs');
      break;
    case 'webhook':
      if (!f.url.trim()) errors.url = 'Webhook URL is required';
      else config.url = f.url.trim();
      if (f.secret.trim()) config.secret = f.secret.trim();
      break;
  }

  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    trigger: { name: f.name.trim(), pattern: f.pattern, action: f.action, enabled: f.enabled, config },
  };
}

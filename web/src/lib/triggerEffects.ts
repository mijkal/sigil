// Pure logic for turning a `trigger.action` WS message into a concrete UI
// effect. Kept free of React/DOM so it can be unit-tested; the store and the
// effects layer consume TriggerEffect.

export interface TriggerActionMessage {
  action: string;
  trigger: string;
  sessionId?: string;
  match?: string;
  config?: Record<string, unknown>;
}

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export type TriggerEffect =
  | { kind: 'flash'; color: string; durationMs: number; label: string }
  | { kind: 'tint'; color: string; durationMs: number; label: string }
  | { kind: 'audio'; tone: number; durationMs: number; label: string }
  | { kind: 'toast'; level: ToastLevel; title: string; message?: string; durationMs: number };

// Named colour intents map to theme tokens so effects stay themeable. Anything
// else must be an explicit #hex to be accepted (guards against arbitrary strings
// landing in an inline style); unknown values fall back to the accent token.
const COLOR_TOKENS: Record<string, string> = {
  accent: 'var(--color-accent)',
  danger: 'var(--color-danger)',
  error: 'var(--color-danger)',
  warning: 'var(--color-warning)',
  success: 'var(--color-success)',
  info: 'var(--color-info)',
};

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function resolveColor(raw: unknown, fallback = 'var(--color-accent)'): string {
  if (typeof raw !== 'string') return fallback;
  const key = raw.trim().toLowerCase();
  if (COLOR_TOKENS[key]) return COLOR_TOKENS[key];
  if (HEX_RE.test(raw.trim())) return raw.trim();
  return fallback;
}

function num(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function str(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

const TOAST_LEVELS: ToastLevel[] = ['info', 'success', 'warning', 'error'];

// resolveTriggerEffect maps a message to an effect, or null if the action is
// unknown. Config values are validated/clamped here so the UI can trust them.
export function resolveTriggerEffect(a: TriggerActionMessage): TriggerEffect | null {
  const cfg = a.config ?? {};
  const label = a.trigger || 'trigger';
  switch (a.action) {
    case 'flash':
      return { kind: 'flash', color: resolveColor(cfg.color, 'var(--color-danger)'), durationMs: num(cfg.duration_ms, 450, 80, 4000), label };
    case 'tint':
      return { kind: 'tint', color: resolveColor(cfg.color, 'var(--color-warning)'), durationMs: num(cfg.duration_ms, 6000, 200, 120000), label };
    case 'audio':
      return { kind: 'audio', tone: num(cfg.tone_hz, 880, 100, 8000), durationMs: num(cfg.duration_ms, 200, 40, 2000), label };
    case 'toast':
    case 'notify': {
      const lvl = str(cfg.level)?.toLowerCase();
      const level: ToastLevel = TOAST_LEVELS.includes(lvl as ToastLevel) ? (lvl as ToastLevel) : 'info';
      return {
        kind: 'toast',
        level,
        title: str(cfg.title) ?? label,
        message: str(cfg.message) ?? (a.match ? a.match.slice(0, 120) : undefined),
        durationMs: num(cfg.duration_ms, 5000, 1000, 30000),
      };
    }
    default:
      return null;
  }
}

import { describe, expect, it } from 'vitest';
import { shortModel } from '../../stores/widgetStore';

// The sidebar is narrow. A label the widget cannot fit gets ellipsized, and an
// ellipsized model name tells you nothing — "sonnet-5" and "sonnet-4-5" clip to
// the same thing. Names must be short enough to fit before the CSS gets a say.
describe('shortModel', () => {
  it('strips the vendor prefix for every provider', () => {
    expect(shortModel('claude-opus-5')).toBe('opus-5');
    expect(shortModel('claude-sonnet-5')).toBe('sonnet-5');
    expect(shortModel('gpt-5-codex')).toBe('5-codex');
    expect(shortModel('gemini-3-pro')).toBe('3-pro');
  });

  it('drops a trailing build date', () => {
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5');
  });

  it('leaves an already-short name alone', () => {
    expect(shortModel('opus')).toBe('opus');
  });

  it('keeps every name inside a sidebar-sized column', () => {
    for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001',
                     'gpt-5-codex', 'gemini-3-pro']) {
      expect(shortModel(m).length).toBeLessThanOrEqual(12);
    }
  });
});

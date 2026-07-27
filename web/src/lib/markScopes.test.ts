import { describe, it, expect } from 'vitest';
import { rekeyScope } from './markScopes';

const OLD = 's:host-a::old';
const NEW = 's:host-a::new';

describe('rekeyScope', () => {
  it('moves the entry to the new scope and drops the old one', () => {
    const out = rekeyScope({ [OLD]: 'star', 'h:host-a': 'moon' }, OLD, NEW);
    expect(out).toEqual({ [NEW]: 'star', 'h:host-a': 'moon' });
  });

  it('carries object values by reference (adjust maps)', () => {
    const adj = { sat: 1.4, opacity: 0.8, mono: false };
    expect(rekeyScope({ [OLD]: adj }, OLD, NEW)[NEW]).toBe(adj);
  });

  it('returns the same map when there is nothing to move', () => {
    const map = { 'h:host-a': 1 as const };
    expect(rekeyScope(map, OLD, NEW)).toBe(map);
    expect(rekeyScope(map, 'h:host-a', 'h:host-a')).toBe(map);
  });

  it('does not mutate the input', () => {
    const map = { [OLD]: 'star' };
    rekeyScope(map, OLD, NEW);
    expect(map).toEqual({ [OLD]: 'star' });
  });

  it('overwrites an existing entry at the new scope', () => {
    expect(rekeyScope({ [OLD]: 'star', [NEW]: 'moon' }, OLD, NEW)).toEqual({ [NEW]: 'star' });
  });
});

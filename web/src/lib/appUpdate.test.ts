import { describe, expect, it, vi } from 'vitest';
import { performUpdate, type UpdateEnv } from './appUpdate';

// Installed to a home screen, this is the ONLY way onto a new build from inside
// the app — no address bar, no reload button, and iOS disables its own
// pull-to-refresh in standalone. So it has to survive every environment that can
// refuse it, or it fails silently in exactly the state it exists for.

function env(over: Partial<UpdateEnv> = {}): UpdateEnv & { reloaded: string[] } {
  const reloaded: string[] = [];
  return {
    href: 'https://sigil.test/',
    reload: (u) => reloaded.push(u),
    now: () => 1_700_000_000_000,
    reloaded,
    ...over,
  };
}

describe('performUpdate', () => {
  it('sweeps workers before caches, then reloads', async () => {
    const order: string[] = [];
    const e = env({
      getRegistrations: async () => [
        { unregister: async () => { order.push('unregister'); return true; } },
      ],
      cacheKeys: async () => ['old'],
      cacheDelete: async () => { order.push('cache-delete'); return true; },
    });
    e.reload = (u) => { order.push('reload'); e.reloaded.push(u); };

    await performUpdate(e);

    // A worker still controlling the page can re-populate a cache mid-sweep, so
    // it must go first or the reload boots the bundle we just discarded.
    expect(order).toEqual(['unregister', 'cache-delete', 'reload']);
  });

  it('reloads even when the sweep is refused', async () => {
    const e = env({
      getRegistrations: async () => { throw new Error('denied'); },
      cacheKeys: async () => { throw new Error('no storage'); },
      cacheDelete: vi.fn(),
    });

    await performUpdate(e);

    // sigil-web serves index.html no-cache, so a plain reload already lands on a
    // fresh shell; the sweep is an optimisation, never the guarantee.
    expect(e.reloaded).toHaveLength(1);
  });

  it('works on an origin that never had a service worker', async () => {
    // Sigil ships none — this is the NORMAL path, not the edge case.
    const e = env();

    await performUpdate(e);

    expect(e.reloaded).toHaveLength(1);
    expect(e.reloaded[0]).toMatch(/[?&]_u=/);
  });

  it('preserves the current path and existing query', async () => {
    const e = env({ href: 'https://sigil.test/?host=alpha#pane2' });

    await performUpdate(e);

    // Force-updating from a deep link should land you back where you were, not
    // at the root — the point is a new bundle, not a new destination.
    expect(e.reloaded[0]).toContain('host=alpha');
    expect(e.reloaded[0]).toContain('#pane2');
  });
});

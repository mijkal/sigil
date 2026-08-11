// Refreshing an installed app that has no browser chrome.
//
// Added to a home screen, Sigil has no address bar and no reload button, and iOS
// disables its own pull-to-refresh in standalone — so a stale shell had no remedy
// short of deleting and re-adding the app.
//
// Sigil ships NO service worker, so this is simpler than it would otherwise be:
// there is normally no worker to unregister and no cache to clear. Both are swept
// anyway, because a worker may have been registered by an earlier build or by
// another app on the same origin, and a stale CacheStorage entry outlives
// whatever created it.

/** True when running as an installed app rather than a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS predates display-mode and reports this instead.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** The browser bits performUpdate touches, named so it can be driven in tests.
 *  Sigil's vitest runs in a node environment with no DOM, and this utility did
 *  not justify adding jsdom to a public repo just to stub four globals. */
export interface UpdateEnv {
  getRegistrations?: () => Promise<Array<{ unregister: () => Promise<boolean> }>>;
  cacheKeys?: () => Promise<string[]>;
  cacheDelete?: (key: string) => Promise<boolean>;
  href: string;
  reload: (url: string) => void;
  now: () => number;
}

/**
 * Discard any cached copy of the app and relaunch on the current build.
 *
 * The reload is unconditional. If the sweep throws — private mode, storage
 * disabled, a worker that refuses to unregister — a plain reload still lands on
 * a fresh shell, because cmd/sigil-web serves index.html and every unhashed asset
 * with `no-cache`. A control that no-ops in exactly the broken state it exists
 * for would be worse than no control at all.
 */
export async function performUpdate(env: UpdateEnv): Promise<void> {
  try {
    // Unregister BEFORE clearing caches: a worker still controlling the page can
    // re-populate one mid-sweep, and the reload would then boot the very bundle
    // being discarded.
    const regs = (await env.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
  } catch {
    /* best-effort — the reload below is the real guarantee */
  }
  try {
    const keys = (await env.cacheKeys?.()) ?? [];
    await Promise.all(keys.map((k) => env.cacheDelete?.(k).catch(() => false)));
  } catch {
    /* same */
  }
  const url = new URL(env.href);
  url.searchParams.set('_u', env.now().toString(36));
  env.reload(url.toString());
}

/** Bind performUpdate to the real browser. Kept trivial so it is correct by
 *  inspection; all the behaviour worth testing lives in performUpdate. */
export function forceUpdate(): Promise<void> {
  return performUpdate({
    getRegistrations:
      'serviceWorker' in navigator
        ? () => navigator.serviceWorker.getRegistrations() as unknown as Promise<
            Array<{ unregister: () => Promise<boolean> }>
          >
        : undefined,
    cacheKeys: 'caches' in window ? () => caches.keys() : undefined,
    cacheDelete: 'caches' in window ? (k: string) => caches.delete(k) : undefined,
    href: window.location.href,
    reload: (url) => window.location.replace(url),
    now: () => Date.now(),
  });
}

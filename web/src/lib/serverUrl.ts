// Resolve which sigil server the web client should talk to.
//
// The client persists `sigil_server_url` so a statically-hosted UI can point at
// a daemon elsewhere (the LAN/dev case). But when the page itself is served over
// HTTPS (e.g. behind a reverse proxy at a public domain), a stored *http://*
// target is mixed content and the browser silently blocks every fetch/WebSocket
// — so no sessions load. In that case the stored value is unusable; fall back to
// the page's own origin, which the proxy serves API + WS from.

export function pickServerUrl(
  stored: string | null,
  pageProtocol: string, // e.g. 'https:'
  pageHost: string,     // e.g. 'sigil.example.com'
): string {
  const sameOrigin = `${pageProtocol}//${pageHost}`;
  if (!stored) return sameOrigin;
  // Mixed-content guard: HTTPS page + http:// target → unusable, use same-origin.
  if (pageProtocol === 'https:' && /^http:\/\//i.test(stored.trim())) {
    return sameOrigin;
  }
  return stored;
}

// resolveServerUrl reads the browser environment and applies pickServerUrl.
export function resolveServerUrl(): string {
  return pickServerUrl(
    localStorage.getItem('sigil_server_url'),
    window.location.protocol,
    window.location.host,
  );
}

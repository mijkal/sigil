# Security Policy

## Trust model — read this before you deploy

Sigil is a **hub that holds SSH access to every host you configure** and exposes
those sessions over a web UI. Treat the `sigild` process, its host, and its
config file as highly sensitive:

- **The config holds credentials.** `hub.auth.tokens` gate the entire API and
  WebSocket; `[[hosts]]` reference SSH keys/paths. Keep `config.toml` `chmod 600`
  and never commit it. The repo's `.gitignore` excludes it; `config.example.toml`
  is the safe template.
- **A bearer token is the only thing between the network and your shells.** Anyone
  with the token can open any session. Use a long, random token. Rotate it if it
  leaks (edit `hub.auth.tokens` and restart).
- **Do not expose sigild directly to the public internet.** Run it on a trusted
  network — LAN, VPN, or a WireGuard/Tailscale tailnet — or behind a
  TLS-terminating reverse proxy that you control. The default bind is
  `0.0.0.0:7777`; narrow it (`127.0.0.1:7777` + proxy) if you can.

## Hardening checklist

- **TLS:** terminate HTTPS at a reverse proxy (Caddy/nginx/Traefik) or enable
  `[hub.tls]`. The web client refuses mixed content, so serve it over HTTPS end
  to end.
- **Origin allowlist:** set `hub.allowed_origins` to the exact hostnames that may
  open a WebSocket. Empty is permissive (token still required) — fine on a private
  network, tighten it when proxied to a public name.
- **SSH host keys:** `host_key_mode = "tofu"` (default) pins each host's key on
  first connect; `"strict"` requires a pre-populated `known_hosts`. Avoid
  `"insecure"` except for throwaway/local setups.
- **Least privilege:** give sigild an SSH identity that can only reach what it
  needs. It runs `tmux` and a few read-only probes on each host.
- **File/transfer scope:** the file browser and upload/download operate as the
  configured SSH user. Anyone with the token has that user's file access.

## Defense-in-depth already in place

Constant-time token comparison, WebSocket read limits and origin controls, upload
size caps, `path.Base` on served filenames, no-eval path handling in the
file/transfer routes, gitignored secrets, and HMAC-signed webhooks.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

- Open a [GitHub Security Advisory](../../security/advisories/new) on the repo, or
- email the maintainer (see the commit history / repo profile).

Include a description, affected version/commit, and reproduction steps. You can
expect an acknowledgement within a few days. As a small self-hosted project there
is no formal bounty, but credit is gladly given.

## Supported versions

Sigil is pre-1.0; only the latest `main` receives security fixes.

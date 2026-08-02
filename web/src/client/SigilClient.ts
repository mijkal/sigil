import type { Host, HostInput, HostMetrics, Session, ScrollbackChunk, SearchResult, WsMessage, DirListing, FileContent, Trigger, Settings, MaintenanceResult, AgentUsage, ExecResult } from '../types';

type MessageHandler = (payload: unknown, channelId?: string) => void;

interface APIResponse<T> {
  data: T;
  error?: string;
}

export class SigilClient {
  private ws: WebSocket | null = null;
  private token: string;
  private baseUrl: string;
  private wsUrl: string;
  private handlers: Map<string, Array<MessageHandler>> = new Map();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private destroyed = false;
  // Binary hot-path: channel.output/channel.input as raw binary WS frames (no
  // base64, no JSON envelope). DEFAULT ON; explicit localStorage sigil_binary_ws=0
  // opts back to JSON. Control messages stay JSON either way.
  private binary = true;

  constructor(baseUrl: string, token: string) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    // Convert http(s):// to ws(s)://
    this.wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
    try { this.binary = localStorage.getItem('sigil_binary_ws') !== '0'; } catch { /* SSR */ }
  }

  connect(): void {
    if (this.destroyed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.ws = new WebSocket(this.wsUrl, ['sigil.v1']);
      this.ws.binaryType = 'arraybuffer';
    } catch (err) {
      console.error('[SigilClient] WebSocket creation failed:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[SigilClient] WebSocket connected');
      this.connected = true;
      // Send auth — advertise binary capability so the server sends
      // channel.output as raw binary frames (and accepts binary channel.input).
      this.send({
        type: 'auth',
        payload: {
          token: this.token,
          client_info: { type: 'web', binary: this.binary ? 'true' : 'false' },
        },
      });
      // Start ping interval
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        this.send({ type: 'ping' });
      }, 25000);

      this._notifyHandlers('connect', null);
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        if (event.data instanceof ArrayBuffer) {
          this.handleBinaryFrame(new Uint8Array(event.data));
          return;
        }
        const msg: WsMessage = JSON.parse(event.data as string);
        this.handleMessage(msg);
      } catch (err) {
        console.error('[SigilClient] Failed to parse message:', err);
      }
    };

    this.ws.onclose = (event) => {
      console.log('[SigilClient] WebSocket closed:', event.code, event.reason);
      this.connected = false;
      this._clearPing();
      this._notifyHandlers('disconnect', null);
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error('[SigilClient] WebSocket error:', err);
    };
  }

  disconnect(): void {
    this.destroyed = true;
    this._clearPing();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler);
    return () => {
      const arr = this.handlers.get(type);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx !== -1) arr.splice(idx, 1);
      }
    };
  }

  // Channel operations (via WS)
  // lastSeq is the replay cursor: the seq of the last channel.output consumed
  // for this SESSION. Pass it on re-attach so the hub replays exactly the
  // missed bytes (channel.replay) before live output; omit for a fresh attach
  // (the hub sends a bounded tail instead).
  attach(hostName: string, sessionName: string, rows: number, cols: number, windowIndex?: number, lastSeq?: number | null): void {
    this.send({
      type: 'channel.attach',
      payload: {
        host_name: hostName,
        session_name: sessionName,
        window_index: windowIndex ?? -1,
        rows,
        cols,
        ...(lastSeq != null ? { last_seq: lastSeq } : {}),
      },
    });
  }

  detach(channelId: string): void {
    this.send({ type: 'channel.detach', channel_id: channelId });
  }

  sendInput(channelId: string, data: Uint8Array): void {
    if (this.binary && this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Binary input frame: [0x02][idLen : 1][channelID][payload]
      const id = new TextEncoder().encode(channelId);
      const frame = new Uint8Array(2 + id.length + data.length);
      frame[0] = 0x02;
      frame[1] = id.length;
      frame.set(id, 2);
      frame.set(data, 2 + id.length);
      this.ws.send(frame);
      return;
    }
    const base64 = btoa(String.fromCharCode(...data));
    this.send({
      type: 'channel.input',
      channel_id: channelId,
      payload: { data: base64 },
    });
  }

  // setBinary flips the binary hot-path live (no reconnect): update our own send
  // behaviour + tell the server to switch channel.output framing for this client.
  setBinary(on: boolean): void {
    this.binary = on;
    try { localStorage.setItem('sigil_binary_ws', on ? '1' : '0'); } catch { /* ignore */ }
    this.send({ type: 'client.binary', payload: { on } });
  }

  resize(channelId: string, rows: number, cols: number): void {
    this.send({
      type: 'channel.resize',
      channel_id: channelId,
      payload: { rows, cols },
    });
  }

  // REST API
  async getStatus(): Promise<{ version: string; git_commit?: string; build_date?: string; uptime_seconds: number; stats: Record<string, unknown> }> {
    return this._get('/api/v1/status');
  }

  async getHosts(): Promise<Host[]> {
    return this._get<Host[]>('/api/v1/hosts');
  }

  async addHost(input: HostInput): Promise<Host> {
    return this._post<Host>('/api/v1/hosts', input);
  }

  async updateHost(name: string, input: Omit<HostInput, 'name'>): Promise<Host> {
    return this._patch_json<Host>(`/api/v1/hosts/${encodeURIComponent(name)}`, input);
  }

  async removeHost(name: string): Promise<void> {
    await this._delete(`/api/v1/hosts/${encodeURIComponent(name)}`);
  }

  async connectHost(name: string): Promise<void> {
    await this._post(`/api/v1/hosts/${encodeURIComponent(name)}/connect`, {});
  }

  async disconnectHost(name: string): Promise<void> {
    await this._post(`/api/v1/hosts/${encodeURIComponent(name)}/disconnect`, {});
  }

  async getHostMetrics(name: string): Promise<HostMetrics> {
    return this._get<HostMetrics>(`/api/v1/hosts/${encodeURIComponent(name)}/metrics`);
  }

  async getAllMetrics(): Promise<HostMetrics[]> {
    return this._get<HostMetrics[]>('/api/v1/metrics');
  }

  // ── Widgets ────────────────────────────────────────────────────────────────
  // Coding-agent usage/capacity (Claude Code / Codex / Antigravity) computed host-side from
  // local transcripts.
  async getAgentUsage(host: string, provider: 'claude' | 'codex' | 'agy'): Promise<AgentUsage> {
    return this._get<AgentUsage>(
      `/api/v1/agent-usage?host=${encodeURIComponent(host)}&provider=${encodeURIComponent(provider)}`);
  }

  // Run an arbitrary command on a host and return its output — powers generic
  // "monitor" widgets. Command is base64'd so pipes/quotes survive transport.
  async execOnHost(host: string, command: string): Promise<ExecResult> {
    const b64 = btoa(unescape(encodeURIComponent(command)));
    return this._get<ExecResult>(
      `/api/v1/exec?host=${encodeURIComponent(host)}&cmd=${encodeURIComponent(b64)}`);
  }

  async getSessions(hostFilter?: string): Promise<Session[]> {
    const url = hostFilter ? `/api/v1/sessions?host=${encodeURIComponent(hostFilter)}` : '/api/v1/sessions';
    return this._get<Session[]>(url);
  }

  async createSession(hostName: string, name: string, startDir?: string, startCmd?: string): Promise<Session> {
    return this._post<Session>('/api/v1/sessions', {
      host_name: hostName,
      name,
      ...(startDir ? { start_dir: startDir } : {}),
      ...(startCmd ? { start_cmd: startCmd } : {}),
    });
  }

  // Adopt an externally-started tmux session: registers it as a tracked
  // session synchronously (metadata + durable log capture) instead of waiting
  // for the discovery loop. 404s if no such tmux session exists on the host;
  // idempotent for already-tracked sessions.
  async adoptSession(hostName: string, name: string): Promise<Session> {
    return this._post<Session>(`/api/v1/hosts/${encodeURIComponent(hostName)}/adopt`, { name });
  }

  async deleteSession(id: string): Promise<void> {
    await this._delete(`/api/v1/sessions/${id}`);
  }

  async renameSession(id: string, name: string): Promise<void> {
    await this._patch(`/api/v1/sessions/${id}`, { name });
  }

  // Resurrect a zombie session: tells sigild to run `tmux new-session -d -s <name>`
  // on the host using the row's stored start_dir / start_cmd (or overrides). The
  // endpoint is idempotent — calling it on an already-alive session is a no-op
  // success, so it's safe to wire to a button that's always visible.
  async resurrectSession(id: string, startDir?: string, startCmd?: string): Promise<void> {
    await this._post(`/api/v1/sessions/${id}/resurrect`, {
      ...(startDir ? { start_dir: startDir } : {}),
      ...(startCmd ? { start_cmd: startCmd } : {}),
    });
  }

  async getScrollback(sessionId: string, limit = 200, offset = 0): Promise<ScrollbackChunk[]> {
    return this._get<ScrollbackChunk[]>(
      `/api/v1/sessions/${sessionId}/scrollback?limit=${limit}&offset=${offset}`
    );
  }

  // captureScrollback uses tmux capture-pane server-side, returning rendered
  // terminal lines with SGR color codes only (no cursor-positioning sequences).
  // Limited by tmux's history-limit (set to 50 000 by sigil on first attach).
  // altOn reports whether a full-screen TUI (alternate screen) is active — the
  // web client gates per-client soft-wrap of the live tail on it (never reflow a
  // TUI). Defaults to true when the field is absent (older daemon = TUI-safe).
  async captureScrollback(sessionId: string): Promise<{ text: string; altOn: boolean }> {
    const resp = await this._get<{ text: string; alt_on?: boolean }>(`/api/v1/sessions/${sessionId}/capture`);
    return { text: resp.text, altOn: resp.alt_on ?? true };
  }

  // getPipedScrollback reads the pipe-pane log accumulated on the remote host.
  // This is an append-only file written by `tmux pipe-pane -o` — it grows for
  // the lifetime of the session and is not limited by history-limit.
  // Content is SGR-only ANSI (same format as captureScrollback), safe for
  // ansi-to-html.  Returns empty string if capture hasn't started yet.
  async getPipedScrollback(sessionId: string): Promise<string> {
    const resp = await this._get<{ text: string }>(`/api/v1/sessions/${sessionId}/pipe`);
    return resp.text;
  }

  // Ranged pipe read for scroll-back paging: bytes from `offset` → EOF (a NEGATIVE
  // offset seeds from the last |offset| bytes — the deep-history tail). Returns the
  // decoded text, the next byte offset, and a reset flag if the durable log rotated.
  // Backs the terminal's "load earlier history" on scroll-up, beyond the bounded
  // capture window.
  async getPipedScrollbackFrom(
    sessionId: string,
    offset: number,
  ): Promise<{ text: string; nextOffset: number; reset: boolean }> {
    const resp = await this._get<{ data: string; next_offset: number; reset: boolean }>(
      `/api/v1/sessions/${sessionId}/pipe?offset=${offset}`,
    );
    const bin = atob(resp.data || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return {
      text: new TextDecoder().decode(bytes),
      nextOffset: resp.next_offset ?? 0,
      reset: !!resp.reset,
    };
  }

  async getWorkspaces(): Promise<Array<{ id: string; name: string; config: string; created_at: string; updated_at: string }>> {
    return this._get('/api/v1/workspaces');
  }

  async saveWorkspace(ws: { id: string; name: string; config: string }): Promise<{ id: string; name: string; config: string; created_at: string; updated_at: string }> {
    return this._post('/api/v1/workspaces', ws);
  }

  // Full URL to fetch `url` through sigild's framable proxy (token in query so it
  // works as an <iframe src>). Used to open a session's links in-app.
  proxyUrl(url: string): string {
    return `${this.baseUrl}/api/v1/proxy?url=${encodeURIComponent(url)}&token=${encodeURIComponent(this.token)}`;
  }

  // Shared per-host / per-session accent colours (synced across all clients).
  async getPrefs(): Promise<{
    hosts: Record<string, string>; sessions: Record<string, string>;
    all: Record<string, string>; images: string[];
  }> {
    const d = await this._get<{ hosts?: Record<string, string>; sessions?: Record<string, string>; all?: Record<string, string>; images?: string[] }>('/api/v1/prefs');
    return { hosts: d.hosts ?? {}, sessions: d.sessions ?? {}, all: d.all ?? {}, images: d.images ?? [] };
  }

  // Set any shared pref (icon choice, image adjustment) — synced to all clients.
  async setPref(key: string, value: string): Promise<void> {
    await this._post('/api/v1/prefs/set', { key, value });
  }

  // ── Custom identity images (avatars/sigils), stored server-side ──────────────
  imageUrl(scope: string): string {
    return `${this.baseUrl}/api/v1/images?scope=${encodeURIComponent(scope)}&token=${encodeURIComponent(this.token)}`;
  }
  async uploadImage(scope: string, blob: Blob): Promise<void> {
    const r = await fetch(`${this.baseUrl}/api/v1/images?scope=${encodeURIComponent(scope)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': blob.type || 'image/webp' },
      body: blob,
    });
    if (!r.ok) throw new Error(`image upload failed (${r.status})`);
  }
  // Copy a scope's image onto another scope (rename changes the scope key). Throws
  // if the source can't be read or the copy can't be stored, so callers can keep the
  // original and fall back rather than pointing a mark at a missing image.
  async copyImage(from: string, to: string): Promise<void> {
    const r = await fetch(`${this.baseUrl}/api/v1/images?scope=${encodeURIComponent(from)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!r.ok) throw new Error(`image fetch failed (${r.status})`);
    await this.uploadImage(to, await r.blob());
  }
  async deleteImage(scope: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/v1/images?scope=${encodeURIComponent(scope)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${this.token}` },
    });
  }

  async setColorPref(kind: 'host' | 'session', host: string, session: string | null, color: string | null): Promise<void> {
    await this._post('/api/v1/prefs/color', { kind, host, session: session ?? '', color: color ?? '' });
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this._delete(`/api/v1/workspaces/${encodeURIComponent(id)}`);
  }

  async browseDir(hostName: string, path: string): Promise<DirListing> {
    return this._get<DirListing>(
      `/api/v1/hosts/${encodeURIComponent(hostName)}/files?browse=1&path=${encodeURIComponent(path)}`
    );
  }

  async readFile(hostName: string, path: string): Promise<FileContent> {
    return this._get<FileContent>(
      `/api/v1/hosts/${encodeURIComponent(hostName)}/files?path=${encodeURIComponent(path)}`
    );
  }

  async pushPreview(hostName: string, path: string): Promise<void> {
    await this._post('/api/v1/preview', { host_name: hostName, path });
  }

  async search(query: string, _sessionId?: string, limit = 50): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return this._get<SearchResult[]>(`/api/v1/search?${params}`);
  }

  // ── Triggers ──────────────────────────────────────────────────────────────
  async getTriggers(): Promise<Trigger[]> {
    return this._get<Trigger[]>('/api/v1/triggers');
  }
  async createTrigger(t: Omit<Trigger, 'id'>): Promise<Trigger> {
    return this._post<Trigger>('/api/v1/triggers', t);
  }
  async updateTrigger(id: string, t: Omit<Trigger, 'id'>): Promise<Trigger> {
    return this._patch_json<Trigger>(`/api/v1/triggers/${encodeURIComponent(id)}`, t);
  }
  async deleteTrigger(id: string): Promise<void> {
    await this._delete(`/api/v1/triggers/${encodeURIComponent(id)}`);
  }

  // ── Settings + storage maintenance ────────────────────────────────────────
  async getSettings(): Promise<Settings> {
    return this._get<Settings>('/api/v1/settings');
  }
  async updateSettings(s: Settings): Promise<Settings> {
    return this._put_json<Settings>('/api/v1/settings', s);
  }
  async runMaintenance(action: 'prune' | 'vacuum' | 'vacuum_full'): Promise<MaintenanceResult> {
    return this._post<MaintenanceResult>('/api/v1/maintenance', { action });
  }

  // ── File transfer (Phase 6 backend) ──────────────────────────────────────

  // Multipart upload of one or more files into `dir` on the host.
  async uploadFiles(hostName: string, dir: string, files: File[] | FileList, overwrite = false): Promise<{ written: string[] }> {
    const fd = new FormData();
    fd.append('dir', dir);
    fd.append('overwrite', overwrite ? '1' : '0');
    for (const f of Array.from(files)) fd.append('file', f, f.name);
    const res = await fetch(`${this.baseUrl}/api/v1/hosts/${encodeURIComponent(hostName)}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` }, // no Content-Type — browser sets boundary
      body: fd,
    });
    if (!res.ok) throw new Error(await this._errText(res));
    const json = await res.json();
    return (json?.data ?? json) as { written: string[] };
  }

  // Fetch raw file bytes as a Blob (binaries, images, large files).
  async downloadBlob(hostName: string, path: string, inline = false): Promise<Blob> {
    const params = new URLSearchParams({ path });
    if (inline) params.set('disposition', 'inline');
    const res = await fetch(`${this.baseUrl}/api/v1/hosts/${encodeURIComponent(hostName)}/download?${params}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(await this._errText(res));
    return res.blob();
  }

  async moveFile(hostName: string, src: string, dst: string, overwrite = false): Promise<{ path: string }> {
    return this._post(`/api/v1/hosts/${encodeURIComponent(hostName)}/files/move`, { src, dst, overwrite });
  }

  async copyFile(hostName: string, src: string, dst: string, overwrite = false): Promise<{ path: string }> {
    return this._post(`/api/v1/hosts/${encodeURIComponent(hostName)}/files/copy`, { src, dst, overwrite });
  }

  async transferFile(srcHost: string, srcPath: string, dstHost: string, dstPath: string, overwrite = false): Promise<{ path: string }> {
    return this._post('/api/v1/transfer', { src_host: srcHost, src_path: srcPath, dst_host: dstHost, dst_path: dstPath, overwrite });
  }

  private async _errText(res: Response): Promise<string> {
    try {
      const j = await res.json();
      return j?.error?.message || j?.error || `HTTP ${res.status}`;
    } catch {
      return `HTTP ${res.status}: ${res.statusText}`;
    }
  }

  private send(msg: WsMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.warn('[SigilClient] Cannot send, WebSocket not open:', msg.type);
    }
  }

  private handleMessage(msg: WsMessage): void {
    // Notify type-specific handlers
    this._notifyHandlers(msg.type, msg.payload, msg.channel_id);
    // Notify wildcard handlers
    this._notifyHandlers('*', msg);
  }

  // handleBinaryFrame decodes a binary channel.output frame and dispatches it as
  // a normal 'channel.output' event, but with the raw bytes already decoded
  // (payload.bytes) instead of base64 (payload.data). Frame layout:
  //   [0x01][seq uint64 BE : 8][idLen : 1][channelID][payload]
  private handleBinaryFrame(buf: Uint8Array): void {
    if (buf.length < 10 || buf[0] !== 0x01) return;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const seq = dv.getUint32(1) * 2 ** 32 + dv.getUint32(5); // uint64 → JS number (safe < 2^53)
    const idLen = buf[9];
    const idEnd = 10 + idLen;
    if (buf.length < idEnd) return;
    const channelId = new TextDecoder().decode(buf.subarray(10, idEnd));
    this._notifyHandlers('channel.output', { bytes: buf.subarray(idEnd), seq }, channelId);
  }

  private _notifyHandlers(type: string, payload: unknown, channelId?: string): void {
    const arr = this.handlers.get(type);
    if (arr) {
      for (const h of [...arr]) {
        try {
          h(payload, channelId);
        } catch (err) {
          console.error('[SigilClient] Handler error:', err);
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimeout) return;
    console.log('[SigilClient] Scheduling reconnect in 3s...');
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (!this.destroyed) {
        this.connect();
      }
    }, 3000);
  }

  private _clearPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private async _get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = (await res.json()) as APIResponse<T> | T;
    // Handle both wrapped and unwrapped responses
    if (json && typeof json === 'object' && 'data' in json) {
      return (json as APIResponse<T>).data;
    }
    return json as T;
  }

  private async _post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = (await res.json()) as APIResponse<T> | T;
    if (json && typeof json === 'object' && 'data' in json) {
      return (json as APIResponse<T>).data;
    }
    return json as T;
  }

  private async _patch(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  private async _patch_json<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = (await res.json()) as APIResponse<T> | T;
    if (json && typeof json === 'object' && 'data' in json) {
      return (json as APIResponse<T>).data;
    }
    return json as T;
  }

  private async _put_json<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = (await res.json()) as APIResponse<T> | T;
    if (json && typeof json === 'object' && 'data' in json) {
      return (json as APIResponse<T>).data;
    }
    return json as T;
  }

  private async _delete(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
}

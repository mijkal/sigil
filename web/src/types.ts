export interface Host {
  name: string;
  hostname: string;
  port: number;
  user: string;
  auth_method?: string;
  auto_connect?: boolean;
  status: 'connected' | 'disconnected' | 'error';
  tags: string[];
  error?: string;
}

// A trigger fires an action when a session's output matches a regex pattern.
// action ∈ flash | tint | audio | toast | webhook. config is action-specific
// (e.g. colour, duration_ms, tone_hz, level/title/message, url/secret).
export interface Trigger {
  id: string;
  name: string;
  pattern: string;
  action: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

// Global storage/retention settings (hub-wide tier). retention_days=0 disables
// the age-based trim; max_bytes_per_session=0 disables the per-session byte cap.
export interface Settings {
  retention_days: number;
  max_bytes_per_session: number;
  event_keep: number;
  auto_vacuum: boolean;
}

export interface MaintenanceResult {
  action: string;
  db_size_bytes?: number;
  events_deleted?: number;
}

export interface TmuxWindow {
  id: string;      // @N
  index: number;
  name: string;
  active: boolean;
  panes: number;
}

export interface Session {
  id: string;
  host_name: string;
  name: string;
  windows: number;
  window_list: TmuxWindow[];
  tags: string[];
  created_at: string;
  last_active: string;
  status: 'active' | 'detached';
  // Live UX signal from the daemon. 'working' = running + output flowing;
  // 'attention' = just stopped (pre-classification); then refined into 'waiting'
  // (paused for a question), 'done' (finished), or 'error' (API/blocked). Empty = idle.
  activity?: 'working' | 'attention' | 'waiting' | 'done' | 'error';
  start_dir?: string;
  start_cmd?: string;
  // Durable pipe-pane log file on the target host ("~/" form) — readable via
  // the /files endpoint.
  log_path?: string;
}

// ── Per-host resource metrics ──────────────────────────────────────────────

export type HostHealth = 'healthy' | 'warn' | 'err' | 'unknown';

export interface HostInfo {
  os: string;         // "linux" | "darwin"
  os_pretty: string;  // e.g. "Debian GNU/Linux 13 (trixie)", "macOS 15.1"
  kernel: string;
  arch: string;
  cpu_model: string;
  cores: number;
  mem_total: number;  // bytes
  disk_total: number; // bytes
  has_psi: boolean;   // false on macOS
}

export interface ProcInfo {
  cpu: number;  // percent
  mem: number;  // percent
  name: string;
}

export interface MetricSample {
  t: number;          // unix seconds
  load1: number;
  load5: number;
  load15: number;
  psi_cpu: number;    // -1 = N/A (macOS)
  psi_mem: number;    // -1 = N/A (macOS)
  mem_used: number;
  mem_total: number;
  swap_used: number;
  swap_total: number;
  disk_used: number;
  disk_total: number;
  net_rx: number;     // cumulative bytes
  net_tx: number;     // cumulative bytes
}

export interface HostMetrics {
  host: string;
  health: HostHealth;
  info: HostInfo;
  current: MetricSample;
  history: MetricSample[]; // oldest → newest
  procs: ProcInfo[];
  stale: boolean;
  error?: string;
}

export interface ScrollbackChunk {
  id: number;
  session_id: string;
  sequence: number;
  timestamp: string;
  data: string; // base64
  line_count: number;
}

export interface SearchResult {
  session_id: string;
  host_name: string;
  session_name: string;
  snippet: string;
  timestamp: string;
  line_number: number;
}

export interface WsMessage {
  type: string;
  id?: string;
  channel_id?: string;
  timestamp?: string;
  payload?: unknown;
}

export interface DirEntry {
  name: string;
  is_dir: boolean;
  size: number;
}

export interface DirListing {
  path: string;
  entries: DirEntry[];
}

export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
}

export interface HostInput {
  name: string;
  hostname: string;
  port?: number;
  user: string;
  auth_method?: 'key' | 'agent' | 'password';
  private_key_path?: string;
  password?: string;
  tags?: string[];
  auto_connect?: boolean;
}

// ── Widgets ───────────────────────────────────────────────────────────────────

// One usage bucket (a time window). `models` maps model → work tokens (in+out).
export interface UsageBucket {
  in: number;
  out: number;
  cache: number;
  msgs: number;
  models: Record<string, number>;
}

// Coding-agent usage burndown returned by GET /api/v1/agent-usage.
export interface AgentUsage {
  provider: string;
  generated_at: number;
  scanned: number;
  files: number;
  last5h: UsageBucket;
  today: UsageBucket;
  week: UsageBucket;
  hourly: number[]; // 24 values, oldest→newest (work tokens/hour)
}

// Result of GET /api/v1/exec (generic command widget).
export interface ExecResult {
  host: string;
  ms: number;
  stdout: string;
  truncated: boolean;
  error?: string;
}

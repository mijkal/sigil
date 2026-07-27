package tui

import (
	"context"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	sigil "sigil.dev/sigil/pkg/sigil"
)

// pollInterval is how often the TUI silently re-fetches hosts/sessions/metrics
// so the activity glyphs and resource meters stay live without a keypress.
const pollInterval = 4 * time.Second

// viewID is the active top-level tab.
type viewID int

const (
	viewHome viewID = iota
	viewSessions
	viewHosts
)

// modalID is the active blocking prompt/overlay, if any.
type modalID int

const (
	modalNone modalID = iota
	modalNewSession  // prompt for a new session name on pending.host
	modalRename      // prompt for a new name for pending session
	modalConfirmKill // confirm destroying pending session
)

// row is one attachable session, pre-joined with its host for a one-key attach.
type row struct {
	host    sigil.Host
	session sigil.Session
	label   string // "host / session" — the fuzzy-filter key and display line
}

// fetchedMsg carries the result of a hosts+sessions+metrics+status refresh.
type fetchedMsg struct {
	hosts    []sigil.Host
	sessions []sigil.Session
	metrics  []sigil.HostMetrics
	status   StatusInfo
	err      error
}

// attachDoneMsg fires when the suspended ssh child exits (detach or error).
type attachDoneMsg struct{ err error }

// actionDoneMsg fires when a CRUD action (create/kill/rename/connect) returns.
type actionDoneMsg struct {
	verb string // human label for the flash line, e.g. "created session api"
	err  error
}

// tickMsg drives the silent live-refresh poll.
type tickMsg time.Time

// Model is the Bubbletea model for the sigil launcher.
type Model struct {
	client *Client
	server string

	view viewID

	rows     []row // every session, host-sorted
	visible  []row // rows after the active filter
	hosts    []sigil.Host
	metrics  map[string]sigil.HostMetrics
	version  string
	loading  bool
	err      error // last fetch error (drives the error panel)

	cursor     int // sessions list cursor (over visible)
	hostCursor int // hosts list cursor

	filter    textinput.Model
	filtering bool

	modal    modalID
	prompt   textinput.Model
	pending  row // session/host the modal acts on

	spinner  spinner.Model
	showHelp bool
	sidebar  bool

	flash     string    // transient success/status line under the footer
	flashKind bool      // true = success (green), false = plain
	flashAt   time.Time // when the flash was set (poll clears stale ones)

	width, height int
	quitting      bool
}

// New builds the initial model for the given client and server label.
func New(client *Client, server string) Model {
	sp := spinner.New()
	sp.Spinner = spinner.Dot
	sp.Style = lipgloss.NewStyle().Foreground(colAccent)

	ti := textinput.New()
	ti.Prompt = "/ "
	ti.Placeholder = "fuzzy filter"
	ti.PromptStyle = lipgloss.NewStyle().Foreground(colAccent)
	ti.TextStyle = lipgloss.NewStyle().Foreground(colText)

	pr := textinput.New()
	pr.Prompt = "› "
	pr.PromptStyle = lipgloss.NewStyle().Foreground(colAccent)
	pr.TextStyle = lipgloss.NewStyle().Foreground(colText)

	return Model{
		client:  client,
		server:  server,
		view:    viewHome,
		filter:  ti,
		prompt:  pr,
		spinner: sp,
		metrics: map[string]sigil.HostMetrics{},
		loading: true,
	}
}

// Init kicks off the first fetch, the loading spinner, and the live poll.
func (m Model) Init() tea.Cmd {
	return tea.Batch(m.spinner.Tick, m.fetchCmd(), tickCmd())
}

func tickCmd() tea.Cmd {
	return tea.Tick(pollInterval, func(t time.Time) tea.Msg { return tickMsg(t) })
}

// fetchCmd queries /hosts, /sessions, /metrics and /status in one go.
func (m Model) fetchCmd() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx := context.Background()
		hosts, err := client.Hosts(ctx)
		if err != nil {
			return fetchedMsg{err: err}
		}
		sessions, err := client.Sessions(ctx)
		if err != nil {
			return fetchedMsg{err: err}
		}
		status, _ := client.Status(ctx)   // version banner is best-effort
		metrics, _ := client.Metrics(ctx) // sidebar is best-effort
		return fetchedMsg{hosts: hosts, sessions: sessions, metrics: metrics, status: status}
	}
}

// attachCmd suspends the TUI and hands the terminal to `ssh … tmux attach`.
func (m Model) attachCmd(r row) tea.Cmd {
	args := attachArgs(r.host, r.session.Name)
	c := exec.Command(args[0], args[1:]...) // #nosec G204 — argv from typed Host, no shell
	return tea.ExecProcess(c, func(err error) tea.Msg {
		return attachDoneMsg{err: err}
	})
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil

	case spinner.TickMsg:
		if m.loading {
			var cmd tea.Cmd
			m.spinner, cmd = m.spinner.Update(msg)
			return m, cmd
		}
		return m, nil

	case tickMsg:
		// Silent live refresh — no spinner, keep the current view/cursor. Skip
		// while a fetch is already in flight to avoid piling up requests.
		var cmd tea.Cmd
		if !m.loading && m.err == nil {
			cmd = m.fetchCmd()
		}
		if !m.flashAt.IsZero() && time.Time(msg).Sub(m.flashAt) > 4*time.Second {
			m.flash = ""
			m.flashAt = time.Time{}
		}
		return m, tea.Batch(cmd, tickCmd())

	case fetchedMsg:
		m.loading = false
		m.err = msg.err
		if msg.err == nil {
			m.version = msg.status.Version
			m.hosts = msg.hosts
			m.metrics = metricsByHost(msg.metrics)
			m.rebuildRows(msg.hosts, msg.sessions)
			m.clampCursors()
		}
		return m, nil

	case attachDoneMsg:
		m.loading = true
		return m, tea.Batch(m.spinner.Tick, m.fetchCmd())

	case actionDoneMsg:
		if msg.err != nil {
			m.setFlash("✗ "+msg.verb+" failed: "+msg.err.Error(), false)
		} else {
			m.setFlash("✓ "+msg.verb, true)
		}
		m.loading = true
		return m, tea.Batch(m.spinner.Tick, m.fetchCmd())

	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m *Model) setFlash(s string, ok bool) {
	m.flash, m.flashKind, m.flashAt = s, ok, time.Now()
}

func metricsByHost(ms []sigil.HostMetrics) map[string]sigil.HostMetrics {
	out := make(map[string]sigil.HostMetrics, len(ms))
	for _, hm := range ms {
		out[hm.Host] = hm
	}
	return out
}

// handleKey routes a keypress through modal → filter → view-specific handling.
func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.modal != modalNone {
		return m.handleModalKey(msg)
	}
	if m.filtering {
		return m.handleFilterKey(msg)
	}

	// Global keys (available on every view).
	switch msg.String() {
	case "q", "ctrl+c":
		m.quitting = true
		return m, tea.Quit
	case "?":
		m.showHelp = !m.showHelp
		return m, nil
	case "s":
		m.sidebar = !m.sidebar
		return m, nil
	case "tab", "right", "l":
		// ←/→ move along the horizontal tab bar (matches the layout); tab cycles.
		m.view = (m.view + 1) % 3
		return m, nil
	case "shift+tab", "left", "h":
		m.view = (m.view + 2) % 3
		return m, nil
	case "1":
		m.view = viewHome
		return m, nil
	case "2":
		m.view = viewSessions
		return m, nil
	case "3":
		m.view = viewHosts
		return m, nil
	case "r":
		m.loading = true
		m.err = nil
		return m, tea.Batch(m.spinner.Tick, m.fetchCmd())
	}

	switch m.view {
	case viewSessions:
		return m.handleSessionsKey(msg)
	case viewHosts:
		return m.handleHostsKey(msg)
	default: // home
		return m.handleHomeKey(msg)
	}
}

func (m Model) handleHomeKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "enter" {
		m.view = viewSessions
	}
	return m, nil
}

func (m Model) handleSessionsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.visible)-1 {
			m.cursor++
		}
	case "g", "home":
		m.cursor = 0
	case "G", "end":
		m.cursor = max(0, len(m.visible)-1)
	case "/":
		m.filtering = true
		m.showHelp = false
		m.filter.Focus()
		return m, textinput.Blink
	case "enter":
		if r, ok := m.current(); ok {
			return m, m.attachCmd(r)
		}
	case "n":
		return m.openNewSession()
	case "R", "e":
		if r, ok := m.current(); ok {
			m.pending = r
			m.modal = modalRename
			m.prompt.SetValue(r.session.Name)
			m.prompt.CursorEnd()
			m.prompt.Focus()
			return m, textinput.Blink
		}
	case "x", "delete":
		if r, ok := m.current(); ok {
			m.pending = r
			m.modal = modalConfirmKill
		}
	}
	return m, nil
}

// openNewSession seeds a create-session modal targeting the current row's host.
func (m Model) openNewSession() (tea.Model, tea.Cmd) {
	r, ok := m.current()
	if !ok {
		// No session context — nudge toward Hosts where every host is pickable.
		if len(m.hosts) == 0 {
			return m, nil
		}
		m.view = viewHosts
		if h, ok := m.currentHost(); ok {
			m.pending = row{host: h}
		}
	} else {
		m.pending = r
	}
	m.modal = modalNewSession
	m.prompt.SetValue("")
	m.prompt.Focus()
	return m, textinput.Blink
}

func (m Model) handleHostsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up", "k":
		if m.hostCursor > 0 {
			m.hostCursor--
		}
	case "down", "j":
		if m.hostCursor < len(m.hosts)-1 {
			m.hostCursor++
		}
	case "g", "home":
		m.hostCursor = 0
	case "G", "end":
		m.hostCursor = max(0, len(m.hosts)-1)
	case "c":
		if h, ok := m.currentHost(); ok {
			return m, m.hostActionCmd(h.Name, "connect")
		}
	case "d":
		if h, ok := m.currentHost(); ok {
			return m, m.hostActionCmd(h.Name, "disconnect")
		}
	case "n":
		if h, ok := m.currentHost(); ok {
			m.pending = row{host: h}
			m.modal = modalNewSession
			m.prompt.SetValue("")
			m.prompt.Focus()
			return m, textinput.Blink
		}
	case "enter":
		// Jump to this host's sessions, filtered to it.
		if h, ok := m.currentHost(); ok {
			m.view = viewSessions
			m.filter.SetValue(h.Name + " / ")
			m.applyFilter()
		}
	}
	return m, nil
}

func (m Model) handleFilterKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.filtering = false
		m.filter.Blur()
		m.filter.SetValue("")
		m.applyFilter()
	case "enter":
		m.filtering = false
		m.filter.Blur()
	default:
		var cmd tea.Cmd
		m.filter, cmd = m.filter.Update(msg)
		m.applyFilter()
		return m, cmd
	}
	return m, nil
}

func (m Model) handleModalKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch m.modal {
	case modalConfirmKill:
		switch msg.String() {
		case "y", "enter":
			id := m.pending.session.ID
			name := m.pending.session.Name
			m.modal = modalNone
			return m, m.killCmd(id, name)
		default: // n, esc, anything else cancels
			m.modal = modalNone
		}
		return m, nil

	case modalNewSession, modalRename:
		switch msg.String() {
		case "esc":
			m.modal = modalNone
			m.prompt.Blur()
			return m, nil
		case "enter":
			val := strings.TrimSpace(m.prompt.Value())
			mode := m.modal
			pending := m.pending
			m.modal = modalNone
			m.prompt.Blur()
			if val == "" {
				return m, nil
			}
			if mode == modalNewSession {
				return m, m.createCmd(pending.host.Name, val)
			}
			return m, m.renameCmd(pending.session.ID, pending.session.Name, val)
		default:
			var cmd tea.Cmd
			m.prompt, cmd = m.prompt.Update(msg)
			return m, cmd
		}
	}
	return m, nil
}

// --- action commands ---

func (m Model) createCmd(host, name string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		err := client.CreateSession(context.Background(), host, name)
		return actionDoneMsg{verb: "created " + host + " / " + name, err: err}
	}
}

func (m Model) killCmd(id, name string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		err := client.KillSession(context.Background(), id)
		return actionDoneMsg{verb: "killed session " + name, err: err}
	}
}

func (m Model) renameCmd(id, old, newName string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		err := client.RenameSession(context.Background(), id, newName)
		return actionDoneMsg{verb: "renamed " + old + " → " + newName, err: err}
	}
}

func (m Model) hostActionCmd(name, verb string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		var err error
		if verb == "connect" {
			err = client.ConnectHost(context.Background(), name)
		} else {
			err = client.DisconnectHost(context.Background(), name)
		}
		return actionDoneMsg{verb: verb + "ed " + name, err: err}
	}
}

// --- data shaping ---

// rebuildRows flattens hosts+sessions into host-sorted rows and re-applies the
// active filter, keeping the cursor in range.
func (m *Model) rebuildRows(hosts []sigil.Host, sessions []sigil.Session) {
	byName := make(map[string]sigil.Host, len(hosts))
	for _, h := range hosts {
		byName[h.Name] = h
	}

	rows := make([]row, 0, len(sessions))
	for _, s := range sessions {
		rows = append(rows, row{
			host:    byName[s.HostName], // zero Host if unknown; attach still forms argv
			session: s,
			label:   s.HostName + " / " + s.Name,
		})
	}
	sort.SliceStable(rows, func(a, b int) bool {
		if rows[a].session.HostName != rows[b].session.HostName {
			return rows[a].session.HostName < rows[b].session.HostName
		}
		return rows[a].session.Name < rows[b].session.Name
	})
	m.rows = rows
	m.applyFilter()
}

// applyFilter recomputes the visible rows from the current filter text.
func (m *Model) applyFilter() {
	q := strings.TrimSpace(m.filter.Value())
	if q == "" {
		m.visible = m.rows
	} else {
		labels := make([]string, len(m.rows))
		for i, r := range m.rows {
			labels[i] = r.label
		}
		ranked := fuzzyFilter(labels, q)
		byLabel := make(map[string]row, len(m.rows))
		for _, r := range m.rows {
			byLabel[r.label] = r
		}
		vis := make([]row, 0, len(ranked))
		for _, l := range ranked {
			vis = append(vis, byLabel[l])
		}
		m.visible = vis
	}
	if m.cursor >= len(m.visible) {
		m.cursor = max(0, len(m.visible)-1)
	}
}

func (m *Model) clampCursors() {
	if m.cursor >= len(m.visible) {
		m.cursor = max(0, len(m.visible)-1)
	}
	if m.hostCursor >= len(m.hosts) {
		m.hostCursor = max(0, len(m.hosts)-1)
	}
}

// current returns the highlighted session row, if any.
func (m Model) current() (row, bool) {
	if m.cursor < 0 || m.cursor >= len(m.visible) {
		return row{}, false
	}
	return m.visible[m.cursor], true
}

// currentHost returns the highlighted host, if any.
func (m Model) currentHost() (sigil.Host, bool) {
	if m.hostCursor < 0 || m.hostCursor >= len(m.hosts) {
		return sigil.Host{}, false
	}
	return m.hosts[m.hostCursor], true
}

// --- fleet summary (home + header) ---

type fleetSummary struct {
	hostsTotal, hostsConnected     int
	sessions, working, attention   int
}

func (m Model) summary() fleetSummary {
	var f fleetSummary
	f.hostsTotal = len(m.hosts)
	for _, h := range m.hosts {
		switch h.Status {
		case "connected", "online", "active":
			f.hostsConnected++
		}
	}
	f.sessions = len(m.rows)
	for _, r := range m.rows {
		switch r.session.Activity {
		case "working":
			f.working++
		case "attention":
			f.attention++
		}
	}
	return f
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// connState summarises the header connection indicator.
func (m Model) connState() string {
	switch {
	case m.loading && len(m.rows) == 0 && len(m.hosts) == 0:
		return styleServer.Render("connecting…")
	case m.err != nil:
		return lipgloss.NewStyle().Foreground(colDanger).Render("● offline")
	default:
		v := "online"
		if m.version != "" {
			v = "online · v" + m.version
		}
		return lipgloss.NewStyle().Foreground(colSuccess).Render("● ") + styleServer.Render(v)
	}
}

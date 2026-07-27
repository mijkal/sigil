package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// sidebarWidth is the total column width the resource sidebar occupies.
const sidebarWidth = 30

// View renders the whole screen: header (wordmark + tabs), body (the active
// view, optionally beside the resource sidebar), and footer.
func (m Model) View() string {
	if m.quitting {
		return ""
	}

	header := m.headerView()
	footer := m.footerView()

	// Reserve vertical space for header + footer; the body fills the rest.
	bodyHeight := m.height - lipgloss.Height(header) - lipgloss.Height(footer) - 2
	if bodyHeight < 3 {
		bodyHeight = 3
	}
	mainWidth := m.width
	if m.sidebar && m.width > sidebarWidth+20 {
		mainWidth = m.width - sidebarWidth
	}

	body := m.bodyView(mainWidth, bodyHeight)
	if mainWidth != m.width {
		main := lipgloss.NewStyle().Width(mainWidth - 1).Height(bodyHeight).MaxHeight(bodyHeight).Render(body)
		side := styleSidebar.Height(bodyHeight).MaxHeight(bodyHeight).Render(m.sidebarView(sidebarWidth-3, bodyHeight))
		body = lipgloss.JoinHorizontal(lipgloss.Top, main, side)
	}

	return header + "\n" + body + "\n" + footer
}

// bodyView dispatches to the active view (or a global loading/error panel).
func (m Model) bodyView(width, height int) string {
	switch {
	case m.loading && len(m.rows) == 0 && len(m.hosts) == 0:
		return "\n" + m.spinner.View() + styleServer.Render(" connecting to "+m.server)
	case m.err != nil:
		return m.errorView()
	case m.modal != modalNone:
		return m.modalView(width, height)
	}

	switch m.view {
	case viewSessions:
		return m.sessionsView(width, height)
	case viewHosts:
		return m.hostsView(width, height)
	default:
		return m.homeView(width, height)
	}
}

func (m Model) headerView() string {
	mark := styleMark.Render("⬡ SIGIL")
	sep := styleMeta.Render("·")
	server := styleServer.Render(m.server)
	top := strings.Join([]string{mark, sep, server, sep, m.connState()}, " ")

	tabs := m.tabBar()
	sidebarHint := styleKey.Render("[s]") + styleFooter.Render(" sidebar")
	// Right-align the sidebar hint on the tab row when there is room.
	gap := m.width - lipgloss.Width(tabs) - lipgloss.Width(sidebarHint)
	tabRow := tabs
	if gap > 1 {
		tabRow = tabs + strings.Repeat(" ", gap) + sidebarHint
	}

	rule := ""
	if m.width > 0 {
		rule = styleRule.Render(strings.Repeat("─", m.width))
	}
	return top + "\n" + tabRow + "\n" + rule
}

func (m Model) tabBar() string {
	names := []string{"Home", "Sessions", "Hosts"}
	parts := make([]string, len(names))
	for i, n := range names {
		if viewID(i) == m.view {
			parts[i] = styleTabActive.Render(n)
		} else {
			parts[i] = styleTab.Render(n)
		}
	}
	return lipgloss.JoinHorizontal(lipgloss.Bottom, parts...)
}

func (m Model) errorView() string {
	title := styleErrTitle.Render("⚠ cannot reach sigild")
	var detail string
	if se, ok := m.err.(*StatusError); ok {
		detail = styleErrBody.Render(se.Error())
		if se.StatusCode == 401 {
			detail += "\n" + styleHint.Render("token missing or rejected — set --token / SIGIL_TOKEN")
		}
	} else {
		detail = styleErrBody.Render(m.err.Error())
		detail += "\n" + styleHint.Render("check --server / SIGIL_SERVER and that sigild is running")
	}
	return "\n" + title + "\n\n" + detail + "\n\n" + styleHint.Render("press r to retry · q to quit")
}

func (m Model) footerView() string {
	var line string
	switch {
	case m.showHelp:
		return m.helpView()
	case m.modal != modalNone:
		line = m.modalFooter()
	case m.filtering:
		line = styleFooter.Render("type to filter · ") + styleKey.Render("enter") +
			styleFooter.Render(" keep · ") + styleKey.Render("esc") + styleFooter.Render(" clear")
	default:
		line = styleFooter.Render(strings.Join(m.footerKeys(), styleFooter.Render(" · ")))
	}
	if m.flash != "" {
		fk := styleHint
		if m.flashKind {
			fk = styleFlash
		}
		line = fk.Render(m.flash) + "\n" + line
	}
	return line
}

// footerKeys returns the context hint keys for the active view.
func (m Model) footerKeys() []string {
	switch m.view {
	case viewSessions:
		return []string{
			key("←/→", "views"), key("↑/↓", "move"), key("enter", "attach"), key("n", "new"),
			key("x", "kill"), key("R", "rename"), key("/", "filter"), key("?", "help"), key("q", "quit"),
		}
	case viewHosts:
		return []string{
			key("←/→", "views"), key("↑/↓", "move"), key("enter", "sessions"), key("c", "connect"),
			key("d", "disconnect"), key("n", "new session"), key("?", "help"), key("q", "quit"),
		}
	default:
		return []string{
			key("←/→/tab", "switch views"), key("enter", "sessions"), key("s", "sidebar"),
			key("r", "refresh"), key("?", "help"), key("q", "quit"),
		}
	}
}

func (m Model) helpView() string {
	lines := []string{
		styleTitle.Render("keys"),
		"  " + key("←/→, tab", "switch view (Home · Sessions · Hosts)"),
		"  " + key("1 · 2 · 3", "jump straight to Home · Sessions · Hosts"),
		"  " + key("s", "toggle the resource sidebar"),
		"  " + key("↑/↓, j/k", "move selection") + "   " + key("g / G", "top / bottom"),
		"",
		styleTitle.Render("sessions"),
		"  " + key("enter", "attach — hands off to real ssh + tmux"),
		"  " + styleHint.Render("↳ to come back, detach tmux: prefix + d (default ctrl-b d)"),
		"  " + key("n", "new session") + "   " + key("x", "kill (confirm)") + "   " + key("R", "rename"),
		"  " + key("/", "fuzzy filter (enter keeps, esc clears)"),
		"",
		styleTitle.Render("hosts"),
		"  " + key("c / d", "connect / disconnect") + "   " + key("enter", "view its sessions"),
		"",
		"  " + key("r", "refresh") + "   " + key("?", "close help") + "   " + key("q, ctrl-c", "quit"),
		"",
		styleHint.Render("signals  ") +
			glyph(colSuccess, "●") + styleHint.Render(" working  ") +
			glyph(colWarning, "◆") + styleHint.Render(" needs you  ") +
			glyph(colInfo, "●") + styleHint.Render(" connected  ") +
			glyph(colMuted, "○") + styleHint.Render(" idle"),
	}
	return strings.Join(lines, "\n")
}

// key formats a "<key> label" hint with the key in muted colour.
func key(k, label string) string {
	return styleKey.Render(k) + " " + styleFooter.Render(label)
}

// windowList slices lines to a scroll window of at most height lines that keeps
// cursor visible, prefixing/suffixing a subtle "more" marker when clipped.
func windowList(lines []string, cursor, height int) string {
	if height < 1 {
		height = 1
	}
	if len(lines) <= height {
		return strings.Join(lines, "\n")
	}
	start := cursor - height/2
	if start < 0 {
		start = 0
	}
	if start+height > len(lines) {
		start = len(lines) - height
	}
	win := lines[start : start+height]
	out := strings.Join(win, "\n")
	if start > 0 {
		out = styleMeta.Render("  ↑ "+itoa(start)+" more") + "\n" + out
	}
	if start+height < len(lines) {
		out += "\n" + styleMeta.Render("  ↓ "+itoa(len(lines)-start-height)+" more")
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

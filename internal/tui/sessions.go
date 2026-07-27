package tui

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
)

// sessionsView renders the session list (with a filter line when filtering) and
// windows it to the available height.
func (m Model) sessionsView(width, height int) string {
	var head string
	rowHeight := height
	if m.filtering || m.filter.Value() != "" {
		count := styleMeta.Render(fmt.Sprintf("  %d/%d", len(m.visible), len(m.rows)))
		filterLine := m.filter.View()
		if !m.filtering {
			filterLine = styleKey.Render("/ ") + styleTitle.Render(m.filter.Value())
		}
		head = filterLine + count + "\n\n"
		rowHeight -= 2
	}

	if len(m.visible) == 0 {
		if len(m.rows) == 0 {
			return head + styleServer.Render("no sessions yet — press ") + styleKey.Render("n") +
				styleServer.Render(" to start one, or ") + styleKey.Render("3") +
				styleServer.Render(" to pick a host")
		}
		return head + styleServer.Render("no sessions match")
	}

	// Widest host name so session names line up in a column.
	hostW := 0
	for _, r := range m.visible {
		if w := lipgloss.Width(r.session.HostName); w > hostW {
			hostW = w
		}
	}

	lines := make([]string, len(m.visible))
	for i, r := range m.visible {
		selected := i == m.cursor
		caret := "  "
		if selected {
			caret = styleCursor.Render("▸ ")
		}

		g, label := sessionSignal(r.session)
		host := styleHost.Render(pad(r.session.HostName, hostW))
		sep := styleMeta.Render(" / ")

		name := r.session.Name
		if selected {
			name = styleSelected.Render(name)
		} else {
			name = styleTitle.Render(name)
		}

		win := fmt.Sprintf("%d win", r.session.Windows)
		if r.session.Windows == 1 {
			win = "1 win"
		}
		meta := styleMeta.Render("  " + win)
		// Surface the live signal label for anything that isn't plain idle.
		if label == "working" {
			meta += "  " + lipgloss.NewStyle().Foreground(colSuccess).Render(label)
		} else if label == "needs you" {
			meta += "  " + lipgloss.NewStyle().Foreground(colWarning).Render(label)
		}

		lines[i] = caret + g + " " + host + sep + name + meta
	}

	return head + windowList(lines, m.cursor, rowHeight)
}

package tui

import (
	"github.com/charmbracelet/lipgloss"
)

// modalView renders the active prompt/confirm box centred in the body area.
func (m Model) modalView(width, height int) string {
	var title, bodyLine, hint string

	switch m.modal {
	case modalNewSession:
		host := m.pending.host.Name
		if host == "" {
			host = "host"
		}
		title = styleModalTitle.Render("New session")
		bodyLine = styleHint.Render("on ") + styleTitle.Render(host) + "\n\n" + m.prompt.View()
		hint = styleHint.Render("enter") + styleFooter.Render(" create · ") +
			styleHint.Render("esc") + styleFooter.Render(" cancel")

	case modalRename:
		title = styleModalTitle.Render("Rename session")
		bodyLine = styleHint.Render(m.pending.session.HostName+" / "+m.pending.session.Name) +
			"\n\n" + m.prompt.View()
		hint = styleHint.Render("enter") + styleFooter.Render(" rename · ") +
			styleHint.Render("esc") + styleFooter.Render(" cancel")

	case modalConfirmKill:
		title = lipgloss.NewStyle().Foreground(colDanger).Bold(true).Render("Kill session?")
		bodyLine = styleTitle.Render(m.pending.session.HostName+" / "+m.pending.session.Name) + "\n\n" +
			styleHint.Render("This destroys the tmux session on the host.")
		hint = styleHint.Render("y") + styleFooter.Render(" kill · ") +
			styleHint.Render("n") + styleFooter.Render(" cancel")

	default:
		return ""
	}

	box := styleModal.Render(title + "\n\n" + bodyLine + "\n\n" + hint)
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, box)
}

// modalFooter is the footer hint line while a modal is open.
func (m Model) modalFooter() string {
	switch m.modal {
	case modalConfirmKill:
		return styleFooter.Render("confirm with ") + styleKey.Render("y") +
			styleFooter.Render(" · cancel with ") + styleKey.Render("n")
	default:
		return styleFooter.Render("type a name · ") + styleKey.Render("enter") +
			styleFooter.Render(" confirm · ") + styleKey.Render("esc") + styleFooter.Render(" cancel")
	}
}

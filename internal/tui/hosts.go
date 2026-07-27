package tui

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"

	sigil "sigil.dev/sigil/pkg/sigil"
)

// hostsView lists configured hosts with their connection signal, address, live
// session count, and a compact resource summary drawn from the metrics feed.
func (m Model) hostsView(width, height int) string {
	if len(m.hosts) == 0 {
		return styleServer.Render("no hosts configured on this hub")
	}

	// Sessions per host, for the count column.
	sessCount := map[string]int{}
	for _, r := range m.rows {
		sessCount[r.session.HostName]++
	}

	nameW := 0
	for _, h := range m.hosts {
		if w := lipgloss.Width(h.Name); w > nameW {
			nameW = w
		}
	}

	lines := make([]string, len(m.hosts))
	for i, h := range m.hosts {
		selected := i == m.hostCursor
		caret := "  "
		if selected {
			caret = styleCursor.Render("▸ ")
		}

		g, _ := hostSignal(h)
		name := pad(h.Name, nameW)
		if selected {
			name = styleSelected.Render(name)
		} else {
			name = styleTitle.Render(name)
		}

		addr := h.Hostname
		if h.User != "" {
			addr = h.User + "@" + h.Hostname
		}
		if h.Port != 0 && h.Port != 22 {
			addr += fmt.Sprintf(":%d", h.Port)
		}
		meta := styleHost.Render("  " + pad(addr, 24))

		n := sessCount[h.Name]
		sess := styleMeta.Render(fmt.Sprintf("%d sess", n))

		res := m.hostResSummary(h.Name)

		lines[i] = caret + g + " " + name + meta + "  " + sess + res
	}

	return windowList(lines, m.hostCursor, height)
}

// hostResSummary renders a one-line "load · mem%" tail for a host from its
// latest metrics, or nothing if the host has no sample yet.
func (m Model) hostResSummary(name string) string {
	hm, ok := m.metrics[name]
	if !ok || hm.Info.MemTotal == 0 {
		return ""
	}
	memFrac := float64(hm.Current.MemUsed) / float64(hm.Info.MemTotal)
	load := hm.Current.Load1
	c := healthColor(hm.Health)
	tail := fmt.Sprintf("  load %.1f  mem %d%%", load, int(memFrac*100+0.5))
	return lipgloss.NewStyle().Foreground(c).Render(tail)
}

// hostSessionCount is a small helper used by the sidebar title.
func (m Model) connectedHosts() []sigil.Host {
	out := make([]sigil.Host, 0, len(m.hosts))
	for _, h := range m.hosts {
		switch h.Status {
		case "connected", "online", "active":
			out = append(out, h)
		}
	}
	return out
}

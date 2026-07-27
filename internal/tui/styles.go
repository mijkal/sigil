package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"

	sigil "sigil.dev/sigil/pkg/sigil"
)

// Palette — mirrors the web client's dark theme (web/src/index.css): muted
// slate greys with a single indigo accent. Restraint is the point; colour is
// reserved for signal (activity, health, danger).
var (
	colAccent  = lipgloss.Color("#6366F1") // Sigil Indigo — the one accent
	colAccent2 = lipgloss.Color("#818CF8") // lighter indigo — constellation stars
	colText    = lipgloss.Color("#E2E8F0")
	colMuted   = lipgloss.Color("#64748B")
	colFaint   = lipgloss.Color("#334155")
	colSuccess = lipgloss.Color("#22C55E")
	colWarning = lipgloss.Color("#F59E0B")
	colDanger  = lipgloss.Color("#EF4444")
	colInfo    = lipgloss.Color("#38BDF8") // cyan — connected/attached (not working)
)

var (
	// header wordmark + server label.
	styleMark   = lipgloss.NewStyle().Foreground(colAccent).Bold(true)
	styleServer = lipgloss.NewStyle().Foreground(colMuted)

	// tab bar. Active tab is a single-line underline (a bottom border would make
	// the tab two rows tall and misalign the row).
	styleTab       = lipgloss.NewStyle().Foreground(colMuted).Padding(0, 2)
	styleTabActive = lipgloss.NewStyle().Foreground(colAccent).Bold(true).Underline(true).Padding(0, 2)
	styleRule      = lipgloss.NewStyle().Foreground(colFaint)

	styleTitle    = lipgloss.NewStyle().Foreground(colText)
	styleHost     = lipgloss.NewStyle().Foreground(colMuted)
	styleMeta     = lipgloss.NewStyle().Foreground(colFaint)
	styleDim      = lipgloss.NewStyle().Foreground(colMuted)
	styleStatusOK = lipgloss.NewStyle().Foreground(colSuccess)

	// selected row: indigo caret + brightened text.
	styleCursor   = lipgloss.NewStyle().Foreground(colAccent).Bold(true)
	styleSelected = lipgloss.NewStyle().Foreground(colText).Bold(true)

	// home / branding.
	styleBrand   = lipgloss.NewStyle().Foreground(colAccent).Bold(true)
	styleStar    = lipgloss.NewStyle().Foreground(colAccent2)
	styleStarDim = lipgloss.NewStyle().Foreground(colFaint)
	styleTagline = lipgloss.NewStyle().Foreground(colMuted)
	styleStatVal = lipgloss.NewStyle().Foreground(colText)

	// sidebar.
	styleSidebar   = lipgloss.NewStyle().BorderStyle(lipgloss.NormalBorder()).BorderLeft(true).BorderForeground(colFaint).PaddingLeft(2)
	styleSideTitle = lipgloss.NewStyle().Foreground(colMuted).Bold(true)
	styleMeterKey  = lipgloss.NewStyle().Foreground(colMuted)

	styleFooter = lipgloss.NewStyle().Foreground(colFaint)
	styleKey    = lipgloss.NewStyle().Foreground(colMuted)
	styleFlash  = lipgloss.NewStyle().Foreground(colSuccess)

	styleErrTitle = lipgloss.NewStyle().Foreground(colDanger).Bold(true)
	styleErrBody  = lipgloss.NewStyle().Foreground(colText)
	styleHint     = lipgloss.NewStyle().Foreground(colMuted)

	// modal box.
	styleModal      = lipgloss.NewStyle().BorderStyle(lipgloss.RoundedBorder()).BorderForeground(colAccent).Padding(1, 3)
	styleModalTitle = lipgloss.NewStyle().Foreground(colText).Bold(true)
)

// glyph renders a single coloured signal glyph.
func glyph(c lipgloss.Color, r string) string {
	return lipgloss.NewStyle().Foreground(c).Render(r)
}

// sessionSignal maps a session's live activity + status onto a coloured glyph
// and a short label — the visual cue for idle / connected / working / needs-you.
func sessionSignal(s sigil.Session) (string, string) {
	switch s.Activity {
	case "working":
		return glyph(colSuccess, "●"), "working"
	case "attention":
		return glyph(colWarning, "◆"), "needs you"
	}
	switch s.Status {
	case "active", "attached", "connected":
		return glyph(colInfo, "●"), "connected"
	case "error":
		return glyph(colDanger, "●"), "error"
	case "detached", "disconnected", "":
		return glyph(colMuted, "○"), "idle"
	default:
		return glyph(colMuted, "○"), s.Status
	}
}

// hostSignal maps a host's connection status onto a coloured glyph and label.
func hostSignal(h sigil.Host) (string, string) {
	switch h.Status {
	case "connected", "online", "active":
		return glyph(colSuccess, "●"), "connected"
	case "connecting":
		return glyph(colWarning, "◐"), "connecting"
	case "error":
		return glyph(colDanger, "●"), "error"
	default: // disconnected / unknown
		return glyph(colMuted, "○"), "offline"
	}
}

// healthColor maps a HostMetrics.Health level onto a colour.
func healthColor(health string) lipgloss.Color {
	switch health {
	case sigil.HealthHealthy:
		return colSuccess
	case sigil.HealthWarn:
		return colWarning
	case sigil.HealthErr:
		return colDanger
	default:
		return colMuted
	}
}

// meterColor grades a 0..1 utilisation fraction green→amber→red.
func meterColor(frac float64) lipgloss.Color {
	switch {
	case frac >= 0.9:
		return colDanger
	case frac >= 0.7:
		return colWarning
	default:
		return colSuccess
	}
}

// meter renders a compact [████░░░░] utilisation bar of the given cell width.
func meter(frac float64, width int) string {
	if frac < 0 {
		frac = 0
	}
	if frac > 1 {
		frac = 1
	}
	fill := int(frac*float64(width) + 0.5)
	if fill > width {
		fill = width
	}
	filled := lipgloss.NewStyle().Foreground(meterColor(frac)).Render(strings.Repeat("█", fill))
	empty := lipgloss.NewStyle().Foreground(colFaint).Render(strings.Repeat("░", width-fill))
	return filled + empty
}

// pad right-pads s to width w (display-width aware).
func pad(s string, w int) string {
	if gap := w - lipgloss.Width(s); gap > 0 {
		return s + strings.Repeat(" ", gap)
	}
	return s
}

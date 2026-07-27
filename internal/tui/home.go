package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"

	sigil "sigil.dev/sigil/pkg/sigil"
)

// brandMark is a small fixed constellation-seal over the SIGIL wordmark — the
// terminal echo of the web app's generative per-session sigil. Restrained on
// purpose: rune/star-chart, not summoning-circle.
func brandMark() string {
	star := styleStar.Render("✦")
	dim := styleStarDim.Render("·")
	hex := styleBrand.Render("⬡")
	lines := []string{
		"    " + dim + "   " + star + "   " + dim,
		"  " + star + "     " + hex + "     " + star,
		"    " + dim + "   " + star + "   " + dim,
		"",
		styleBrand.Render("S  I  G  I  L"),
	}
	return strings.Join(lines, "\n")
}

// homeView is the branded landing screen: mark, tagline, live fleet summary,
// and about/build info. Centred within the available body area.
func (m Model) homeView(width, height int) string {
	f := m.summary()

	stat := func(icon, label, val string, c lipgloss.Color) string {
		return styleStar.Render(icon) + "  " +
			styleStatVal.Foreground(c).Render(val) + " " + styleTagline.Render(label)
	}

	hostsVal := itoa(f.hostsConnected) + "/" + itoa(f.hostsTotal)
	sessLine := itoa(f.sessions) + " session" + plural(f.sessions)
	sub := []string{}
	if f.working > 0 {
		sub = append(sub, glyph(colSuccess, "●")+" "+itoa(f.working)+" working")
	}
	if f.attention > 0 {
		sub = append(sub, glyph(colWarning, "◆")+" "+itoa(f.attention)+" need you")
	}
	sessSub := ""
	if len(sub) > 0 {
		sessSub = "   " + styleTagline.Render("·") + " " + strings.Join(sub, styleTagline.Render(" · "))
	}

	block := []string{
		brandMark(),
		"",
		styleTagline.Render("a terminal session hub across your fleet"),
		"",
		stat("◈", "hosts connected", hostsVal, colInfo),
		stat("◈", "", sessLine, colText) + sessSub,
		"",
		m.aboutLine(),
		"",
		styleHint.Render("tab") + styleTagline.Render(" to switch views · ") +
			styleHint.Render("enter") + styleTagline.Render(" for sessions · ") +
			styleHint.Render("s") + styleTagline.Render(" for the resource sidebar"),
	}
	content := lipgloss.JoinVertical(lipgloss.Center, block...)

	// Centre the whole block in the body area.
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, content)
}

// aboutLine renders the muted build/identity strip under the summary.
func (m Model) aboutLine() string {
	parts := []string{"sigil " + sigil.Version}
	if sigil.GitCommit != "" && sigil.GitCommit != "dev" {
		parts = append(parts, sigil.GitCommit)
	}
	parts = append(parts, m.server)
	return styleHint.Render(strings.Join(parts, styleTagline.Render(" · ")))
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

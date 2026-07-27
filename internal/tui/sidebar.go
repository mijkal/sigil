package tui

import (
	"fmt"
	"strings"

	sigil "sigil.dev/sigil/pkg/sigil"
)

// blockLines is the vertical cost of one host block (head + 3 meters + spacer).
const blockLines = 5

// sidebarView renders the resource monitor: one compact block per connected
// host with cpu / mem / disk meters, coloured by health. width is the inner
// content width and height the vertical budget; hosts beyond what fits collapse
// into a "+N more" line so the sidebar never overflows and scrolls the header.
func (m Model) sidebarView(width, height int) string {
	var b strings.Builder
	b.WriteString(styleSideTitle.Render("RESOURCES"))
	b.WriteString("\n\n")

	hosts := m.connectedHosts()
	if len(hosts) == 0 {
		b.WriteString(styleHint.Render("no hosts connected"))
		return b.String()
	}

	meterW := width - 12
	if meterW < 6 {
		meterW = 6
	}
	if meterW > 12 {
		meterW = 12
	}

	// Only hosts with a metrics sample can be drawn.
	withMetrics := make([]sigil.Host, 0, len(hosts))
	for _, h := range hosts {
		if _, ok := m.metrics[h.Name]; ok {
			withMetrics = append(withMetrics, h)
		}
	}
	if len(withMetrics) == 0 {
		b.WriteString(styleHint.Render("metrics not available\n(hub metrics disabled)"))
		return b.String()
	}

	// Budget: 2 lines already used by the title/blank above.
	budget := height - 2
	maxBlocks := budget / blockLines
	if maxBlocks < 1 {
		maxBlocks = 1
	}
	hidden := 0
	if len(withMetrics) > maxBlocks {
		hidden = len(withMetrics) - maxBlocks
		withMetrics = withMetrics[:maxBlocks]
	}

	for i, h := range withMetrics {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString(hostMetricsBlock(h.Name, m.metrics[h.Name], meterW))
	}
	if hidden > 0 {
		b.WriteString("\n" + styleHint.Render(" +"+itoa(hidden)+" more hosts"))
	}
	return b.String()
}

// hostMetricsBlock renders one host's name + health dot and cpu/mem/disk meters.
func hostMetricsBlock(name string, hm sigil.HostMetrics, meterW int) string {
	hc := healthColor(hm.Health)
	head := glyph(hc, "●") + " " + styleTitle.Render(name)
	if hm.Stale {
		head += " " + styleHint.Render("(stale)")
	}

	// cpu: load1 normalised by core count → utilisation fraction.
	cores := hm.Info.Cores
	if cores < 1 {
		cores = 1
	}
	cpuFrac := hm.Current.Load1 / float64(cores)

	var memFrac, diskFrac float64
	if hm.Info.MemTotal > 0 {
		memFrac = float64(hm.Current.MemUsed) / float64(hm.Info.MemTotal)
	} else if hm.Current.MemTotal > 0 {
		memFrac = float64(hm.Current.MemUsed) / float64(hm.Current.MemTotal)
	}
	if hm.Current.DiskTotal > 0 {
		diskFrac = float64(hm.Current.DiskUsed) / float64(hm.Current.DiskTotal)
	}

	line := func(label, bar, val string) string {
		return " " + styleMeterKey.Render(label) + " " + bar + " " + styleMeta.Render(val)
	}

	rows := []string{
		head,
		line("cpu", meter(cpuFrac, meterW), fmt.Sprintf("%.1f", hm.Current.Load1)),
		line("mem", meter(memFrac, meterW), pct(memFrac)),
		line("dsk", meter(diskFrac, meterW), pct(diskFrac)),
	}
	return strings.Join(rows, "\n") + "\n"
}

func pct(frac float64) string {
	if frac < 0 {
		frac = 0
	}
	return fmt.Sprintf("%d%%", int(frac*100+0.5))
}

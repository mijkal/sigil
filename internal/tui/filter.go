package tui

import (
	"sort"
	"strings"
)

// fuzzyMatch reports whether query is a case-insensitive subsequence of text
// and, if so, a score where higher is better. Matches on consecutive runs and
// at word boundaries ('/', ' ', '-', '_' — the separators in "host / session"
// labels) score higher, so "web" ranks the hub host/web above a scattered match.
func fuzzyMatch(text, query string) (int, bool) {
	if query == "" {
		return 0, true
	}
	t := strings.ToLower(text)
	q := strings.ToLower(query)

	score := 0
	ti := 0
	prev := -2
	for qi := 0; qi < len(q); qi++ {
		c := q[qi]
		found := -1
		for ; ti < len(t); ti++ {
			if t[ti] == c {
				found = ti
				ti++
				break
			}
		}
		if found < 0 {
			return 0, false
		}
		if found == prev+1 {
			score += 5 // consecutive with the previous match
		} else {
			score++
		}
		if found == 0 || isBoundary(t[found-1]) {
			score += 3 // start of a word
		}
		prev = found
	}
	return score, true
}

func isBoundary(b byte) bool {
	switch b {
	case '/', ' ', '-', '_', ':':
		return true
	}
	return false
}

// fuzzyFilter returns the subset of items that fuzzy-match query, best score
// first. Ties keep the original relative order (stable), so an empty query
// returns items unchanged.
func fuzzyFilter(items []string, query string) []string {
	if query == "" {
		out := make([]string, len(items))
		copy(out, items)
		return out
	}

	type scored struct {
		item  string
		score int
		idx   int
	}
	var matches []scored
	for i, it := range items {
		if s, ok := fuzzyMatch(it, query); ok {
			matches = append(matches, scored{item: it, score: s, idx: i})
		}
	}
	sort.SliceStable(matches, func(a, b int) bool {
		if matches[a].score != matches[b].score {
			return matches[a].score > matches[b].score
		}
		return matches[a].idx < matches[b].idx
	})

	out := make([]string, len(matches))
	for i, m := range matches {
		out[i] = m.item
	}
	return out
}

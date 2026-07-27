package scrollback

import (
	"regexp"
)

// ansiEscapeRe matches ANSI escape sequences
var ansiEscapeRe = regexp.MustCompile(`\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`)

// controlRe matches other control characters except newline/tab/carriage return
var controlRe = regexp.MustCompile(`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`)

// StripANSI removes ANSI escape sequences and control characters, returning plain text
func StripANSI(data []byte) string {
	s := ansiEscapeRe.ReplaceAll(data, nil)
	s = controlRe.ReplaceAll(s, nil)
	return string(s)
}

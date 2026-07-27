#!/usr/bin/env bash
# Fails if a raw hex color appears in a themeable component. Allowlist: files
# that legitimately hold fixed colours (brand glyphs, the terminal palette).
set -u
ALLOW='OsIcon.tsx|SigilLogo.tsx|TerminalTile.tsx|UnifiedTerminalTile.tsx|ScrollbackPanel.tsx|AboutMenu.tsx'
hits=$(grep -rniE '#[0-9a-f]{6}\b|#[0-9a-f]{3}\b' src/components src/ui 2>/dev/null \
  | grep -viE "$ALLOW" | grep -viE '#fff\b|#ffffff\b')
if [ -n "$hits" ]; then
  echo "✗ raw hex colours in themeable components (use var(--color-*) tokens):"
  echo "$hits"
  exit 1
fi
echo "✓ no raw hex in themeable components"

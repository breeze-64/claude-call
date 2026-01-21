#!/bin/bash
#
# Claude-Call Uninstallation Script
#
# Usage: curl -fsSL https://raw.githubusercontent.com/breeze-64/claude-call/main/uninstall.sh | bash
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Installation paths
INSTALL_DIR="$HOME/.claude-call"
BIN_DIR="$HOME/.local/bin"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

# Print colored messages
print_success() {
  echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
  echo -e "${YELLOW}⚠${NC} $1"
}

print_info() {
  echo -e "${CYAN}ℹ${NC} $1"
}

# Header
echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}       ${RED}Claude-Call Uninstallation Script${NC}           ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════╝${NC}"
echo ""

# Confirm uninstallation
echo -n "Are you sure you want to uninstall Claude-Call? [y/N] "
read -r REPLY
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Uninstallation cancelled."
  exit 0
fi

echo ""

# Remove installation directory
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  print_success "Removed $INSTALL_DIR"
else
  print_info "Installation directory not found"
fi

# Remove global commands
if [ -f "$BIN_DIR/claude-call-server" ]; then
  rm -f "$BIN_DIR/claude-call-server"
  print_success "Removed claude-call-server command"
fi

if [ -f "$BIN_DIR/claude-call" ]; then
  rm -f "$BIN_DIR/claude-call"
  print_success "Removed claude-call command"
fi

# Remind about hooks
echo ""
print_warning "Claude Code hooks were NOT automatically removed."
echo ""
echo "To manually remove hooks, edit $CLAUDE_SETTINGS and remove the"
echo "PreToolUse hooks that reference 'telegram-auth.ts'."
echo ""
echo "Example hooks to remove:"
echo '  "PreToolUse": ['
echo '    {'
echo '      "matcher": "Bash|Edit|Write|...",'
echo '      "hooks": [{"type": "command", "command": "... telegram-auth.ts"}]'
echo '    }'
echo '  ]'
echo ""

print_success "Claude-Call has been uninstalled"
echo ""
echo "If you want to reinstall, run:"
echo "  curl -fsSL https://raw.githubusercontent.com/breeze-64/claude-call/main/install.sh | bash"
echo ""

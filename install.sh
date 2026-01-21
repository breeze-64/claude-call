#!/bin/bash
#
# Claude-Call Installation Script
# One-click install for Telegram-based Claude Code authorization
#
# Usage: curl -fsSL https://raw.githubusercontent.com/breeze-64/claude-call/main/install.sh | bash
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Installation directory
INSTALL_DIR="$HOME/.claude-call"
REPO_URL="https://github.com/breeze-64/claude-call.git"

# Print colored messages
print_step() {
  echo -e "${BLUE}[$1/7]${NC} $2"
}

print_success() {
  echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
  echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
  echo -e "${RED}✗${NC} $1"
}

print_info() {
  echo -e "${CYAN}ℹ${NC} $1"
}

# Check if command exists
command_exists() {
  command -v "$1" &> /dev/null
}

# Detect OS
detect_os() {
  case "$(uname -s)" in
    Darwin*) echo "macos" ;;
    Linux*)  echo "linux" ;;
    *)       echo "unknown" ;;
  esac
}

# Header
echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}       ${GREEN}Claude-Call Installation Script${NC}             ${CYAN}║${NC}"
echo -e "${CYAN}╠═══════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}  Telegram integration for Claude Code            ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  Remote authorization & task injection           ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════╝${NC}"
echo ""

# Step 1: Check system environment
print_step 1 "Checking system environment..."

OS=$(detect_os)
if [ "$OS" = "unknown" ]; then
  print_error "Unsupported operating system. Only macOS and Linux are supported."
  exit 1
fi
print_success "Detected OS: $OS"

# Step 2: Check/Install Bun
print_step 2 "Checking Bun installation..."

if command_exists bun; then
  BUN_VERSION=$(bun --version)
  print_success "Bun is installed (v$BUN_VERSION)"
else
  print_warning "Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash

  # Source the updated shell config
  if [ -f "$HOME/.bashrc" ]; then
    source "$HOME/.bashrc" 2>/dev/null || true
  fi
  if [ -f "$HOME/.zshrc" ]; then
    source "$HOME/.zshrc" 2>/dev/null || true
  fi

  # Add to PATH for current session
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if command_exists bun; then
    print_success "Bun installed successfully"
  else
    print_error "Failed to install Bun. Please install manually: https://bun.sh"
    exit 1
  fi
fi

# Step 3: Check/Install tmux
print_step 3 "Checking tmux installation..."

if command_exists tmux; then
  TMUX_VERSION=$(tmux -V | cut -d' ' -f2)
  print_success "tmux is installed (v$TMUX_VERSION)"
else
  print_warning "tmux not found. Installing..."

  if [ "$OS" = "macos" ]; then
    if command_exists brew; then
      brew install tmux
    else
      print_error "Homebrew not found. Please install tmux manually: brew install tmux"
      exit 1
    fi
  else
    if command_exists apt-get; then
      sudo apt-get update && sudo apt-get install -y tmux
    elif command_exists yum; then
      sudo yum install -y tmux
    elif command_exists pacman; then
      sudo pacman -S --noconfirm tmux
    else
      print_error "Could not install tmux. Please install manually."
      exit 1
    fi
  fi

  if command_exists tmux; then
    print_success "tmux installed successfully"
  else
    print_error "Failed to install tmux"
    exit 1
  fi
fi

# Step 4: Download project
print_step 4 "Downloading Claude-Call..."

if [ -d "$INSTALL_DIR" ]; then
  print_warning "Existing installation found at $INSTALL_DIR"
  echo -n "Do you want to update it? [y/N] "
  read -r REPLY
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    cd "$INSTALL_DIR"
    git pull origin main
    print_success "Updated existing installation"
  else
    print_info "Keeping existing installation"
  fi
else
  git clone "$REPO_URL" "$INSTALL_DIR"
  print_success "Downloaded to $INSTALL_DIR"
fi

cd "$INSTALL_DIR"
bun install
print_success "Dependencies installed"

# Step 5: Configure Telegram
print_step 5 "Configuring Telegram Bot..."

ENV_FILE="$INSTALL_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  print_info "Existing .env file found"
  echo -n "Do you want to reconfigure Telegram? [y/N] "
  read -r REPLY
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_info "Keeping existing configuration"
  else
    rm "$ENV_FILE"
  fi
fi

if [ ! -f "$ENV_FILE" ]; then
  echo ""
  echo -e "${CYAN}=== Telegram Bot Setup ===${NC}"
  echo ""
  echo "To use Claude-Call, you need a Telegram Bot and Chat ID."
  echo ""
  echo -e "${YELLOW}Step 1: Create a Telegram Bot${NC}"
  echo "  1. Open Telegram and search for @BotFather"
  echo "  2. Send /newbot and follow the instructions"
  echo "  3. Copy the bot token (looks like: 123456789:ABC...)"
  echo ""
  echo -n "Enter your Telegram Bot Token: "
  read -r BOT_TOKEN

  if [ -z "$BOT_TOKEN" ]; then
    print_error "Bot token is required"
    exit 1
  fi

  echo ""
  echo -e "${YELLOW}Step 2: Get your Chat ID${NC}"
  echo "  1. Start a chat with your bot in Telegram"
  echo "  2. Send any message to your bot"
  echo ""
  echo -n "Press Enter after you've sent a message to your bot..."
  read -r

  # Try to get chat ID automatically
  print_info "Fetching your Chat ID..."
  CHAT_RESPONSE=$(curl -s "https://api.telegram.org/bot$BOT_TOKEN/getUpdates" 2>/dev/null || echo "")

  CHAT_ID=""
  if echo "$CHAT_RESPONSE" | grep -q '"chat":'; then
    # Extract chat ID using basic tools
    CHAT_ID=$(echo "$CHAT_RESPONSE" | grep -o '"chat":{"id":[0-9-]*' | head -1 | grep -o '[0-9-]*$')
  fi

  if [ -n "$CHAT_ID" ]; then
    print_success "Found Chat ID: $CHAT_ID"
    echo -n "Is this correct? [Y/n] "
    read -r REPLY
    if [[ $REPLY =~ ^[Nn]$ ]]; then
      CHAT_ID=""
    fi
  fi

  if [ -z "$CHAT_ID" ]; then
    echo ""
    echo "Could not auto-detect Chat ID."
    echo "You can find it manually by:"
    echo "  1. Opening https://api.telegram.org/bot$BOT_TOKEN/getUpdates"
    echo "  2. Looking for \"chat\":{\"id\":YOUR_ID,...}"
    echo ""
    echo -n "Enter your Chat ID: "
    read -r CHAT_ID
  fi

  if [ -z "$CHAT_ID" ]; then
    print_error "Chat ID is required"
    exit 1
  fi

  # Create .env file
  cat > "$ENV_FILE" << EOF
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
TELEGRAM_CHAT_ID=$CHAT_ID
AUTH_SERVER_PORT=3847
AUTH_TIMEOUT_MS=30000
CLAUDE_CALL_BASE_DIR=$HOME/code

# Logging Configuration
LOG_LEVEL=INFO
LOG_DIR=./logs
LOG_MAX_SIZE=10MB
LOG_MAX_FILES=5
EOF

  print_success "Configuration saved to $ENV_FILE"
fi

# Step 6: Configure Claude Code hooks
print_step 6 "Configuring Claude Code hooks..."

CLAUDE_DIR="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

# Create .claude directory if it doesn't exist
mkdir -p "$CLAUDE_DIR"

# Run the merge-hooks script
if [ -f "$INSTALL_DIR/scripts/merge-hooks.ts" ]; then
  cd "$INSTALL_DIR"
  bun run scripts/merge-hooks.ts
  print_success "Claude Code hooks configured"
else
  # Fallback: Create/update settings.json manually
  HOOK_CONFIG='{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit|AskUserQuestion",
        "hooks": [
          {
            "type": "command",
            "command": "bun run '"$INSTALL_DIR"'/hooks/scripts/telegram-auth.ts"
          }
        ]
      }
    ]
  }
}'

  if [ -f "$SETTINGS_FILE" ]; then
    print_warning "Existing settings.json found"
    print_info "Please manually add the following hook configuration:"
    echo ""
    echo "$HOOK_CONFIG"
    echo ""
    print_info "Or run: bun run $INSTALL_DIR/scripts/merge-hooks.ts"
  else
    echo "$HOOK_CONFIG" > "$SETTINGS_FILE"
    print_success "Created $SETTINGS_FILE with hook configuration"
  fi
fi

# Step 7: Install global commands
print_step 7 "Installing global commands..."

# Create bin directory
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

# Create claude-call-server command
cat > "$BIN_DIR/claude-call-server" << EOF
#!/bin/bash
cd "$INSTALL_DIR"
exec bun run start
EOF
chmod +x "$BIN_DIR/claude-call-server"

# Create claude-call command
cat > "$BIN_DIR/claude-call" << EOF
#!/bin/bash
cd "$INSTALL_DIR"
exec bun run wrapper/pty-wrapper.ts "\$@"
EOF
chmod +x "$BIN_DIR/claude-call"

print_success "Commands installed to $BIN_DIR"

# Check if BIN_DIR is in PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  print_warning "$BIN_DIR is not in your PATH"
  echo ""
  echo "Add this line to your shell config (~/.bashrc or ~/.zshrc):"
  echo ""
  echo -e "  ${CYAN}export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
  echo ""
fi

# Verification
echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Installation Complete!${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo ""

# Send test message
print_info "Sending test message to Telegram..."
cd "$INSTALL_DIR"
if timeout 10 bun run -e "
import { sendTestMessage } from './server/telegram';
const ok = await sendTestMessage();
process.exit(ok ? 0 : 1);
" 2>/dev/null; then
  print_success "Test message sent successfully!"
else
  print_warning "Could not send test message. Please check your configuration."
fi

echo ""
echo "Usage:"
echo ""
echo -e "  ${CYAN}# Terminal 1: Start the server${NC}"
echo "  claude-call-server"
echo ""
echo -e "  ${CYAN}# Terminal 2: Run Claude Code with Telegram integration${NC}"
echo "  claude-call"
echo ""
echo "For more information, visit:"
echo "  https://github.com/breeze-64/claude-call"
echo ""

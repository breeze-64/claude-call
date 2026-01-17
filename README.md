# Claude-Call

Authorize Claude Code tool usage via Telegram buttons.

English | [中文](./README.zh-CN.md)

## Features

- **Telegram Integration**: Receive authorization requests as Telegram messages with inline buttons
- **Quick Actions**: Allow, Deny, or Allow All for the session
- **Real-time**: Instant response when you click a button
- **Timeout**: Auto-deny after 30 seconds if no response
- **Fallback**: Falls back to terminal prompt if server is unavailable

## Setup

### 1. Install Dependencies

```bash
cd /Users/h/Documents/code/claude-call
bun install
```

### 2. Configure Environment

The `.env` file is already configured with your Telegram bot token and chat ID.

### 3. Start the Server

```bash
bun run start
```

Or use the start script:

```bash
./scripts/start.sh
```

### 4. Enable the Plugin

Add the plugin to your Claude Code configuration:

```bash
# In Claude Code, run:
/plugin install /Users/h/Documents/code/claude-call
```

Or manually add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "bun run /Users/h/Documents/code/claude-call/hooks/scripts/telegram-auth.ts",
            "timeout": 35000
          }
        ]
      }
    ]
  }
}
```

## Usage

1. Start the server: `bun run start`
2. Use Claude Code normally
3. When Claude tries to use a tool (Bash, Write, Edit, etc.), you'll receive a Telegram message
4. Click a button to authorize:
   - ✅ **Allow**: Allow this specific operation
   - ❌ **Deny**: Block this operation
   - 🔓 **Allow All Session**: Allow all future operations in this session

## Architecture

```
Claude Code → PreToolUse Hook → Authorization Server → Telegram Bot
                                       ↑
                              User clicks button
                                       ↓
                              Telegram Polling → Server → Hook returns decision
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/authorize` | POST | Submit a new authorization request |
| `/poll/:id` | GET | Poll for authorization decision |
| `/health` | GET | Health check |
| `/status` | GET | View pending requests (debug) |

## Configuration

Environment variables in `.env`:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |
| `AUTH_SERVER_PORT` | Server port (default: 3847) |
| `AUTH_TIMEOUT_MS` | Request timeout in ms (default: 30000) |

## Troubleshooting

### Server not starting

- Check if port 3847 is available
- Verify Telegram bot token is correct
- Ensure bun is installed

### Not receiving Telegram messages

- Verify your chat ID is correct
- Make sure you've messaged the bot at least once
- Check server logs for Telegram API errors

### Hook not triggering

- Verify the plugin is installed correctly
- Check Claude Code's hook configuration
- Ensure bun is in your PATH

# Claude-Call

> **Remote control Claude Code via Telegram** - Authorize tool execution, answer questions, and inject tasks from your phone. **10x productivity boost** for AI-assisted coding.
>
> **通过 Telegram 远程控制 Claude Code** - 手机授权、回答问题、注入任务。**编程效率提升10倍**。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue)](https://www.typescriptlang.org/)
[![Claude Code](https://img.shields.io/badge/integrates%20with-Claude%20Code-purple)](https://claude.ai/code)

Full Telegram integration for [Claude Code](https://claude.ai/code) (Anthropic's official CLI for Claude). Authorize tools, answer questions, and send new tasks, all from your phone.

## Why Claude-Call? | 为什么选择 Claude-Call?

- **Stay Mobile, Stay Productive** | **移动办公，效率不减** - Approve Claude's actions from anywhere - meetings, commute, or coffee breaks
- **No More Waiting** | **告别等待** - Claude keeps working while you handle approvals on the go
- **Multi-task Like a Pro** | **多任务处理** - Run multiple Claude sessions, control them all from one chat
- **Zero Context Switch** | **零切换成本** - No need to return to your computer for simple yes/no decisions

**Keywords | 关键词**: Claude Code, Telegram Bot, Tool Authorization, Remote Control, AI Assistant, Anthropic, CLI Integration, AI Coding, Productivity, Efficiency, 效率工具, 远程控制, AI编程, 自动化, 提效神器

English | [中文](./README.zh-CN.md)

## Features

### Tool Authorization
- **Telegram Buttons**: Receive authorization requests as interactive messages
- **Quick Actions**: Allow, Deny, or Allow All for the entire session
- **Real-time Response**: Instant feedback when you click a button
- **Timeout Protection**: Auto-deny after 30 seconds if no response
- **Graceful Fallback**: Falls back to terminal prompt if server unavailable

### Interactive Questions
- **Multi-Option Questions**: Answer Claude's questions via Telegram buttons
- **Custom Input**: Reply to question messages with free-form text
- **Rich Formatting**: See question context and option descriptions

### Remote Task Injection
- **Send Tasks from Telegram**: Start new Claude tasks by sending messages
- **PTY Wrapper**: Uses tmux for reliable terminal integration
- **Queue System**: Tasks are queued and processed in order

### Multi-Session Management
- **Session Registry**: Each `bun run claude` instance registers as a unique session
- **Session Selection**: Choose target session when multiple are active
- **Direct Targeting**: Use `@shortId` prefix to send to specific session
- **Session Commands**: `/sessions` to list all active sessions

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                    Claude-Call System                          │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────┐     ┌─────────────────┐     ┌────────────┐  │
│  │   Telegram   │────▶│  Auth Server    │────▶│   Claude   │  │
│  │   Messages   │     │  (Bun HTTP)     │     │    Code    │  │
│  └──────────────┘     └─────────────────┘     └────────────┘  │
│         │                     │                      │         │
│         │                     │                      │         │
│         ▼                     ▼                      ▼         │
│  ┌──────────────┐     ┌─────────────────┐     ┌────────────┐  │
│  │  Button      │     │  Session        │     │  PTY       │  │
│  │  Callbacks   │     │  Registry &     │     │  Wrapper   │  │
│  └──────────────┘     │  Task Queues    │     │  (tmux)    │  │
│         │             └─────────────────┘     └────────────┘  │
│         └─────────────────────┴───────────────────────┘       │
│                              │                                 │
│                    Telegram Long Polling                       │
└────────────────────────────────────────────────────────────────┘
```

### Message Flow

| Telegram Message Type | Handler | Purpose |
|----------------------|---------|---------|
| Button callback (`callback_query`) | `processCallback()` | Tool authorization decisions |
| Reply to bot message | `processReplyMessage()` | Custom text input for questions |
| `/sessions` command | `processSessionsCommand()` | List all active sessions |
| Plain text message | `processNewTaskMessage()` | New task for PTY injection |
| `@shortId message` | `processNewTaskMessage()` | Task to specific session |

### Data Flow

```
Tool Authorization:
Claude Code → PreToolUse Hook → POST /authorize → Telegram Message
                                                        ↓
                              Hook polls /poll/:id ← User clicks button

Task Injection:
Telegram Message → Server Task Queue → PTY Wrapper polls /tasks/pending
                                                        ↓
                                      tmux send-keys → Claude Code
```

## Installation

### Prerequisites

- [Bun](https://bun.sh) runtime
- [tmux](https://github.com/tmux/tmux) (for PTY wrapper)
- Telegram Bot Token

### 1. Clone and Install

```bash
git clone https://github.com/breeze-64/claude-call.git
cd claude-call
bun install
```

### 2. Install tmux (for task injection)

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt install tmux
```

### 3. Configure Environment

Create `.env` file:

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
AUTH_SERVER_PORT=3847
AUTH_TIMEOUT_MS=30000
```

**Getting Telegram Bot Token:**
1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the token provided

**Getting Chat ID:**
1. Send any message to your bot
2. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Find `chat.id` in the response JSON

### 4. Configure Claude Code Hook

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "bun run /path/to/claude-call/hooks/scripts/telegram-auth.ts",
            "timeout": 35000
          }
        ]
      }
    ]
  }
}
```

## Usage

### Basic: Tool Authorization Only

```bash
# Terminal 1: Start the server
bun run start

# Terminal 2: Use Claude Code normally
claude
```

When Claude tries to use tools, you'll receive Telegram messages with buttons:
- ✅ **Allow**: Approve this operation
- ❌ **Deny**: Block this operation
- 🔓 **Allow All Session**: Approve all future operations

### Advanced: With Task Injection

```bash
# Terminal 1: Start the server
bun run start

# Terminal 2: Start Claude with PTY wrapper
bun run claude
```

Now you can:
1. **Authorize tools** via Telegram buttons
2. **Answer questions** by clicking options or replying with text
3. **Send new tasks** by sending plain messages to the bot

### Multi-Session Usage

Run multiple Claude instances in different terminals:

```bash
# Terminal A
bun run claude  # Registers as session e.g. "claude-abc123" (shortId: abc12345)

# Terminal B
bun run claude  # Registers as session e.g. "claude-def456" (shortId: def45678)
```

From Telegram:
- **List sessions**: Send `/sessions` to see all active sessions
- **Direct target**: Send `@abc12345 your task here` to target specific session
- **Auto-select**: When multiple sessions exist, bot shows selection buttons

### tmux Controls

Since the PTY wrapper uses tmux:
- **Scroll up**: `Ctrl+b` then `[`, use arrow keys, `q` to exit
- **Detach**: `Ctrl+b` then `d`
- **Reattach**: `tmux attach -t <session-name>`

## API Reference

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /authorize` | Submit authorization or question request |
| `GET /poll/:id` | Poll for request decision |
| `GET /sessions` | List all active sessions |
| `POST /sessions/register` | Register a new PTY session |
| `POST /sessions/:id/unregister` | Unregister a PTY session |
| `GET /tasks/pending/:sessionId` | Get pending tasks for a session |
| `POST /tasks/:id/ack` | Acknowledge task as processed |
| `GET /tasks/stats` | Task queue statistics |
| `GET /health` | Health check |
| `GET /status` | Debug: view pending requests |

### Authorization Request

```typescript
POST /authorize
{
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd?: string;
  // For questions:
  type?: "question";
  question?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}
```

### Poll Response

```typescript
GET /poll/:requestId
{
  status: "pending" | "resolved" | "timeout" | "not_found";
  decision?: "allow" | "deny";
  selectedOption?: string;  // For questions
  elapsed?: number;
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | - | Telegram Bot API token (required) |
| `TELEGRAM_CHAT_ID` | - | Your Telegram chat ID (required) |
| `AUTH_SERVER_PORT` | 3847 | HTTP server port |
| `AUTH_TIMEOUT_MS` | 30000 | Authorization timeout in ms |
| `CLAUDE_CALL_SERVER_URL` | `http://localhost:3847` | Server URL for PTY wrapper |

### File Structure

```
claude-call/
├── server/
│   ├── index.ts        # HTTP server & API routes
│   ├── telegram.ts     # Telegram bot integration
│   ├── store.ts        # Request state management
│   ├── task-queue.ts   # Task queue for PTY injection
│   └── types.ts        # TypeScript interfaces
├── wrapper/
│   └── pty-wrapper.ts  # tmux-based PTY wrapper
├── hooks/
│   └── scripts/
│       └── telegram-auth.ts  # PreToolUse hook script
└── package.json
```

## Troubleshooting

### Server Issues

**Port already in use:**
```bash
lsof -i :3847
kill -9 <PID>
```

**Telegram connection failed:**
- Verify bot token is correct
- Ensure you've messaged the bot at least once
- Check server logs for API errors

### PTY Wrapper Issues

**tmux not found:**
```bash
brew install tmux  # macOS
sudo apt install tmux  # Linux
```

**Task not executing:**
- Ensure server is running (`bun run start`)
- Check that PTY wrapper shows "Server connection verified"
- Verify the message appears in the Claude input line

### Hook Issues

**Hook not triggering:**
- Verify path in `~/.claude/settings.json` is correct
- Ensure bun is in your PATH
- Check Claude Code logs for hook errors

**Authorization timeout:**
- Increase `AUTH_TIMEOUT_MS` in `.env`
- Increase `timeout` in hook configuration

## Development

```bash
# Development mode with hot reload
bun run dev

# Run PTY wrapper
bun run claude
```

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **Terminal**: tmux (PTY management)
- **Communication**: Telegram Bot API (Long Polling)
- **Integration**: Claude Code PreToolUse Hook

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

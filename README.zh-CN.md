# Claude-Call

Claude Code 的完整 Telegram 集成 - 授权工具、回答问题、发送新任务，全部通过手机完成。

[English](./README.md) | 中文

## 功能特点

### 工具授权
- **Telegram 按钮**：收到带有交互按钮的授权请求消息
- **快捷操作**：允许、拒绝或允许本会话所有操作
- **实时响应**：点击按钮即时生效
- **超时保护**：30秒无响应自动拒绝
- **优雅降级**：服务器不可用时回退到终端提示

### 交互式问答
- **多选项问题**：通过 Telegram 按钮回答 Claude 的问题
- **自定义输入**：回复问题消息输入自定义文本
- **丰富格式**：查看问题上下文和选项描述

### 远程任务注入（新功能！）
- **从 Telegram 发送任务**：通过发送消息启动新的 Claude 任务
- **PTY 包装器**：使用 tmux 实现可靠的终端集成
- **队列系统**：任务按顺序排队处理

## 系统架构

```
┌────────────────────────────────────────────────────────────────┐
│                    Claude-Call 系统                            │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────┐     ┌─────────────────┐     ┌────────────┐  │
│  │   Telegram   │────▶│   授权服务器     │────▶│   Claude   │  │
│  │   消息       │     │   (Bun HTTP)    │     │    Code    │  │
│  └──────────────┘     └─────────────────┘     └────────────┘  │
│         │                     │                      │         │
│         │                     │                      │         │
│         ▼                     ▼                      ▼         │
│  ┌──────────────┐     ┌─────────────────┐     ┌────────────┐  │
│  │   按钮       │     │   任务队列      │     │   PTY      │  │
│  │   回调       │     │   管理          │     │   包装器   │  │
│  └──────────────┘     └─────────────────┘     │   (tmux)   │  │
│         │                     │               └────────────┘  │
│         └─────────────────────┴───────────────────────┘       │
│                              │                                 │
│                    Telegram 长轮询                             │
└────────────────────────────────────────────────────────────────┘
```

### 消息流转

| Telegram 消息类型 | 处理函数 | 用途 |
|------------------|----------|------|
| 按钮回调 (`callback_query`) | `processCallback()` | 工具授权决策 |
| 回复机器人消息 | `processReplyMessage()` | 问题的自定义文本输入 |
| 普通文本消息 | `processNewTaskMessage()` | 新任务的 PTY 注入 |

### 数据流向

```
工具授权：
Claude Code → PreToolUse Hook → POST /authorize → Telegram 消息
                                                        ↓
                              Hook 轮询 /poll/:id ← 用户点击按钮

任务注入：
Telegram 消息 → 服务器任务队列 → PTY 包装器轮询 /tasks/pending
                                                        ↓
                                      tmux send-keys → Claude Code
```

## 安装配置

### 前置要求

- [Bun](https://bun.sh) 运行时
- [tmux](https://github.com/tmux/tmux)（用于 PTY 包装器）
- Telegram Bot Token

### 1. 克隆并安装

```bash
git clone https://github.com/yourusername/claude-call.git
cd claude-call
bun install
```

### 2. 安装 tmux（用于任务注入）

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt install tmux
```

### 3. 配置环境变量

创建 `.env` 文件：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
TELEGRAM_BOT_TOKEN=你的机器人Token
TELEGRAM_CHAT_ID=你的聊天ID
AUTH_SERVER_PORT=3847
AUTH_TIMEOUT_MS=30000
```

**获取 Telegram Bot Token：**
1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot` 并按提示操作
3. 复制提供的 Token

**获取 Chat ID：**
1. 给你的机器人发送任意消息
2. 访问 `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. 在返回的 JSON 中找到 `chat.id`

### 4. 配置 Claude Code Hook

添加到 `~/.claude/settings.json`：

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

## 使用方法

### 基础：仅工具授权

```bash
# 终端 1：启动服务器
bun run start

# 终端 2：正常使用 Claude Code
claude
```

当 Claude 尝试使用工具时，你会收到带有按钮的 Telegram 消息：
- ✅ **Allow**：允许本次操作
- ❌ **Deny**：拒绝本次操作
- 🔓 **Allow All Session**：允许所有后续操作

### 高级：带任务注入

```bash
# 终端 1：启动服务器
bun run start

# 终端 2：使用 PTY 包装器启动 Claude
bun run claude
```

现在你可以：
1. 通过 Telegram 按钮**授权工具**
2. 点击选项或回复文本**回答问题**
3. 发送普通消息**发送新任务**

### tmux 控制

由于 PTY 包装器使用 tmux：
- **向上滚动**：`Ctrl+b` 然后 `[`，使用方向键，`q` 退出
- **分离会话**：`Ctrl+b` 然后 `d`
- **重新连接**：`tmux attach -t claude-call`

## API 参考

### 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `POST /authorize` | 提交授权或问题请求 |
| `GET /poll/:id` | 轮询请求决策 |
| `GET /tasks/pending` | 获取待处理的 PTY 注入任务 |
| `POST /tasks/:id/ack` | 确认任务已处理 |
| `GET /tasks/stats` | 任务队列统计 |
| `GET /health` | 健康检查 |
| `GET /status` | 调试：查看待处理请求 |

### 授权请求

```typescript
POST /authorize
{
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd?: string;
  // 问题请求：
  type?: "question";
  question?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}
```

### 轮询响应

```typescript
GET /poll/:requestId
{
  status: "pending" | "resolved" | "timeout" | "not_found";
  decision?: "allow" | "deny";
  selectedOption?: string;  // 问题的选中选项
  elapsed?: number;
}
```

## 配置说明

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TELEGRAM_BOT_TOKEN` | - | Telegram Bot API Token（必需） |
| `TELEGRAM_CHAT_ID` | - | 你的 Telegram 聊天 ID（必需） |
| `AUTH_SERVER_PORT` | 3847 | HTTP 服务器端口 |
| `AUTH_TIMEOUT_MS` | 30000 | 授权超时毫秒数 |
| `CLAUDE_CALL_SERVER_URL` | `http://localhost:3847` | PTY 包装器的服务器 URL |

### 文件结构

```
claude-call/
├── server/
│   ├── index.ts        # HTTP 服务器和 API 路由
│   ├── telegram.ts     # Telegram 机器人集成
│   ├── store.ts        # 请求状态管理
│   ├── task-queue.ts   # PTY 注入的任务队列
│   └── types.ts        # TypeScript 接口定义
├── wrapper/
│   └── pty-wrapper.ts  # 基于 tmux 的 PTY 包装器
├── hooks/
│   └── scripts/
│       └── telegram-auth.ts  # PreToolUse hook 脚本
└── package.json
```

## 常见问题

### 服务器问题

**端口被占用：**
```bash
lsof -i :3847
kill -9 <PID>
```

**Telegram 连接失败：**
- 验证 Bot Token 是否正确
- 确保你已经给机器人发送过消息
- 检查服务器日志是否有 API 错误

### PTY 包装器问题

**找不到 tmux：**
```bash
brew install tmux  # macOS
sudo apt install tmux  # Linux
```

**任务未执行：**
- 确保服务器正在运行（`bun run start`）
- 检查 PTY 包装器是否显示 "Server connection verified"
- 验证消息是否出现在 Claude 输入行

### Hook 问题

**Hook 没有触发：**
- 验证 `~/.claude/settings.json` 中的路径是否正确
- 确保 bun 在系统 PATH 中
- 检查 Claude Code 日志是否有 hook 错误

**授权超时：**
- 在 `.env` 中增加 `AUTH_TIMEOUT_MS`
- 在 hook 配置中增加 `timeout`

## 开发

```bash
# 开发模式（热重载）
bun run dev

# 运行 PTY 包装器
bun run claude
```

## 技术栈

- **运行时**：Bun
- **语言**：TypeScript
- **终端**：tmux（PTY 管理）
- **通信**：Telegram Bot API（长轮询）
- **集成**：Claude Code PreToolUse Hook

## 许可证

MIT

## 贡献

欢迎贡献！请随时提交 Pull Request。

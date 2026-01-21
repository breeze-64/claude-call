# Claude-Call

> **通过 Telegram 远程控制 Claude Code** - 手机授权、回答问题、注入任务。**编程效率提升10倍**。
>
> **Remote control Claude Code via Telegram** - Authorize tool execution, answer questions, and inject tasks from your phone. **10x productivity boost**.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue)](https://www.typescriptlang.org/)
[![Claude Code](https://img.shields.io/badge/integrates%20with-Claude%20Code-purple)](https://claude.ai/code)

[Claude Code](https://claude.ai/code)（Anthropic 官方 CLI 工具）的完整 Telegram 集成。授权工具、回答问题、发送新任务，全部通过手机完成。

## 为什么选择 Claude-Call? | Why Claude-Call?

- **移动办公，效率不减** | **Stay Mobile, Stay Productive** - 随时随地审批 Claude 的操作 - 开会、通勤、喝咖啡时都能处理
- **告别等待** | **No More Waiting** - Claude 持续工作，你用手机随时审批
- **多任务处理** | **Multi-task Like a Pro** - 运行多个 Claude 会话，一个聊天窗口全部控制
- **零切换成本** | **Zero Context Switch** - 简单的是/否决定，无需回到电脑前

**关键词 | Keywords**: Claude Code, Telegram 机器人, 工具授权, 远程控制, AI 助手, Anthropic, CLI 集成, AI编程, 效率工具, 提效神器, Productivity, Automation, AI Coding

[English](./README.md) | 中文

## 一键安装 | Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/breeze-64/claude-call/main/install.sh | bash
```

安装脚本会：
- 自动安装 Bun 和 tmux（如果需要）
- 引导你完成 Telegram Bot 配置
- 自动配置 Claude Code hooks
- 创建 `claude-call` 和 `claude-call-server` 命令

安装后使用：
```bash
# 终端 1：启动服务器
claude-call-server

# 终端 2：运行带 Telegram 集成的 Claude Code
claude-call
```

## 截图 | Screenshots

<p align="center">
  <img src="docs/images/before-after.svg" alt="Before vs After" width="100%">
</p>

<p align="center">
  <img src="docs/images/telegram-auth.svg" alt="Telegram 授权界面" width="300">
  <br>
  <em>Telegram 授权界面 | Telegram Authorization Interface</em>
</p>

<p align="center">
  <img src="docs/images/workflow.svg" alt="工作流程" width="100%">
  <br>
  <em>工作流程 | How it works</em>
</p>

<p align="center">
  <img src="docs/images/multi-session.svg" alt="多会话管理" width="100%">
  <br>
  <em>多会话管理 | Multi-Session Management</em>
</p>

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

### 远程任务注入
- **从 Telegram 发送任务**：通过发送消息启动新的 Claude 任务
- **PTY 包装器**：使用 tmux 实现可靠的终端集成
- **队列系统**：任务按顺序排队处理

### 多会话管理
- **会话注册**：每个 `bun run claude` 实例注册为独立会话
- **会话选择**：多会话时选择目标会话
- **直接定向**：使用 `@shortId` 前缀发送到特定会话
- **会话命令**：`/sessions` 列出所有活跃会话

### 远程启动会话（新功能）
- **Telegram 命令**：`/claude_call` 远程启动新的 Claude Code 会话
- **自动日期文件夹**：会话在日期文件夹中创建（`YYYYMMDD`）
- **后台模式**：会话后台运行，随时可通过 tmux 连接查看
- **会话限制**：最多 5 个并发会话（可配置）

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
│  │   按钮       │     │   会话注册 &    │     │   PTY      │  │
│  │   回调       │     │   任务队列      │     │   包装器   │  │
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
| `/sessions` 命令 | `processSessionsCommand()` | 列出所有活跃会话 |
| `/claude_call` 命令 | `processClaudeCallCommand()` | 远程启动新 Claude 会话 |
| 普通文本消息 | `processNewTaskMessage()` | 新任务的 PTY 注入 |
| `@shortId 消息` | `processNewTaskMessage()` | 发送到特定会话 |

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
git clone https://github.com/breeze-64/claude-call.git
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

## 全局安装（可选）

为了更专业的生产级配置，你可以将 PTY 包装器安装为全局命令。这样可以在任何目录下运行 `claude-call`。

### 为什么需要全局安装？

| 配置方式 | 命令 | 限制 |
|---------|------|------|
| 默认 | `bun run claude` | 必须在项目目录下运行 |
| **全局** | `claude-call` | **任意目录都可运行** |

### 前置条件

确保你已完成基础安装：
- [Bun](https://bun.sh) 已安装且在 PATH 中
- 已克隆本仓库

### 安装步骤

首先，设置 claude-call 目录的变量（根据你的实际路径调整）：

```bash
# 设置为你实际的 claude-call 目录路径
CLAUDE_CALL_DIR="$HOME/code/claude-call"
```

**步骤 1：验证源文件存在**
```bash
ls "$CLAUDE_CALL_DIR/wrapper/pty-wrapper.ts" || echo "错误：文件未找到，请检查 CLAUDE_CALL_DIR 路径。"
```

**步骤 2：创建专用目录并复制 PTY 包装器**
```bash
mkdir -p ~/.claude-call
cp "$CLAUDE_CALL_DIR/wrapper/pty-wrapper.ts" ~/.claude-call/
```

**步骤 3：创建 bin 目录**
```bash
mkdir -p ~/bin
```

**步骤 4：创建全局命令脚本**
```bash
cat > ~/bin/claude-call << 'EOF'
#!/bin/bash
export CLAUDE_CALL_SERVER_URL="${CLAUDE_CALL_SERVER_URL:-http://localhost:3847}"
exec bun run "$HOME/.claude-call/pty-wrapper.ts" "$@"
EOF
```

**步骤 5：添加执行权限**
```bash
chmod +x ~/bin/claude-call
```

**步骤 6：将 ~/bin 加入 PATH**

**zsh**（macOS 默认）：
```bash
grep -q '$HOME/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
```

**bash**：
```bash
grep -q '$HOME/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
```

**步骤 7：使配置生效**

打开**新的终端窗口**，或运行：
```bash
# zsh 用户
source ~/.zshrc

# bash 用户
source ~/.bashrc
```

### 验证安装

```bash
# 应输出: /Users/yourname/bin/claude-call（或类似路径）
which claude-call

# 应显示脚本内容
cat ~/bin/claude-call

# 应显示 pty-wrapper.ts 文件
ls -la ~/.claude-call/
```

### 全局安装后的使用方式

```bash
# 终端 1：启动服务器
cd "$CLAUDE_CALL_DIR" && bun run start
# 或者直接使用路径：
# cd ~/code/claude-call && bun run start

# 终端 2：在任意目录运行
cd ~/my-project
claude-call
```

### 更新

当你更新了仓库后，同步 `pty-wrapper.ts` 到全局位置：
```bash
cp "$CLAUDE_CALL_DIR/wrapper/pty-wrapper.ts" ~/.claude-call/
# 或使用完整路径：
# cp ~/code/claude-call/wrapper/pty-wrapper.ts ~/.claude-call/
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

### 多会话使用

在不同终端运行多个 Claude 实例：

```bash
# 终端 A
bun run claude  # 注册为会话，如 "claude-abc123" (shortId: abc12345)

# 终端 B
bun run claude  # 注册为会话，如 "claude-def456" (shortId: def45678)
```

从 Telegram 操作：
- **列出会话**：发送 `/sessions` 查看所有活跃会话
- **直接定向**：发送 `@abc12345 你的任务` 发送到特定会话
- **自动选择**：多会话时，机器人显示选择按钮

### 通过 Telegram 远程启动会话

使用 `/claude_call` 命令直接从 Telegram 启动 Claude Code 会话：

1. **在 `.env` 中配置基础目录**：
   ```env
   CLAUDE_CALL_BASE_DIR=/path/to/your/work/directory
   ```

2. **在 Telegram 中发送 `/claude_call`** 启动新会话
   - 在基础目录下创建以当天日期命名的文件夹（`YYYYMMDD`）
   - Claude Code 以后台模式启动（不自动连接终端）
   - 你会收到包含会话 ID 的确认消息

3. **查看运行中的会话**：
   ```bash
   # 列出所有 tmux 会话
   tmux ls

   # 连接到特定会话（用实际的会话名替换）
   tmux attach-session -t claude-xxxxxx
   ```

4. **分离但不停止**：按 `Ctrl+b` 然后 `d` 可以分离会话，会话继续在后台运行

### tmux 控制

由于 PTY 包装器使用 tmux：
- **向上滚动**：`Ctrl+b` 然后 `[`，使用方向键，`q` 退出
- **分离会话**：`Ctrl+b` 然后 `d`
- **重新连接**：`tmux attach -t <session-name>`
- **列出会话**：`tmux ls`

## API 参考

### 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `POST /authorize` | 提交授权或问题请求 |
| `GET /poll/:id` | 轮询请求决策 |
| `GET /sessions` | 列出所有活跃会话 |
| `POST /sessions/register` | 注册新的 PTY 会话 |
| `POST /sessions/:id/unregister` | 注销 PTY 会话 |
| `GET /tasks/pending/:sessionId` | 获取特定会话的待处理任务 |
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
| `CLAUDE_CALL_BASE_DIR` | - | `/claude_call` 命令的基础目录（远程启动必需） |

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

# Claude-Call

通过 Telegram 按钮授权 Claude Code 工具使用。

[English](./README.md) | 中文

## 功能特点

- **Telegram 集成**：收到带有内联按钮的授权请求消息
- **快捷操作**：允许、拒绝或允许本次会话的所有操作
- **实时响应**：点击按钮即时生效
- **超时保护**：30秒无响应自动拒绝
- **优雅降级**：服务器不可用时回退到终端提示

## 工作原理

```
Claude Code → PreToolUse Hook → 授权服务器 → Telegram Bot
                                    ↑
                            用户点击按钮
                                    ↓
                            Telegram 回调 → 服务器 → Hook 返回决策
```

## 安装配置

### 1. 安装依赖

```bash
cd /path/to/claude-call
bun install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填写你的配置：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```
TELEGRAM_BOT_TOKEN=你的机器人Token
TELEGRAM_CHAT_ID=你的聊天ID
AUTH_SERVER_PORT=3847
AUTH_TIMEOUT_MS=30000
```

**获取 Telegram Bot Token：**
1. 在 Telegram 中找到 @BotFather
2. 发送 `/newbot` 创建新机器人
3. 按提示设置名称，获取 Token

**获取 Chat ID：**
1. 给你的机器人发送任意消息
2. 访问 `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. 在返回的 JSON 中找到 `chat.id`

### 3. 启动服务器

```bash
bun run start
```

### 4. 配置 Claude Code

将以下配置添加到 `~/.claude/settings.json` 的 hooks 部分：

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

1. 启动授权服务器：`bun run start`
2. 正常使用 Claude Code
3. 当 Claude 尝试执行 Bash、Write、Edit 等操作时，你会收到 Telegram 消息
4. 点击按钮进行授权：
   - ✅ **Allow**：允许本次操作
   - ❌ **Deny**：拒绝本次操作
   - 🔓 **Allow All Session**：允许本会话的所有后续操作

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/authorize` | POST | 提交新的授权请求 |
| `/poll/:id` | GET | 轮询授权决策 |
| `/health` | GET | 健康检查 |
| `/status` | GET | 查看待处理请求（调试用） |

## 配置说明

`.env` 环境变量：

| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | Telegram 机器人 Token |
| `TELEGRAM_CHAT_ID` | 你的 Telegram 聊天 ID |
| `AUTH_SERVER_PORT` | 服务器端口（默认：3847） |
| `AUTH_TIMEOUT_MS` | 请求超时毫秒数（默认：30000） |

## 常见问题

### 服务器无法启动

- 检查端口 3847 是否被占用
- 验证 Telegram Bot Token 是否正确
- 确保已安装 bun

### 收不到 Telegram 消息

- 验证 Chat ID 是否正确
- 确保你已经给机器人发送过消息
- 检查服务器日志是否有 Telegram API 错误

### Hook 没有触发

- 验证插件配置是否正确
- 检查 Claude Code 的 hook 配置
- 确保 bun 在系统 PATH 中

## 技术栈

- **运行时**：Bun
- **语言**：TypeScript
- **通信**：Telegram Bot API (Long Polling)
- **集成**：Claude Code PreToolUse Hook

## 许可证

MIT

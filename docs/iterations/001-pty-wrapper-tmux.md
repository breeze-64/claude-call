# Iteration 001: PTY Wrapper with tmux

**日期**: 2025-01-18
**状态**: 已完成
**Commit**: f336c45

## 背景

用户需求：在 Claude Code 终端中可能出现的交互，都能通过 Telegram 对话完成。

## 实现方案

### 架构选择

尝试了多种 PTY 实现方案：

| 方案 | 结果 | 失败原因 |
|------|------|----------|
| Bun.Terminal.write() | 失败 | 绕过 PTY 行规程，\r 不触发执行 |
| fs.writeSync(fd) | 失败 | Bun.Terminal 不暴露 fd 属性 |
| node-pty | 失败 | Node.js v25 兼容性问题，posix_spawnp failed |
| script 命令 | 失败 | Bun.spawn 的 pipe 不是真正的 tty |
| **tmux** | **成功** | 成熟稳定，send-keys 可靠 |

### 最终方案：tmux

```
┌─────────────────────────────────────────────────────────┐
│  PTY Wrapper                                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │  tmux session: claude-call                        │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  Claude Code                                │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
│                           │                             │
│  Task Polling ───────────►│                             │
│  (GET /tasks/pending)     │                             │
│                           ▼                             │
│                    tmux send-keys                       │
└─────────────────────────────────────────────────────────┘
```

### 消息路由

| Telegram 消息类型 | 处理 | 目标 |
|------------------|------|------|
| 按钮回调 | processCallback() | Hook 授权 |
| 回复消息 | processReplyMessage() | 问题自定义输入 |
| 普通文本 | processNewTaskMessage() | PTY 任务注入 |

## 已实现功能

- [x] 工具授权（Allow/Deny/Allow All）
- [x] 多选项问题回答
- [x] 自定义文本输入（回复消息）
- [x] 远程任务注入（普通消息 → tmux send-keys）
- [x] 任务队列管理

## 待解决问题

### 1. 任务完成通知

**现状**: 任务注入后无通知
**需求**: 任务执行完成后发送 Telegram 通知

**方案**:
- 监听 tmux 输出变化
- 检测 Claude 返回到输入等待状态（`❯` 提示符）
- 发送 "任务完成" 通知到 Telegram

### 2. 多会话冲突 ✅ 已解决

**原问题**:
- tmux 会话名固定为 `claude-call`
- 多次运行 `bun run claude` 会覆盖前一个会话
- 任务队列是全局的，不区分会话

**采用方案**: 选项 C - 完整会话管理

实现内容：
- 会话注册/注销 API (`/sessions/register`, `/sessions/:id/unregister`)
- 会话隔离的任务队列
- `/sessions` 命令列出活跃会话
- 多会话时显示选择按钮
- `@shortId` 语法直接定向

## 下一步

1. 实现任务完成通知

## 相关文件

- `wrapper/pty-wrapper.ts` - PTY 包装器
- `server/task-queue.ts` - 任务队列和会话注册
- `server/telegram.ts` - Telegram 消息处理
- `server/index.ts` - HTTP 服务器和会话 API

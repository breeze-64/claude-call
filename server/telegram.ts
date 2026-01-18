import type {
  PendingRequest,
  TelegramUpdate,
  TelegramInlineKeyboard,
  TelegramMessage,
  QuestionOption,
} from "./types";
import {
  getRequest,
  getRequestByMessageId,
  resolveAuthRequest,
  resolveQuestionRequest,
  setRequestMessageId,
  setSessionAllowAll,
  isRequestTimedOut,
} from "./store";
import {
  addTask,
  addTaskToDefaultSession,
  addTaskToSession,
  getAllSessions,
  getSession,
  getSessionCount,
  type Session,
} from "./task-queue";

// Store pending task messages waiting for session selection
const pendingTaskMessages = new Map<number, { text: string; messageId: number }>();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

let lastUpdateId = 0;

/**
 * Call Telegram API
 */
async function callApi<T>(method: string, body?: object): Promise<T> {
  const response = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!result.ok) {
    console.error(`Telegram API error (${method}):`, result);
    throw new Error(result.description || "Telegram API error");
  }
  return result.result;
}

/**
 * Format tool input for display
 */
function formatToolInput(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === "Bash") {
    const cmd = String(toolInput.command || "");
    const truncated = cmd.length > 500 ? cmd.slice(0, 500) + "..." : cmd;
    return "```\n" + truncated + "\n```";
  }

  if (toolInput.file_path) {
    return `\`${toolInput.file_path}\``;
  }

  const json = JSON.stringify(toolInput, null, 2);
  const truncated = json.length > 300 ? json.slice(0, 300) + "..." : json;
  return "```json\n" + truncated + "\n```";
}

/**
 * Format authorization message for Telegram
 */
function formatAuthMessage(request: PendingRequest): string {
  const sessionShort = request.sessionId.slice(0, 8);
  const details = formatToolInput(request.toolName, request.toolInput);

  return `🔐 *Tool Authorization Request*

📋 Tool: \`${request.toolName}\`
🔑 Session: \`${sessionShort}...\`
${request.cwd ? `📂 Dir: \`${request.cwd}\`` : ""}

${details}`;
}

/**
 * Format question message for Telegram
 */
function formatQuestionMessage(request: PendingRequest): string {
  const sessionShort = request.sessionId.slice(0, 8);

  let optionsText = "";
  if (request.options && request.options.length > 0) {
    optionsText = request.options
      .map((opt, i) => {
        const desc = opt.description ? `\n   ${opt.description}` : "";
        return `*${opt.id}*. ${opt.label}${desc}`;
      })
      .join("\n\n");
  }

  return `❓ *${request.question || "请选择一个选项"}*

🔑 Session: \`${sessionShort}...\`

${optionsText}

💡 _回复此消息可输入自定义内容_`;
}

/**
 * Create inline keyboard for authorization
 */
function createAuthKeyboard(requestId: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "✅ Allow", callback_data: `allow:${requestId}` },
        { text: "❌ Deny", callback_data: `deny:${requestId}` },
      ],
      [{ text: "🔓 Allow All Session", callback_data: `allowall:${requestId}` }],
    ],
  };
}

/**
 * Create inline keyboard for question with dynamic options
 */
function createQuestionKeyboard(
  requestId: string,
  options: QuestionOption[]
): TelegramInlineKeyboard {
  // Create buttons, max 3 per row
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  let currentRow: Array<{ text: string; callback_data: string }> = [];

  for (const opt of options) {
    currentRow.push({
      text: opt.label.length > 20 ? opt.label.slice(0, 18) + ".." : opt.label,
      callback_data: `opt:${requestId}:${opt.id}`,
    });

    if (currentRow.length >= 2) {
      rows.push(currentRow);
      currentRow = [];
    }
  }

  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return { inline_keyboard: rows };
}

/**
 * Send authorization request to Telegram
 */
export async function sendAuthRequest(request: PendingRequest): Promise<void> {
  try {
    const message = formatAuthMessage(request);
    const keyboard = createAuthKeyboard(request.id);

    const result = await callApi<{ message_id: number }>("sendMessage", {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

    setRequestMessageId(request.id, result.message_id);
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
  }
}

/**
 * Send question request to Telegram
 */
export async function sendQuestionRequest(request: PendingRequest): Promise<void> {
  try {
    const message = formatQuestionMessage(request);
    const keyboard = createQuestionKeyboard(request.id, request.options || []);

    const result = await callApi<{ message_id: number }>("sendMessage", {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

    setRequestMessageId(request.id, result.message_id);
  } catch (error) {
    console.error("Failed to send Telegram question:", error);
  }
}

/**
 * Update message after decision
 */
export async function updateMessage(
  request: PendingRequest,
  statusText: string
): Promise<void> {
  if (!request.messageId) return;

  try {
    const sessionShort = request.sessionId.slice(0, 8);
    let text: string;

    if (request.type === "question") {
      text = `${statusText}

❓ ${request.question || "选择"}
🔑 Session: \`${sessionShort}...\``;
    } else {
      text = `${statusText}

📋 Tool: \`${request.toolName}\`
🔑 Session: \`${sessionShort}...\``;
    }

    await callApi("editMessageText", {
      chat_id: CHAT_ID,
      message_id: request.messageId,
      text,
      parse_mode: "Markdown",
    });
  } catch (error) {
    // Message might already be edited, ignore
  }
}

/**
 * Answer callback query (dismisses loading indicator)
 */
async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  try {
    await callApi("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  } catch (error) {
    // Ignore - callback might have expired
  }
}

/**
 * Process a callback query from Telegram
 */
export async function processCallback(
  callbackQuery: TelegramUpdate["callback_query"]
): Promise<void> {
  if (!callbackQuery?.data || !callbackQuery.message) return;

  // Verify it's from the correct chat
  if (String(callbackQuery.message.chat.id) !== CHAT_ID) {
    console.warn("Callback from unauthorized chat:", callbackQuery.message.chat.id);
    return;
  }

  const data = callbackQuery.data;

  // Handle session selection for task (format: sess:sessionId:originalMsgId)
  if (data.startsWith("sess:")) {
    const parts = data.split(":");
    const sessionId = parts[1];
    const originalMsgId = parseInt(parts[2], 10);

    const pendingTask = pendingTaskMessages.get(originalMsgId);
    if (!pendingTask) {
      await answerCallbackQuery(callbackQuery.id, "任务已过期");
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      await answerCallbackQuery(callbackQuery.id, "会话不存在");
      return;
    }

    // Add task to selected session
    const task = addTask(session.id, pendingTask.text);
    pendingTaskMessages.delete(originalMsgId);

    // Update message
    const preview = pendingTask.text.length > 50 ? pendingTask.text.slice(0, 50) + "..." : pendingTask.text;
    await callApi("editMessageText", {
      chat_id: CHAT_ID,
      message_id: callbackQuery.message.message_id,
      text: `📝 *任务已发送到 ${session.name}*\n\n\`${preview}\`\n\n_任务 ID: ${task.id.slice(0, 8)}_`,
      parse_mode: "Markdown",
    });

    await answerCallbackQuery(callbackQuery.id, `已发送到 ${session.name}`);
    return;
  }

  // Handle option selection (format: opt:requestId:optionId)
  if (data.startsWith("opt:")) {
    const parts = data.split(":");
    const requestId = parts[1];
    const optionId = parts.slice(2).join(":"); // Option ID might contain ":"

    const request = getRequest(requestId);
    if (!request) {
      await answerCallbackQuery(callbackQuery.id, "Request not found");
      return;
    }

    if (request.resolved) {
      await answerCallbackQuery(callbackQuery.id, "Already answered");
      return;
    }

    if (isRequestTimedOut(request)) {
      await updateMessage(request, "⏱️ *Timeout*");
      await answerCallbackQuery(callbackQuery.id, "Request timed out");
      return;
    }

    // Find the selected option
    const selectedOption = request.options?.find((o) => o.id === optionId);
    const optionLabel = selectedOption?.label || optionId;

    resolveQuestionRequest(requestId, optionId);
    await updateMessage(request, `✅ *已选择: ${optionLabel}*`);
    await answerCallbackQuery(callbackQuery.id, `选择: ${optionLabel}`);
    return;
  }

  // Handle authorization (format: action:requestId)
  const [action, requestId] = data.split(":");
  const request = getRequest(requestId);

  if (!request) {
    await answerCallbackQuery(callbackQuery.id, "Request not found");
    return;
  }

  if (request.resolved) {
    await answerCallbackQuery(callbackQuery.id, "Already processed");
    return;
  }

  // Check timeout
  if (isRequestTimedOut(request)) {
    resolveAuthRequest(requestId, "deny");
    await updateMessage(request, "⏱️ *Timeout - Denied*");
    await answerCallbackQuery(callbackQuery.id, "Request timed out");
    return;
  }

  // Process decision
  let decision: "allow" | "deny";
  let statusText: string;

  switch (action) {
    case "allow":
      decision = "allow";
      statusText = "✅ *Allowed*";
      break;
    case "deny":
      decision = "deny";
      statusText = "❌ *Denied*";
      break;
    case "allowall":
      decision = "allow";
      statusText = "🔓 *Allowed (All Session)*";
      setSessionAllowAll(request.sessionId);
      break;
    default:
      await answerCallbackQuery(callbackQuery.id, "Unknown action");
      return;
  }

  resolveAuthRequest(requestId, decision);
  await updateMessage(request, statusText);
  await answerCallbackQuery(callbackQuery.id, decision === "allow" ? "Allowed" : "Denied");
}

/**
 * Process a reply message from Telegram (for custom text input)
 */
export async function processReplyMessage(
  message: TelegramUpdate["message"]
): Promise<void> {
  console.log("[DEBUG] processReplyMessage called with:", JSON.stringify(message, null, 2));

  if (!message?.text || !message.reply_to_message) {
    console.log("[DEBUG] Skipping - no text or not a reply");
    return;
  }

  // Verify it's from the correct chat
  if (String(message.chat.id) !== CHAT_ID) {
    console.warn("Message from unauthorized chat:", message.chat.id);
    return;
  }

  const replyToMessageId = message.reply_to_message.message_id;
  console.log("[DEBUG] Looking for request with messageId:", replyToMessageId);

  const request = getRequestByMessageId(replyToMessageId);
  console.log("[DEBUG] Found request:", request ? request.id : "NOT FOUND");

  if (!request) {
    // Not a reply to our message, ignore
    console.log("[DEBUG] Request not found for messageId:", replyToMessageId);
    return;
  }

  if (request.resolved) {
    await callApi("sendMessage", {
      chat_id: CHAT_ID,
      text: "⚠️ 该请求已处理",
      reply_to_message_id: message.message_id,
    });
    return;
  }

  // Note: Don't check timeout here - if user replied, we should accept it
  // The hook will handle timeout on its own

  const customText = message.text.trim();

  // Use special prefix to indicate custom input
  resolveQuestionRequest(request.id, `__CUSTOM__:${customText}`);
  await updateMessage(request, `✏️ *自定义输入: ${customText}*`);

  // Send confirmation
  await callApi("sendMessage", {
    chat_id: CHAT_ID,
    text: `✅ 已收到: "${customText}"`,
    reply_to_message_id: message.message_id,
  });
}

/**
 * Poll for Telegram updates (long polling)
 */
export async function pollUpdates(): Promise<void> {
  try {
    const updates = await callApi<TelegramUpdate[]>("getUpdates", {
      offset: lastUpdateId + 1,
      timeout: 10,
      allowed_updates: ["callback_query", "message"],
    });

    if (updates.length > 0) {
      console.log("[DEBUG] Received updates:", updates.length);
    }

    for (const update of updates) {
      lastUpdateId = update.update_id;

      if (update.callback_query) {
        console.log("[DEBUG] Processing callback_query");
        await processCallback(update.callback_query);
      }

      if (update.message) {
        console.log("[DEBUG] Received message:", update.message.text?.slice(0, 50));
        console.log("[DEBUG] Is reply:", !!update.message.reply_to_message);
        if (update.message.reply_to_message) {
          // Reply message → custom input for questions
          await processReplyMessage(update.message);
        } else if (update.message.text?.startsWith("/sessions")) {
          // /sessions command → list active sessions
          await processSessionsCommand(update.message);
        } else if (update.message.text && !update.message.text.startsWith("/")) {
          // Plain text message (not a command) → new task for PTY injection
          await processNewTaskMessage(update.message);
        }
      }
    }
  } catch (error) {
    console.error("Telegram polling error:", error);
  }
}

/**
 * Start the Telegram polling loop
 */
export function startPolling(): void {
  console.log("Starting Telegram polling...");

  const poll = async () => {
    while (true) {
      try {
        await pollUpdates();
      } catch (error) {
        // Log error but continue polling
        console.error("Polling error (will retry):", String(error).slice(0, 100));
        // Wait longer on error (409 conflict needs time to resolve)
        await Bun.sleep(5000);
        continue;
      }
      // Small delay to prevent tight loop
      await Bun.sleep(100);
    }
  };

  poll().catch(console.error);
}

/**
 * Send a test message
 */
export async function sendTestMessage(): Promise<boolean> {
  try {
    await callApi("sendMessage", {
      chat_id: CHAT_ID,
      text: "🚀 Claude-Call server started!",
    });
    return true;
  } catch (error) {
    console.error("Failed to send test message:", error);
    return false;
  }
}

/**
 * Process /sessions command - list active sessions
 */
async function processSessionsCommand(message: TelegramMessage): Promise<void> {
  // Verify it's from the correct chat
  if (String(message.chat.id) !== CHAT_ID) {
    return;
  }

  const sessions = getAllSessions();

  if (sessions.length === 0) {
    await callApi("sendMessage", {
      chat_id: CHAT_ID,
      text: "📭 *没有活跃的会话*\n\n运行 `bun run claude` 启动新会话",
      parse_mode: "Markdown",
      reply_to_message_id: message.message_id,
    });
    return;
  }

  const sessionList = sessions.map((s, i) => {
    const age = Math.round((Date.now() - s.createdAt) / 60000);
    return `${i + 1}. *${s.name}* (\`${s.shortId}\`)\n   📂 ${s.cwd}\n   ⏱️ ${age} 分钟前创建`;
  }).join("\n\n");

  await callApi("sendMessage", {
    chat_id: CHAT_ID,
    text: `📋 *活跃会话 (${sessions.length})*\n\n${sessionList}\n\n_发送消息时可用 @shortId 指定会话_\n_例如: @${sessions[0].shortId} 你的任务_`,
    parse_mode: "Markdown",
    reply_to_message_id: message.message_id,
  });
}

/**
 * Create session selection keyboard
 */
function createSessionKeyboard(
  sessions: Session[],
  originalMsgId: number
): TelegramInlineKeyboard {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (const session of sessions) {
    rows.push([{
      text: `📱 ${session.name}`,
      callback_data: `sess:${session.shortId}:${originalMsgId}`,
    }]);
  }

  return { inline_keyboard: rows };
}

/**
 * Process a new task message from Telegram (non-reply, non-command message)
 * These messages are queued for PTY injection
 */
export async function processNewTaskMessage(
  message: TelegramMessage
): Promise<void> {
  if (!message?.text) return;

  // Verify it's from the correct chat
  if (String(message.chat.id) !== CHAT_ID) {
    console.warn("[Telegram] Task message from unauthorized chat:", message.chat.id);
    return;
  }

  let taskText = message.text.trim();
  if (!taskText) return;

  const sessions = getAllSessions();

  // Check if no sessions available
  if (sessions.length === 0) {
    await callApi("sendMessage", {
      chat_id: CHAT_ID,
      text: "❌ *没有活跃的会话*\n\n请先运行 `bun run claude` 启动会话",
      parse_mode: "Markdown",
      reply_to_message_id: message.message_id,
    });
    return;
  }

  // Check if message specifies a session with @shortId prefix
  const sessionMatch = taskText.match(/^@([a-f0-9]{8})\s+(.+)$/i);
  if (sessionMatch) {
    const [, shortId, actualTask] = sessionMatch;
    const session = getSession(shortId);

    if (!session) {
      await callApi("sendMessage", {
        chat_id: CHAT_ID,
        text: `❌ 会话 \`${shortId}\` 不存在\n\n使用 /sessions 查看活跃会话`,
        parse_mode: "Markdown",
        reply_to_message_id: message.message_id,
      });
      return;
    }

    // Add task to specified session
    const task = addTask(session.id, actualTask);
    const preview = actualTask.length > 100 ? actualTask.slice(0, 100) + "..." : actualTask;
    await callApi("sendMessage", {
      chat_id: CHAT_ID,
      text: `📝 *任务已发送到 ${session.name}*\n\n\`${preview}\`\n\n_任务 ID: ${task.id.slice(0, 8)}_`,
      parse_mode: "Markdown",
      reply_to_message_id: message.message_id,
    });
    return;
  }

  // Single session: send directly
  if (sessions.length === 1) {
    const session = sessions[0];
    const task = addTask(session.id, taskText);
    const preview = taskText.length > 100 ? taskText.slice(0, 100) + "..." : taskText;

    await callApi("sendMessage", {
      chat_id: CHAT_ID,
      text: `📝 *任务已发送到 ${session.name}*\n\n\`${preview}\`\n\n_任务 ID: ${task.id.slice(0, 8)}_`,
      parse_mode: "Markdown",
      reply_to_message_id: message.message_id,
    });
    console.log(`[Telegram] Task sent to ${session.name}: ${task.id.slice(0, 8)}...`);
    return;
  }

  // Multiple sessions: show selection buttons
  pendingTaskMessages.set(message.message_id, {
    text: taskText,
    messageId: message.message_id,
  });

  const preview = taskText.length > 50 ? taskText.slice(0, 50) + "..." : taskText;
  const keyboard = createSessionKeyboard(sessions, message.message_id);

  await callApi("sendMessage", {
    chat_id: CHAT_ID,
    text: `🔀 *选择目标会话*\n\n任务: \`${preview}\`\n\n点击下方按钮选择发送到哪个会话:`,
    parse_mode: "Markdown",
    reply_to_message_id: message.message_id,
    reply_markup: keyboard,
  });
}

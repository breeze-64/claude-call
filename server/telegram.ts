import type {
  PendingRequest,
  TelegramUpdate,
  TelegramInlineKeyboard,
  TelegramMessage,
  QuestionOption,
} from "./types";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  addKeystrokeTask,
  addSequenceTask,
  getAllSessions,
  getSession,
  getSessionCount,
  type Session,
} from "./task-queue";
import { createLogger } from "./logger";

const log = createLogger("Telegram");

// Store pending task messages waiting for session selection (with timestamp for cleanup)
const pendingTaskMessages = new Map<number, { text: string; messageId: number; createdAt: number }>();

// Pending task messages timeout: 5 minutes
const PENDING_TASK_TIMEOUT = 5 * 60 * 1000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  log.fatal("Missing required environment variables: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  log.fatal("Please create a .env file based on .env.example");
  process.exit(1);
}

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
    log.error(`Telegram API error (${method})`, result);
    throw new Error(result.description || "Telegram API error");
  }
  return result.result;
}

/**
 * Format tool input for display
 */
function formatToolInput(toolName: string, toolInput: Record<string, unknown>): string {
  // Handle known tools
  if (toolName === "Bash") {
    const cmd = String(toolInput.command || "");
    const truncated = cmd.length > 500 ? cmd.slice(0, 500) + "..." : cmd;
    return "```\n" + truncated + "\n```";
  }

  if (toolName === "Edit" || toolName === "Write") {
    const filePath = String(toolInput.file_path || "");
    const content = String(toolInput.new_string || toolInput.content || "");
    const preview = content.length > 200 ? content.slice(0, 200) + "..." : content;
    return `📄 文件: \`${filePath}\`\n\`\`\`\n${preview}\n\`\`\``;
  }

  if (toolInput.file_path) {
    return `📄 文件: \`${toolInput.file_path}\``;
  }

  // For unknown tools or when we need more details, show full content
  if (!toolName || toolName === "未知工具") {
    // Try to infer what the tool might be doing
    const keys = Object.keys(toolInput);
    let details = `📋 *请求内容:*\n`;

    // Show each field with better formatting
    for (const key of keys.slice(0, 10)) { // Limit to 10 fields
      const value = toolInput[key];
      const valueStr = typeof value === "string"
        ? value
        : JSON.stringify(value);
      const truncated = valueStr.length > 300 ? valueStr.slice(0, 300) + "..." : valueStr;
      details += `\n*${key}:*\n\`\`\`\n${truncated}\n\`\`\``;
    }

    if (keys.length > 10) {
      details += `\n_...还有 ${keys.length - 10} 个字段_`;
    }

    return details;
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
  const toolName = request.toolName || "未知工具";
  const details = formatToolInput(toolName, request.toolInput);

  // Extract description if present (Claude Code often includes this for Bash commands)
  const description = request.toolInput?.description as string | undefined;
  const descriptionLine = description ? `\n📝 描述: ${description}` : "";

  return `🔐 *Claude Code 授权请求*

📋 工具: \`${toolName}\`${descriptionLine}
🔑 会话: \`${sessionShort}...\`
${request.cwd ? `📂 目录: \`${request.cwd}\`` : ""}

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
 * Create inline keyboard for PTY keystroke authorization
 * Maps to Claude Code's terminal prompt options:
 * 1. Yes
 * 2. Yes, allow all edits in X during this session
 * 3. No
 */
function createPtyAuthKeyboard(notificationId: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "1️⃣ Yes", callback_data: `pty:${notificationId}:1` },
        { text: "2️⃣ Allow All", callback_data: `pty:${notificationId}:2` },
        { text: "3️⃣ No", callback_data: `pty:${notificationId}:3` },
      ],
    ],
  };
}

/**
 * Send authorization notification to Telegram for PTY keystroke injection
 * This does NOT block - just sends a notification with buttons
 * When user clicks, a keystroke (1/2/3) is injected into the terminal
 */
export async function sendAuthNotification(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd?: string
): Promise<void> {
  try {
    const sessionShort = sessionId.slice(0, 8);
    const details = formatToolInput(toolName, toolInput);
    const description = toolInput?.description as string | undefined;
    const descriptionLine = description ? `\n📝 ${description}` : "";

    // Generate a unique notification ID
    const notificationId = crypto.randomUUID().slice(0, 8);

    const message = `🔐 *终端授权请求*

📋 工具: \`${toolName}\`${descriptionLine}
🔑 Session: \`${sessionShort}...\`
${cwd ? `📂 目录: \`${cwd}\`` : ""}

${details}

_点击按钮将注入按键到终端_`;

    const keyboard = createPtyAuthKeyboard(notificationId);

    await callApi<{ message_id: number }>("sendMessage", {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

    log.info(`Sent auth notification: ${notificationId} for ${toolName}`);
  } catch (error) {
    log.error("Failed to send auth notification", { error: String(error) });
  }
}

/**
 * Create inline keyboard for PTY question notification
 * Maps option IDs (A, B, C...) to keystroke numbers (1, 2, 3...)
 */
function createPtyQuestionKeyboard(
  notificationId: string,
  options: Array<{ id: string; label: string; description?: string }>
): TelegramInlineKeyboard {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  let currentRow: Array<{ text: string; callback_data: string }> = [];

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    // Use 1-based index for keystroke (terminal shows 1, 2, 3...)
    const keystroke = String(i + 1);
    currentRow.push({
      text: opt.label.length > 20 ? opt.label.slice(0, 18) + ".." : opt.label,
      callback_data: `qpty:${notificationId}:${keystroke}:${opt.label.slice(0, 20)}`,
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
 * Send question notification to Telegram for PTY keystroke injection
 * This does NOT block - just sends a notification with option buttons
 * When user clicks, the option number (1/2/3...) is injected into the terminal
 */
export async function sendQuestionNotification(
  sessionId: string,
  question: string,
  options: Array<{ id: string; label: string; description?: string }>,
  cwd?: string
): Promise<void> {
  try {
    const sessionShort = sessionId.slice(0, 8);
    const notificationId = crypto.randomUUID().slice(0, 8);

    let optionsText = "";
    if (options.length > 0) {
      optionsText = options
        .map((opt, i) => {
          const desc = opt.description ? `\n   ${opt.description}` : "";
          return `*${i + 1}*. ${opt.label}${desc}`;
        })
        .join("\n\n");
    }

    const message = `❓ *${question}*

🔑 Session: \`${sessionShort}...\`
${cwd ? `📂 目录: \`${cwd}\`\n` : ""}
${optionsText}

_点击按钮将注入按键到终端_`;

    const keyboard = createPtyQuestionKeyboard(notificationId, options);

    await callApi<{ message_id: number }>("sendMessage", {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

    log.info(`Sent question notification: ${notificationId} with ${options.length} options`);
  } catch (error) {
    log.error("Failed to send question notification", { error: String(error) });
  }
}

/**
 * Create inline keyboard for dynamically detected prompts
 * Uses actual options parsed from terminal
 */
function createDynamicPromptKeyboard(
  notificationId: string,
  options: Array<{ number: string; label: string }>
): TelegramInlineKeyboard {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  let currentRow: Array<{ text: string; callback_data: string }> = [];

  for (const opt of options) {
    // Truncate label for button display
    const displayLabel = opt.label.length > 25 ? opt.label.slice(0, 23) + ".." : opt.label;
    currentRow.push({
      text: `${opt.number}. ${displayLabel}`,
      callback_data: `dyn:${notificationId}:${opt.number}:${opt.label.slice(0, 20)}`,
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
 * Send dynamic prompt notification to Telegram
 * Called by PTY wrapper when it detects an actual prompt in the terminal
 * Options are parsed from terminal content, not hardcoded
 */
export async function sendDynamicPromptNotification(
  sessionId: string,
  type: "permission" | "question" | "unknown",
  title: string,
  options: Array<{ number: string; label: string }>,
  cwd?: string
): Promise<void> {
  try {
    const sessionShort = sessionId.slice(0, 8);
    const notificationId = crypto.randomUUID().slice(0, 8);

    const typeEmoji = type === "permission" ? "🔐" : type === "question" ? "❓" : "📋";
    const typeLabel = type === "permission" ? "权限请求" : type === "question" ? "选择提示" : "交互提示";

    // Format options list
    const optionsText = options
      .map((opt) => `*${opt.number}.* ${opt.label}`)
      .join("\n");

    const message = `${typeEmoji} *${typeLabel}*

📝 ${title}

🔑 Session: \`${sessionShort}...\`
${cwd ? `📂 目录: \`${cwd}\`\n` : ""}
${optionsText}

_点击按钮将注入按键到终端_`;

    const keyboard = createDynamicPromptKeyboard(notificationId, options);

    await callApi<{ message_id: number }>("sendMessage", {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

    log.info(`Sent dynamic prompt notification: ${notificationId} (${type}) with ${options.length} options`);
  } catch (error) {
    log.error("Failed to send dynamic prompt notification", { error: String(error) });
  }
}

/**
 * Multi-question state tracking
 * Maps notificationId to current question index and total questions
 */
interface MultiQuestionState {
  sessionId: string;
  questions: Array<{
    header: string;
    question: string;
    options: Array<{ id: string; label: string; description?: string }>;
  }>;
  currentIndex: number;
  answers: string[]; // Selected option labels for each question
  messageId?: number;
  cwd?: string;
  createdAt: number; // For timeout cleanup
}

const multiQuestionStates = new Map<string, MultiQuestionState>();

// Multi-question state timeout: 10 minutes
const MULTI_QUESTION_TIMEOUT = 10 * 60 * 1000;

/**
 * Create inline keyboard for multi-question selection
 * Shows options for current question, with navigation context
 */
function createMultiQuestionKeyboard(
  notificationId: string,
  state: MultiQuestionState
): TelegramInlineKeyboard {
  const currentQ = state.questions[state.currentIndex];
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  let currentRow: Array<{ text: string; callback_data: string }> = [];

  for (const opt of currentQ.options) {
    const displayLabel = opt.label.length > 22 ? opt.label.slice(0, 20) + ".." : opt.label;
    currentRow.push({
      text: displayLabel,
      // mq = multi-question, format: mq:notificationId:optionId
      callback_data: `mq:${notificationId}:${opt.id}`,
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
 * Format multi-question message showing progress
 */
function formatMultiQuestionMessage(state: MultiQuestionState): string {
  const { questions, currentIndex, answers } = state;
  const sessionShort = state.sessionId.slice(0, 8);

  // Build progress indicator: ✅ 编程语言 → 📍 Web框架 → ⬜ 数据库 → ⬜ Submit
  const progressParts = questions.map((q, i) => {
    const header = q.header || `问题${i + 1}`;
    if (i < currentIndex) {
      return `✅ ${header}`;
    } else if (i === currentIndex) {
      return `📍 *${header}*`;
    } else {
      return `⬜ ${header}`;
    }
  });
  progressParts.push(currentIndex >= questions.length ? "✅ Submit" : "⬜ Submit");
  const progressLine = progressParts.join(" → ");

  // Show previous answers
  let answersText = "";
  if (answers.length > 0) {
    answersText = "\n\n*已选择:*\n" + answers.map((ans, i) => {
      const header = questions[i].header || `问题${i + 1}`;
      return `• ${header}: ${ans}`;
    }).join("\n");
  }

  // Current question
  const currentQ = questions[currentIndex];
  const optionsText = currentQ.options
    .map((opt, i) => `*${i + 1}.* ${opt.label}${opt.description ? `\n   ${opt.description}` : ""}`)
    .join("\n");

  return `❓ *多步骤选择* (${currentIndex + 1}/${questions.length})

${progressLine}

🔑 Session: \`${sessionShort}...\`
${state.cwd ? `📂 目录: \`${state.cwd}\`\n` : ""}
---
*${currentQ.question}*

${optionsText}
${answersText}

_点击按钮选择，完成所有选择后自动提交_`;
}

/**
 * Send multi-question notification to Telegram
 * Creates interactive flow for selecting multiple questions with Tab navigation
 */
export async function sendMultiQuestionNotification(
  sessionId: string,
  questions: Array<{
    header: string;
    question: string;
    options: Array<{ id: string; label: string; description?: string }>;
  }>,
  isMultiQuestion: boolean,
  cwd?: string
): Promise<void> {
  try {
    const notificationId = crypto.randomUUID().slice(0, 8);

    // Initialize state
    const state: MultiQuestionState = {
      sessionId,
      questions,
      currentIndex: 0,
      answers: [],
      cwd,
      createdAt: Date.now(),
    };
    multiQuestionStates.set(notificationId, state);

    const message = formatMultiQuestionMessage(state);
    const keyboard = createMultiQuestionKeyboard(notificationId, state);

    const result = await callApi<{ message_id: number }>("sendMessage", {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

    state.messageId = result.message_id;
    log.info(`Sent multi-question notification: ${notificationId} with ${questions.length} questions`);
  } catch (error) {
    log.error("Failed to send multi-question notification", { error: String(error) });
  }
}

/**
 * Handle multi-question option selection
 * Injects keystroke sequence for navigation
 */
export async function handleMultiQuestionCallback(
  notificationId: string,
  optionId: string,
  callbackQuery: TelegramUpdate["callback_query"]
): Promise<void> {
  const state = multiQuestionStates.get(notificationId);
  if (!state) {
    await answerCallbackQuery(callbackQuery!.id, "选择已过期");
    return;
  }

  // Find the most recently active PTY session
  const allSessions = getAllSessions();
  if (allSessions.length === 0) {
    await answerCallbackQuery(callbackQuery!.id, "没有活跃的终端会话");
    return;
  }

  const targetSession = allSessions[0];
  const currentQ = state.questions[state.currentIndex];
  const selectedOption = currentQ.options.find(o => o.id === optionId);
  const optionLabel = selectedOption?.label || optionId;

  // Record the answer
  state.answers.push(optionLabel);

  // Determine what keystroke sequence to inject
  const isLastQuestion = state.currentIndex >= state.questions.length - 1;

  if (isLastQuestion) {
    // Last question: inject option number, then Tab to Submit, then Enter
    // Use sequence task type to send multiple keys reliably
    addSequenceTask(targetSession.id, [optionId, "Tab", "Enter"]);

    log.info(`Multi-question final: "${optionId}" + Tab + Enter for ${targetSession.name}`);

    // Update message to show completion
    try {
      const finalAnswers = state.answers.map((ans, i) => {
        const header = state.questions[i].header || `问题${i + 1}`;
        return `• ${header}: ${ans}`;
      }).join("\n");

      await callApi("editMessageText", {
        chat_id: CHAT_ID,
        message_id: state.messageId,
        text: `✅ *选择完成*\n\n${finalAnswers}\n\n_已自动提交_`,
        parse_mode: "Markdown",
      });
    } catch {
      // Message might already be edited
    }

    // Clean up state
    multiQuestionStates.delete(notificationId);
  } else {
    // Not last question: inject option number, then Tab to next question
    addSequenceTask(targetSession.id, [optionId, "Tab"]);

    log.info(`Multi-question step ${state.currentIndex + 1}: "${optionId}" + Tab for ${targetSession.name}`);

    // Move to next question
    state.currentIndex++;

    // Update message with new question
    try {
      const newMessage = formatMultiQuestionMessage(state);
      const newKeyboard = createMultiQuestionKeyboard(notificationId, state);

      await callApi("editMessageText", {
        chat_id: CHAT_ID,
        message_id: state.messageId,
        text: newMessage,
        parse_mode: "Markdown",
        reply_markup: newKeyboard,
      });
    } catch (error) {
      log.error("Failed to update multi-question message", { error: String(error) });
    }
  }

  await answerCallbackQuery(callbackQuery!.id, `已选择: ${optionLabel}`);
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
    log.error("Failed to send Telegram message", { error: String(error) });
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
    log.error("Failed to send Telegram question", { error: String(error) });
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
    log.warn("Callback from unauthorized chat", { chatId: callbackQuery.message.chat.id });
    return;
  }

  const data = callbackQuery.data;

  // Handle PTY keystroke injection (format: pty:notificationId:keystroke)
  // This is for auth notifications - inject keystroke to terminal
  if (data.startsWith("pty:")) {
    const parts = data.split(":");
    const notificationId = parts[1];
    const keystroke = parts[2];

    // Find the most recently active PTY session
    const allSessions = getAllSessions();
    if (allSessions.length === 0) {
      await answerCallbackQuery(callbackQuery.id, "没有活跃的终端会话");
      await callApi("sendMessage", {
        chat_id: CHAT_ID,
        text: "⚠️ *无活跃会话*\n\n没有可接收按键的终端会话",
        parse_mode: "Markdown",
      });
      return;
    }

    const targetSession = allSessions[0];

    // Create keystroke task
    addKeystrokeTask(targetSession.id, keystroke);
    log.info(`PTY auth keystroke "${keystroke}" queued for ${targetSession.name}`);

    // Update the message to show the selection
    const keystrokeLabels: Record<string, string> = {
      "1": "✅ Yes",
      "2": "🔓 Allow All",
      "3": "❌ No",
    };
    const label = keystrokeLabels[keystroke] || keystroke;

    try {
      await callApi("editMessageText", {
        chat_id: CHAT_ID,
        message_id: callbackQuery.message.message_id,
        text: `${label}\n\n_按键已发送到 ${targetSession.name}_`,
        parse_mode: "Markdown",
      });
    } catch {
      // Message might already be edited
    }

    await answerCallbackQuery(callbackQuery.id, `已发送: ${label}`);
    return;
  }

  // Handle multi-question selection (format: mq:notificationId:optionId)
  if (data.startsWith("mq:")) {
    const parts = data.split(":");
    const notificationId = parts[1];
    const optionId = parts[2];

    await handleMultiQuestionCallback(notificationId, optionId, callbackQuery);
    return;
  }

  // Handle dynamic prompt keystroke injection (format: dyn:notificationId:keystroke:label)
  // This is for prompts detected by terminal monitoring - inject the option number
  if (data.startsWith("dyn:")) {
    const parts = data.split(":");
    const notificationId = parts[1];
    const keystroke = parts[2];
    const optionLabel = parts.slice(3).join(":"); // Label might contain ":"

    // Find the most recently active PTY session
    const allSessions = getAllSessions();
    if (allSessions.length === 0) {
      await answerCallbackQuery(callbackQuery.id, "没有活跃的终端会话");
      await callApi("sendMessage", {
        chat_id: CHAT_ID,
        text: "⚠️ *无活跃会话*\n\n没有可接收按键的终端会话",
        parse_mode: "Markdown",
      });
      return;
    }

    const targetSession = allSessions[0];

    // Create keystroke task for option selection
    addKeystrokeTask(targetSession.id, keystroke);
    log.info(`Dynamic prompt keystroke "${keystroke}" (${optionLabel}) queued for ${targetSession.name}`);

    // Update the message to show the selection
    try {
      await callApi("editMessageText", {
        chat_id: CHAT_ID,
        message_id: callbackQuery.message.message_id,
        text: `✅ *已选择: ${optionLabel}*\n\n_按键 ${keystroke} 已发送到 ${targetSession.name}_`,
        parse_mode: "Markdown",
      });
    } catch {
      // Message might already be edited
    }

    await answerCallbackQuery(callbackQuery.id, `已选择: ${optionLabel}`);
    return;
  }

  // Handle PTY question keystroke injection (format: qpty:notificationId:keystroke:label)
  // This is for question notifications - inject option number to terminal
  if (data.startsWith("qpty:")) {
    const parts = data.split(":");
    const notificationId = parts[1];
    const keystroke = parts[2];
    const optionLabel = parts.slice(3).join(":"); // Label might contain ":"

    // Find the most recently active PTY session
    const allSessions = getAllSessions();
    if (allSessions.length === 0) {
      await answerCallbackQuery(callbackQuery.id, "没有活跃的终端会话");
      await callApi("sendMessage", {
        chat_id: CHAT_ID,
        text: "⚠️ *无活跃会话*\n\n没有可接收按键的终端会话",
        parse_mode: "Markdown",
      });
      return;
    }

    const targetSession = allSessions[0];

    // Create keystroke task for option selection
    addKeystrokeTask(targetSession.id, keystroke);
    log.info(`PTY question keystroke "${keystroke}" (${optionLabel}) queued for ${targetSession.name}`);

    // Update the message to show the selection
    try {
      await callApi("editMessageText", {
        chat_id: CHAT_ID,
        message_id: callbackQuery.message.message_id,
        text: `✅ *已选择: ${optionLabel}*\n\n_按键 ${keystroke} 已发送到 ${targetSession.name}_`,
        parse_mode: "Markdown",
      });
    } catch {
      // Message might already be edited
    }

    await answerCallbackQuery(callbackQuery.id, `已选择: ${optionLabel}`);
    return;
  }

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

    // Map option ID (A, B, C...) to keystroke number (1, 2, 3...)
    // This allows PTY to simulate user selecting an option in Claude Code's terminal UI
    let keystroke: string;
    if (/^[A-Z]$/.test(optionId)) {
      // Single uppercase letter: A=1, B=2, C=3...
      keystroke = String(optionId.charCodeAt(0) - 64);
    } else if (/^\d+$/.test(optionId)) {
      // Already numeric
      keystroke = optionId;
    } else {
      log.warn(`Unexpected option ID format: ${optionId}, defaulting to "1"`);
      keystroke = "1";
    }

    // Create keystroke task for PTY injection
    // Note: request.sessionId is Claude Code's internal session ID, not PTY wrapper's session ID
    // So we use the most recently active PTY session instead
    const allSessions = getAllSessions();
    if (allSessions.length > 0) {
      const targetSession = allSessions[0];
      addKeystrokeTask(targetSession.id, keystroke, requestId);
      log.info(`Created keystroke task: "${keystroke}" for session ${targetSession.shortId}`);
    } else {
      log.warn("No active PTY session, keystroke not sent");
      // Notify user that there's no active session
      await callApi("sendMessage", {
        chat_id: CHAT_ID,
        text: "⚠️ *无活跃会话*\n\n选项已记录，但没有可接收按键的会话。\n请确保 Claude Code 正在运行。",
        parse_mode: "Markdown",
      });
    }

    resolveQuestionRequest(requestId, optionId);
    await updateMessage(request, `✅ *已选择: ${optionLabel}*`);
    await answerCallbackQuery(callbackQuery.id, `选择: ${optionLabel}`);
    return;
  }

  // Handle authorization (format: action:requestId)
  const parts = data.split(":");
  if (parts.length !== 2) {
    await answerCallbackQuery(callbackQuery.id, "Invalid callback data");
    return;
  }
  const [action, requestId] = parts;

  // Validate action
  if (!["allow", "deny", "allowall"].includes(action)) {
    await answerCallbackQuery(callbackQuery.id, "Unknown action");
    return;
  }

  // Validate requestId format (UUID)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    await answerCallbackQuery(callbackQuery.id, "Invalid request ID");
    return;
  }

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
  log.debug("processReplyMessage called", { message: JSON.stringify(message).slice(0, 200) });

  if (!message?.text || !message.reply_to_message) {
    log.debug("Skipping - no text or not a reply");
    return;
  }

  // Verify it's from the correct chat
  if (String(message.chat.id) !== CHAT_ID) {
    log.warn("Message from unauthorized chat", { chatId: message.chat.id });
    return;
  }

  const replyToMessageId = message.reply_to_message.message_id;
  log.debug("Looking for request with messageId", { messageId: replyToMessageId });

  const request = getRequestByMessageId(replyToMessageId);
  log.debug(`Found request: ${request ? request.id : "NOT FOUND"}`);

  if (!request) {
    // Not a reply to our message, ignore
    log.debug("Request not found for messageId", { messageId: replyToMessageId });
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

  // Sanitize input: strip control characters and ANSI escape sequences
  // This prevents injection of terminal control sequences
  const rawText = message.text.trim();
  const customText = rawText
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // Remove control chars (except \t, \n, \r)
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "") // Remove ANSI escape sequences
    .replace(/\x1b\][^\x07]*\x07/g, ""); // Remove OSC sequences

  // Validate custom text length
  if (customText.length > 1000) {
    await callApi("sendMessage", {
      chat_id: CHAT_ID,
      text: "⚠️ 输入过长 (最大 1000 字符)",
      reply_to_message_id: message.message_id,
    });
    return;
  }

  // Create keystroke task for custom text input
  // Use the most recently active PTY session
  const allSessions = getAllSessions();
  if (allSessions.length > 0) {
    const targetSession = allSessions[0];
    addKeystrokeTask(targetSession.id, customText, request.id);
    log.info(`Created custom keystroke task for session ${targetSession.shortId}`);
  } else {
    log.warn("No active PTY session, custom text keystroke not sent");
    // Notify user that there's no active session
    await callApi("sendMessage", {
      chat_id: CHAT_ID,
      text: "⚠️ *无活跃会话*\n\n自定义输入已记录，但没有可接收的会话。\n请确保 Claude Code 正在运行。",
      parse_mode: "Markdown",
      reply_to_message_id: message.message_id,
    });
  }

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
      log.debug("Received updates", { count: updates.length });
    }

    for (const update of updates) {
      lastUpdateId = update.update_id;

      if (update.callback_query) {
        log.debug("Processing callback_query");
        await processCallback(update.callback_query);
      }

      if (update.message) {
        log.debug(`Received message: ${update.message.text?.slice(0, 50)}`);
        log.debug(`Is reply: ${!!update.message.reply_to_message}`);
        if (update.message.reply_to_message) {
          // Reply message → custom input for questions
          await processReplyMessage(update.message);
        } else if (update.message.text?.startsWith("/sessions")) {
          // /sessions command → list active sessions
          await processSessionsCommand(update.message);
        } else if (update.message.text?.startsWith("/claude-call") || update.message.text?.startsWith("/claude_call")) {
          // /claude-call or /claude_call command → start new Claude session in date folder
          await processClaudeCallCommand(update.message);
        } else if (update.message.text && !update.message.text.startsWith("/")) {
          // Plain text message (not a command) → new task for PTY injection
          await processNewTaskMessage(update.message);
        }
      }
    }
  } catch (error) {
    log.error("Telegram polling error", { error: String(error) });
  }
}

/**
 * Start the Telegram polling loop
 */
export function startPolling(): void {
  log.info("Starting Telegram polling...");

  const poll = async () => {
    while (true) {
      try {
        await pollUpdates();
      } catch (error) {
        // Log error but continue polling
        log.error("Polling error (will retry)", { error: String(error).slice(0, 100) });
        // Wait longer on error (409 conflict needs time to resolve)
        await Bun.sleep(5000);
        continue;
      }
      // Small delay to prevent tight loop
      await Bun.sleep(100);
    }
  };

  poll().catch((err) => log.error("Poll loop error", { error: String(err) }));
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
    log.error("Failed to send test message", { error: String(error) });
    return false;
  }
}

/**
 * Set up bot commands for Telegram command menu
 * This enables "/" autocomplete in Telegram
 */
export async function setupBotCommands(): Promise<boolean> {
  try {
    await callApi("setMyCommands", {
      commands: [
        { command: "claude_call", description: "启动新的 Claude Code 会话" },
        { command: "sessions", description: "查看所有活跃会话" },
      ],
    });
    log.info("Bot commands registered");
    return true;
  } catch (error) {
    log.error("Failed to set bot commands", { error: String(error) });
    return false;
  }
}

/**
 * Send a notification message to Telegram
 * Can be used to notify task completion, errors, or any other events
 */
export async function sendNotification(
  message: string,
  options?: {
    parseMode?: "Markdown" | "HTML";
    silent?: boolean;
  }
): Promise<boolean> {
  try {
    await callApi("sendMessage", {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: options?.parseMode || "Markdown",
      disable_notification: options?.silent || false,
    });
    return true;
  } catch (error) {
    log.error("Failed to send notification", { error: String(error) });
    return false;
  }
}

/**
 * Clean up expired pending task messages and multi-question states
 */
export function cleanupPendingTaskMessages(): void {
  const now = Date.now();

  // Clean up pending task messages
  let tasksCleaned = 0;
  for (const [msgId, task] of pendingTaskMessages) {
    if (now - task.createdAt > PENDING_TASK_TIMEOUT) {
      pendingTaskMessages.delete(msgId);
      tasksCleaned++;
    }
  }
  if (tasksCleaned > 0) {
    log.info(`Cleaned up ${tasksCleaned} expired pending task message(s)`);
  }

  // Clean up multi-question states
  let mquestionsCleaned = 0;
  for (const [notificationId, state] of multiQuestionStates) {
    if (now - state.createdAt > MULTI_QUESTION_TIMEOUT) {
      multiQuestionStates.delete(notificationId);
      mquestionsCleaned++;
    }
  }
  if (mquestionsCleaned > 0) {
    log.info(`Cleaned up ${mquestionsCleaned} expired multi-question state(s)`);
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
    const createdTime = formatDateTime(s.createdAt);
    return `${i + 1}. *${s.name}* (\`${s.shortId}\`)\n   📂 ${s.cwd}\n   ⏱️ ${createdTime}`;
  }).join("\n\n");

  await callApi("sendMessage", {
    chat_id: CHAT_ID,
    text: `📋 *活跃会话 (${sessions.length})*\n\n${sessionList}\n\n_发送消息时可用 @shortId 指定会话_\n_例如: @${sessions[0].shortId} 你的任务_`,
    parse_mode: "Markdown",
    reply_to_message_id: message.message_id,
  });
}

/**
 * Format timestamp to yyyy-mm-dd HH:MM:ss
 */
function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
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
    const createdTime = formatDateTime(session.createdAt);
    rows.push([{
      text: `📱 ${session.name} (${createdTime})`,
      callback_data: `sess:${session.shortId}:${originalMsgId}`,
    }]);
  }

  return { inline_keyboard: rows };
}

/**
 * Maximum concurrent sessions allowed
 */
const MAX_CONCURRENT_SESSIONS = 5;

/**
 * Session registration timeout in milliseconds
 */
const SESSION_REGISTRATION_TIMEOUT_MS = 15000;

/**
 * Session registration poll interval in milliseconds
 */
const SESSION_POLL_INTERVAL_MS = 500;

/**
 * Wait for a session to register with matching cwd
 * Returns session or null if timeout
 */
async function waitForSessionRegistration(
  expectedCwd: string,
  maxWaitMs: number
): Promise<Session | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const sessions = getAllSessions();
    const found = sessions.find((s) => s.cwd === expectedCwd);
    if (found) {
      return found;
    }
    await Bun.sleep(SESSION_POLL_INTERVAL_MS);
  }

  return null;
}

/**
 * Extract error message from unknown error type
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Process /claude-call command - start Claude Code in date folder
 */
async function processClaudeCallCommand(message: TelegramMessage): Promise<void> {
  // Verify it's from the correct chat
  if (String(message.chat.id) !== CHAT_ID) {
    return;
  }

  // Check session limit
  const currentSessionCount = getSessionCount();
  if (currentSessionCount >= MAX_CONCURRENT_SESSIONS) {
    await callApi("sendMessage", {
      chat_id: CHAT_ID,
      text: `❌ *会话已满*\n\n当前活跃会话: ${currentSessionCount}/${MAX_CONCURRENT_SESSIONS}\n\n请先关闭一些会话后再试`,
      parse_mode: "Markdown",
      reply_to_message_id: message.message_id,
    });
    return;
  }

  // Check base directory is configured
  const baseDir = process.env.CLAUDE_CALL_BASE_DIR;
  if (!baseDir) {
    await callApi("sendMessage", {
      chat_id: CHAT_ID,
      text: "❌ *配置错误*\n\n请在 .env 文件中设置 `CLAUDE_CALL_BASE_DIR`",
      parse_mode: "Markdown",
      reply_to_message_id: message.message_id,
    });
    return;
  }

  // Create date folder name (YYYYMMDD)
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dateFolder = `${year}${month}${day}`;
  const targetDir = `${baseDir}/${dateFolder}`;

  // Validate wrapper path exists
  const wrapperPath = `${process.cwd()}/wrapper/pty-wrapper.ts`;
  if (!existsSync(wrapperPath)) {
    await callApi("sendMessage", {
      chat_id: CHAT_ID,
      text: `❌ *配置错误*\n\nPTY wrapper 文件不存在: \`${wrapperPath}\``,
      parse_mode: "Markdown",
      reply_to_message_id: message.message_id,
    });
    return;
  }

  // Create directory (mkdir with recursive is idempotent)
  try {
    await mkdir(targetDir, { recursive: true });
    log.info(`Ensured directory exists: ${targetDir}`);
  } catch (error) {
    log.error("Failed to create directory", { error: String(error) });
    await callApi("sendMessage", {
      chat_id: CHAT_ID,
      text: `❌ *目录创建失败*\n\n\`${getErrorMessage(error)}\``,
      parse_mode: "Markdown",
      reply_to_message_id: message.message_id,
    });
    return;
  }

  // Send starting message
  const startingMsg = await callApi<{ message_id: number }>("sendMessage", {
    chat_id: CHAT_ID,
    text: `🚀 *正在启动 Claude Code...*\n\n📂 目录: \`${targetDir}\`\n⏳ 等待会话注册...`,
    parse_mode: "Markdown",
    reply_to_message_id: message.message_id,
  });

  // Spawn PTY wrapper process
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const serverUrl = process.env.CLAUDE_CALL_SERVER_URL || "http://localhost:3847";

    // Spawn process in headless mode and keep handle for cleanup
    proc = Bun.spawn(["bun", "run", wrapperPath, "--headless"], {
      cwd: targetDir,
      env: {
        ...process.env,
        CLAUDE_CALL_SERVER_URL: serverUrl,
      },
      stdio: ["ignore", "ignore", "ignore"],
    });

    log.info(`Spawned PTY wrapper (pid: ${proc.pid}) for ${targetDir}`);
  } catch (error) {
    log.error("Failed to spawn wrapper", { error: String(error) });
    await callApi("editMessageText", {
      chat_id: CHAT_ID,
      message_id: startingMsg.message_id,
      text: `❌ *启动失败*\n\n\`${getErrorMessage(error)}\``,
      parse_mode: "Markdown",
    });
    return;
  }

  // Wait for session to register
  const session = await waitForSessionRegistration(targetDir, SESSION_REGISTRATION_TIMEOUT_MS);

  if (session) {
    await callApi("editMessageText", {
      chat_id: CHAT_ID,
      message_id: startingMsg.message_id,
      text: `✅ *Claude Code 已启动*\n\n📂 目录: \`${targetDir}\`\n🔑 会话: \`${session.shortId}\`\n📋 名称: ${session.name}\n\n_现在可以发送任务了!_`,
      parse_mode: "Markdown",
    });
  } else {
    // Timeout - kill the orphaned process to prevent zombies
    if (proc && proc.pid) {
      try {
        proc.kill();
        log.info(`Killed orphaned process (pid: ${proc.pid})`);
      } catch {
        // Process may have already exited
      }
    }

    await callApi("editMessageText", {
      chat_id: CHAT_ID,
      message_id: startingMsg.message_id,
      text: `⚠️ *会话注册超时*\n\n📂 目录: \`${targetDir}\`\n\n进程已清理，请检查配置后重试`,
      parse_mode: "Markdown",
    });
  }
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
    log.warn("Task message from unauthorized chat", { chatId: message.chat.id });
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
    log.info(`Task sent to ${session.name}: ${task.id.slice(0, 8)}...`);
    return;
  }

  // Multiple sessions: show selection buttons
  pendingTaskMessages.set(message.message_id, {
    text: taskText,
    messageId: message.message_id,
    createdAt: Date.now(),
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

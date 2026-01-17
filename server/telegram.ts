import type {
  PendingRequest,
  TelegramUpdate,
  TelegramInlineKeyboard,
} from "./types";
import {
  getRequest,
  resolveRequest,
  setRequestMessageId,
  setSessionAllowAll,
  isRequestTimedOut,
} from "./store";

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
 * Create inline keyboard for authorization
 */
function createKeyboard(requestId: string): TelegramInlineKeyboard {
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
 * Send authorization request to Telegram
 */
export async function sendAuthRequest(request: PendingRequest): Promise<void> {
  try {
    const message = formatAuthMessage(request);
    const keyboard = createKeyboard(request.id);

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
 * Update message after decision
 */
export async function updateMessage(
  request: PendingRequest,
  statusText: string
): Promise<void> {
  if (!request.messageId) return;

  try {
    const sessionShort = request.sessionId.slice(0, 8);
    const text = `${statusText}

📋 Tool: \`${request.toolName}\`
🔑 Session: \`${sessionShort}...\``;

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

  const [action, requestId] = callbackQuery.data.split(":");
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
    resolveRequest(requestId, "deny");
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

  resolveRequest(requestId, decision);
  await updateMessage(request, statusText);
  await answerCallbackQuery(callbackQuery.id, decision === "allow" ? "Allowed" : "Denied");
}

/**
 * Poll for Telegram updates (long polling)
 */
export async function pollUpdates(): Promise<void> {
  try {
    const updates = await callApi<TelegramUpdate[]>("getUpdates", {
      offset: lastUpdateId + 1,
      timeout: 10,
      allowed_updates: ["callback_query"],
    });

    for (const update of updates) {
      lastUpdateId = update.update_id;

      if (update.callback_query) {
        await processCallback(update.callback_query);
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
      await pollUpdates();
      // Small delay to prevent tight loop on errors
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

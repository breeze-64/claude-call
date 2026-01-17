/**
 * Pending authorization request
 */
export interface PendingRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd?: string;
  messageId?: number;
  createdAt: number;
  resolved: boolean;
  decision?: "allow" | "deny";
}

/**
 * Session state for "Allow All" functionality
 */
export interface SessionState {
  allowAll: boolean;
  allowedTools: Set<string>;
  createdAt: number;
}

/**
 * Input from Claude Code hook
 */
export interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  hook_event_name: string;
  cwd?: string;
  permission_mode?: string;
}

/**
 * Output to Claude Code hook
 */
export interface HookOutput {
  hookSpecificOutput?: {
    permissionDecision: "allow" | "deny" | "ask";
    updatedInput?: Record<string, unknown>;
  };
  systemMessage?: string;
}

/**
 * Authorization request from hook to server
 */
export interface AuthorizeRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd?: string;
}

/**
 * Authorization response from server to hook
 */
export interface AuthorizeResponse {
  requestId: string;
  status: "pending" | "resolved";
  decision?: "allow" | "deny";
}

/**
 * Poll response from server to hook
 */
export interface PollResponse {
  status: "pending" | "resolved" | "timeout" | "not_found";
  decision?: "allow" | "deny";
  elapsed?: number;
  message?: string;
}

/**
 * Telegram Update (simplified)
 */
export interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
}

/**
 * Telegram Callback Query
 */
export interface TelegramCallbackQuery {
  id: string;
  from: {
    id: number;
    username?: string;
  };
  message?: {
    message_id: number;
    chat: {
      id: number;
    };
  };
  data?: string;
}

/**
 * Telegram Inline Keyboard
 */
export interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{
    text: string;
    callback_data: string;
  }>>;
}

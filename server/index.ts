import type { AuthorizeRequest, AuthorizeResponse, PollResponse } from "./types";
import {
  createAuthRequest,
  createQuestionRequest,
  getRequest,
  isSessionAllowAll,
  isRequestTimedOut,
  resolveAuthRequest,
  cancelRequest,
  cleanupStale,
  getAllPendingRequests,
} from "./store";
import {
  sendAuthRequest,
  sendQuestionRequest,
  sendAuthNotification,
  sendQuestionNotification,
  sendDynamicPromptNotification,
  sendMultiQuestionNotification,
  updateMessage,
  startPolling,
  sendTestMessage,
  setupBotCommands,
  cleanupPendingTaskMessages,
  sendNotification,
} from "./telegram";
import {
  getPendingTasks,
  acknowledgeTask,
  cleanupTasks,
  getTaskStats,
  registerSession,
  unregisterSession,
  getAllSessions,
  getSession,
  type TaskCompletion,
} from "./task-queue";
import { createLogger } from "./logger";

const PORT = Number(process.env.AUTH_SERVER_PORT) || 3847;

const log = createLogger("Server");

/**
 * Parse JSON body from request
 */
async function parseBody<T>(req: Request): Promise<T | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/**
 * Create JSON response
 */
function jsonResponse(data: object, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle POST /authorize
 */
async function handleAuthorize(req: Request): Promise<Response> {
  const body = await parseBody<AuthorizeRequest>(req);
  if (!body) {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const { sessionId, toolInput, cwd, type, question, options } = body;
  let { toolName } = body;

  // Log full request body for debugging
  log.debug(`Authorize request: toolName="${toolName}" body=${JSON.stringify(body).slice(0, 500)}`);

  log.info(`Received: toolName=${toolName}, sessionId=${sessionId?.slice(0, 8)}, type=${type || "auth"}`);
  if (toolInput) {
    log.debug(`toolInput keys: ${Object.keys(toolInput).join(", ")}`);
  }

  if (!sessionId) {
    log.warn("Missing sessionId");
    return jsonResponse({ error: "Missing sessionId" }, 400);
  }

  // Infer toolName from toolInput if missing
  if (!toolName) {
    log.debug("toolName is missing, attempting to infer from toolInput");
    if (toolInput) {
      if ("command" in toolInput) {
        toolName = "Bash";
        log.debug('Inferred toolName as "Bash" from command field');
      } else if ("file_path" in toolInput && ("new_string" in toolInput || "old_string" in toolInput)) {
        toolName = "Edit";
        log.debug('Inferred toolName as "Edit" from file_path + new_string/old_string');
      } else if ("file_path" in toolInput && "content" in toolInput) {
        toolName = "Write";
        log.debug('Inferred toolName as "Write" from file_path + content');
      } else if ("questions" in toolInput) {
        toolName = "AskUserQuestion";
        log.debug('Inferred toolName as "AskUserQuestion" from questions field');
      } else {
        log.debug('Could not infer toolName, using "未知工具"');
      }
    }
  }

  // Check if this is a question request
  if (type === "question" && question && options) {
    // Create question request
    const request = createQuestionRequest(
      sessionId,
      toolName,
      toolInput,
      question,
      options,
      cwd
    );

    // Send Telegram message (don't await - let it run async)
    sendQuestionRequest(request);

    const response: AuthorizeResponse = {
      requestId: request.id,
      status: "pending",
    };
    return jsonResponse(response);
  }

  // Authorization request
  // Check if session has "Allow All" enabled
  if (isSessionAllowAll(sessionId)) {
    const response: AuthorizeResponse = {
      requestId: crypto.randomUUID(),
      status: "resolved",
      decision: "allow",
    };
    return jsonResponse(response);
  }

  // Create pending request
  const request = createAuthRequest(sessionId, toolName, toolInput, cwd);

  // Send Telegram message (don't await - let it run async)
  sendAuthRequest(request);

  const response: AuthorizeResponse = {
    requestId: request.id,
    status: "pending",
  };
  return jsonResponse(response);
}

/**
 * Handle GET /poll/:requestId
 */
function handlePoll(requestId: string): Response {
  const request = getRequest(requestId);

  if (!request) {
    const response: PollResponse = { status: "not_found" };
    return jsonResponse(response, 404);
  }

  // IMPORTANT: Check resolved FIRST - user may have replied just before timeout
  if (request.resolved) {
    const response: PollResponse = {
      status: "resolved",
      decision: request.decision,
      selectedOption: request.selectedOption,
    };
    return jsonResponse(response);
  }

  // Check timeout only if not resolved
  if (isRequestTimedOut(request)) {
    if (request.type === "authorization") {
      // For authorization: return timeout and deny
      resolveAuthRequest(requestId, "deny");
      updateMessage(request, "⏱️ *Timeout - Denied*");
      const response: PollResponse = {
        status: "timeout",
        decision: "deny",
        message: "Authorization timeout",
      };
      return jsonResponse(response);
    }
    // For question: DON'T return timeout - let hook continue waiting
    // User may still reply via Telegram
  }

  const elapsed = Date.now() - request.createdAt;
  const response: PollResponse = {
    status: "pending",
    elapsed,
  };
  return jsonResponse(response);
}

/**
 * Handle GET /health
 */
function handleHealth(): Response {
  return jsonResponse({
    status: "ok",
    timestamp: new Date().toISOString(),
    pendingRequests: getAllPendingRequests().length,
  });
}

/**
 * Handle GET /status (debug)
 */
function handleStatus(): Response {
  return jsonResponse({
    pendingRequests: getAllPendingRequests(),
  });
}

/**
 * Main request handler
 */
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // CORS headers for local development
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let response: Response;

  try {
    if (path === "/auth-notify" && method === "POST") {
      // Auth notification endpoint for PTY keystroke injection flow
      // This sends a notification to Telegram and returns immediately
      const body = await parseBody<{
        sessionId: string;
        toolName: string;
        toolInput: Record<string, unknown>;
        cwd?: string;
      }>(req);

      log.info(`Auth-Notify received: sessionId=${body?.sessionId?.slice(0, 8)}, toolName=${body?.toolName}, cwd=${body?.cwd}`);

      if (!body?.sessionId) {
        log.warn("Auth-Notify: Missing sessionId");
        response = jsonResponse({ error: "Missing sessionId" }, 400);
      } else {
        // Send notification to Telegram (fire and forget)
        sendAuthNotification(
          body.sessionId,
          body.toolName || "未知工具",
          body.toolInput || {},
          body.cwd
        );
        response = jsonResponse({ success: true, message: "Notification sent" });
      }
    } else if (path === "/question-notify" && method === "POST") {
      // Question notification endpoint for PTY keystroke injection flow
      // Sends question with option buttons, returns immediately
      // User selection triggers keystroke injection via PTY
      const body = await parseBody<{
        sessionId: string;
        question: string;
        options: Array<{ id: string; label: string; description?: string }>;
        cwd?: string;
      }>(req);

      log.info(`Question-Notify received: sessionId=${body?.sessionId?.slice(0, 8)}, question=${body?.question?.slice(0, 30)}`);

      if (!body?.sessionId || !body?.question || !body?.options) {
        log.warn("Question-Notify: Missing required fields");
        response = jsonResponse({ error: "Missing sessionId, question, or options" }, 400);
      } else {
        // Send notification to Telegram (fire and forget)
        sendQuestionNotification(
          body.sessionId,
          body.question,
          body.options,
          body.cwd
        );
        response = jsonResponse({ success: true, message: "Question notification sent" });
      }
    } else if (path === "/authorize" && method === "POST") {
      response = await handleAuthorize(req);
    } else if (path.startsWith("/poll/") && method === "GET") {
      const requestId = path.split("/")[2];
      response = handlePoll(requestId);
    } else if (path === "/health" && method === "GET") {
      response = handleHealth();
    } else if (path === "/status" && method === "GET") {
      response = handleStatus();
    } else if (path === "/sessions" && method === "GET") {
      // List all active sessions
      response = jsonResponse({ sessions: getAllSessions() });
    } else if (path === "/sessions/register" && method === "POST") {
      // Register a new PTY session
      const body = await parseBody<{ name?: string; cwd?: string }>(req);
      const session = registerSession(body?.name, body?.cwd);
      response = jsonResponse({ session });
    } else if (path.match(/^\/sessions\/[^/]+\/unregister$/) && method === "POST") {
      // Unregister a PTY session
      const sessionId = path.split("/")[2];
      const success = unregisterSession(sessionId);
      response = jsonResponse({ success });
    } else if (path.match(/^\/tasks\/pending\/[^/]+$/) && method === "GET") {
      // Get pending tasks for a specific session
      const sessionId = path.split("/")[3];
      const session = getSession(sessionId);
      if (!session) {
        response = jsonResponse({ error: "Session not found" }, 404);
      } else {
        response = jsonResponse(getPendingTasks(session.id));
      }
    } else if (path.startsWith("/tasks/") && path.endsWith("/ack") && method === "POST") {
      // Acknowledge task as processed with optional status
      const taskId = path.split("/")[2];
      const body = await parseBody<{ success?: boolean; error?: string }>(req);

      const completion: TaskCompletion | undefined = body
        ? { success: body.success !== false, error: body.error }
        : undefined;

      const result = acknowledgeTask(taskId, completion);

      if (result) {
        const { task, session } = result;
        const sessionName = session?.name || "未知会话";
        const preview = task.message.length > 30 ? task.message.slice(0, 30) + "..." : task.message;

        // Send notification based on status
        if (completion?.success === false) {
          // Task failed
          const errorMsg = completion.error || "未知错误";
          await sendNotification(
            `❌ *任务注入失败*\n\n📋 会话: ${sessionName}\n📝 任务: \`${preview}\`\n⚠️ 错误: ${errorMsg}`,
            { silent: false }
          );
        } else if (task.type !== "keystroke") {
          // Task succeeded (only notify for regular tasks, not keystroke tasks)
          await sendNotification(
            `✅ *任务已注入终端*\n\n📋 会话: ${sessionName}\n📝 任务: \`${preview}\``,
            { silent: true }
          );
        }
        // Note: keystroke tasks (option selections) don't need completion notification
        // because the question message already gets updated with the selection

        response = jsonResponse({ success: true });
      } else {
        response = jsonResponse({ success: false });
      }
    } else if (path === "/tasks/stats" && method === "GET") {
      // Get task queue stats (for debugging)
      response = jsonResponse(getTaskStats());
    } else if (path.match(/^\/cancel\/[^/]+$/) && method === "POST") {
      // Cancel a request (used by hook when timing out)
      const requestId = path.split("/")[2];
      const request = cancelRequest(requestId);
      if (request) {
        // Update Telegram message to show timeout
        const statusText = request.type === "question"
          ? "⏱️ *超时 - 请在终端选择*"
          : "⏱️ *超时 - 已拒绝*";
        updateMessage(request, statusText);
        response = jsonResponse({ success: true, cancelled: true });
      } else {
        // Request not found or already resolved
        response = jsonResponse({ success: false, cancelled: false });
      }
    } else if (path === "/notify" && method === "POST") {
      // Generic notification endpoint (used by PTY wrapper for health/status updates)
      const body = await parseBody<{ message: string; silent?: boolean }>(req);
      if (body?.message) {
        await sendNotification(body.message, { silent: body.silent });
        response = jsonResponse({ success: true });
      } else {
        response = jsonResponse({ error: "Missing message" }, 400);
      }
    } else if (path === "/multi-question-notify" && method === "POST") {
      // Multi-question notification endpoint for AskUserQuestion with multiple questions
      // Sends all questions to Telegram, handles Tab navigation between questions
      const body = await parseBody<{
        sessionId: string;
        questions: Array<{
          header: string;
          question: string;
          options: Array<{ id: string; label: string; description?: string }>;
        }>;
        isMultiQuestion: boolean;
        cwd?: string;
      }>(req);

      log.info(`Multi-Question-Notify received: sessionId=${body?.sessionId?.slice(0, 8)}, questions=${body?.questions?.length}, multi=${body?.isMultiQuestion}`);

      if (!body?.sessionId || !body?.questions || body.questions.length === 0) {
        log.warn("Multi-Question-Notify: Missing required fields");
        response = jsonResponse({ error: "Missing sessionId or questions" }, 400);
      } else {
        // Send multi-question notification to Telegram
        await sendMultiQuestionNotification(
          body.sessionId,
          body.questions,
          body.isMultiQuestion,
          body.cwd
        );
        response = jsonResponse({ success: true, message: "Multi-question notification sent" });
      }
    } else if (path === "/prompt-detected" && method === "POST") {
      // Dynamic prompt detection endpoint (used by PTY wrapper terminal monitoring)
      // Sends notification with actual options detected from terminal
      const body = await parseBody<{
        sessionId: string;
        type: "permission" | "question" | "unknown";
        title: string;
        options: Array<{ number: string; label: string }>;
        rawContent: string;
        cwd?: string;
      }>(req);

      log.info(`Prompt-Detected: type=${body?.type}, title="${body?.title?.slice(0, 30)}", options=${body?.options?.length}`);

      if (!body?.sessionId || !body?.options || body.options.length === 0) {
        log.warn("Prompt-Detected: Missing required fields");
        response = jsonResponse({ error: "Missing sessionId or options" }, 400);
      } else {
        // Send dynamic prompt notification to Telegram
        await sendDynamicPromptNotification(
          body.sessionId,
          body.type,
          body.title,
          body.options,
          body.cwd
        );
        response = jsonResponse({ success: true, message: "Prompt notification sent" });
      }
    } else {
      response = jsonResponse({ error: "Not found" }, 404);
    }
  } catch (error) {
    log.error("Request error", { error: String(error) });
    response = jsonResponse({ error: "Internal server error" }, 500);
  }

  // Add CORS headers to response
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }

  return response;
}

/**
 * Start the server
 */
async function main() {
  log.info(`
╔═══════════════════════════════════════════════════╗
║          Claude-Call Authorization Server         ║
╠═══════════════════════════════════════════════════╣
║  Telegram integration for Claude Code             ║
║  • Tool authorization via buttons                 ║
║  • Multi-option question support                  ║
║  • Multi-session task injection                   ║
╚═══════════════════════════════════════════════════╝
`);

  // Verify Telegram connection
  log.info("Verifying Telegram connection...");
  const connected = await sendTestMessage();
  if (!connected) {
    log.fatal("Failed to connect to Telegram. Check your bot token and chat ID.");
    process.exit(1);
  }
  log.info("Telegram connection verified");

  // Set up bot commands for "/" autocomplete
  await setupBotCommands();

  // Start Telegram polling
  startPolling();

  // Start cleanup interval (requests, tasks, and pending messages)
  setInterval(() => {
    cleanupStale();
    cleanupTasks();
    cleanupPendingTaskMessages();
  }, 60000);

  // Start HTTP server
  const server = Bun.serve({
    port: PORT,
    fetch: handleRequest,
  });

  log.info(`Server listening on http://localhost:${server.port}`);
  log.info(`
Ready to receive authorization requests!
Hook endpoint: POST http://localhost:${server.port}/authorize
`);
}

main().catch((err) => log.fatal("Main process error", { error: String(err) }));

import type { AuthorizeRequest, AuthorizeResponse, PollResponse } from "./types";
import {
  createAuthRequest,
  createQuestionRequest,
  getRequest,
  isSessionAllowAll,
  isRequestTimedOut,
  resolveAuthRequest,
  cleanupStale,
  getAllPendingRequests,
} from "./store";
import {
  sendAuthRequest,
  sendQuestionRequest,
  updateMessage,
  startPolling,
  sendTestMessage,
  cleanupPendingTaskMessages,
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
} from "./task-queue";

const PORT = Number(process.env.AUTH_SERVER_PORT) || 3847;

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

  const { sessionId, toolName, toolInput, cwd, type, question, options } = body;

  // Log request details for debugging
  console.log(`[Authorize] Received: toolName=${toolName}, sessionId=${sessionId?.slice(0, 8)}, type=${type || "auth"}`);

  if (!sessionId || !toolName) {
    console.log(`[Authorize] Missing fields: sessionId=${!!sessionId}, toolName=${!!toolName}`);
    return jsonResponse({ error: "Missing required fields" }, 400);
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
    if (path === "/authorize" && method === "POST") {
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
      // Acknowledge task as processed
      const taskId = path.split("/")[2];
      const success = acknowledgeTask(taskId);
      response = jsonResponse({ success });
    } else if (path === "/tasks/stats" && method === "GET") {
      // Get task queue stats (for debugging)
      response = jsonResponse(getTaskStats());
    } else {
      response = jsonResponse({ error: "Not found" }, 404);
    }
  } catch (error) {
    console.error("Request error:", error);
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
  console.log(`
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
  console.log("Verifying Telegram connection...");
  const connected = await sendTestMessage();
  if (!connected) {
    console.error("Failed to connect to Telegram. Check your bot token and chat ID.");
    process.exit(1);
  }
  console.log("✓ Telegram connection verified");

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

  console.log(`✓ Server listening on http://localhost:${server.port}`);
  console.log(`
Ready to receive authorization requests!
Hook endpoint: POST http://localhost:${server.port}/authorize
`);
}

main().catch(console.error);

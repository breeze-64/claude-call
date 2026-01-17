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
} from "./telegram";

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

  if (!sessionId || !toolName) {
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

  // Check timeout
  if (isRequestTimedOut(request) && !request.resolved) {
    if (request.type === "authorization") {
      resolveAuthRequest(requestId, "deny");
      updateMessage(request, "⏱️ *Timeout - Denied*");
    } else {
      updateMessage(request, "⏱️ *Timeout*");
    }

    const response: PollResponse = {
      status: "timeout",
      decision: request.type === "authorization" ? "deny" : undefined,
      message: "Authorization timeout",
    };
    return jsonResponse(response);
  }

  if (request.resolved) {
    const response: PollResponse = {
      status: "resolved",
      decision: request.decision,
      selectedOption: request.selectedOption,
    };
    return jsonResponse(response);
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
║  Telegram Button Authorization for Claude Code    ║
║  Now with multi-option question support!          ║
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

  // Start cleanup interval
  setInterval(cleanupStale, 60000);

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

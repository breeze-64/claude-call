import type { PendingRequest, SessionState } from "./types";

/**
 * In-memory store for pending authorization requests
 */
const pendingRequests = new Map<string, PendingRequest>();

/**
 * In-memory store for session states (Allow All)
 */
const sessionStates = new Map<string, SessionState>();

/**
 * Timeout for requests in milliseconds
 */
const REQUEST_TIMEOUT = Number(process.env.AUTH_TIMEOUT_MS) || 30000;

/**
 * Session TTL in milliseconds (1 hour)
 */
const SESSION_TTL = 60 * 60 * 1000;

/**
 * Create a new pending request
 */
export function createRequest(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd?: string
): PendingRequest {
  const request: PendingRequest = {
    id: crypto.randomUUID(),
    sessionId,
    toolName,
    toolInput,
    cwd,
    createdAt: Date.now(),
    resolved: false,
  };
  pendingRequests.set(request.id, request);
  return request;
}

/**
 * Get a pending request by ID
 */
export function getRequest(requestId: string): PendingRequest | undefined {
  return pendingRequests.get(requestId);
}

/**
 * Resolve a request with a decision
 */
export function resolveRequest(
  requestId: string,
  decision: "allow" | "deny"
): boolean {
  const request = pendingRequests.get(requestId);
  if (!request || request.resolved) {
    return false;
  }
  request.resolved = true;
  request.decision = decision;
  return true;
}

/**
 * Update message ID for a request
 */
export function setRequestMessageId(requestId: string, messageId: number): void {
  const request = pendingRequests.get(requestId);
  if (request) {
    request.messageId = messageId;
  }
}

/**
 * Check if a request has timed out
 */
export function isRequestTimedOut(request: PendingRequest): boolean {
  return Date.now() - request.createdAt > REQUEST_TIMEOUT;
}

/**
 * Get or create session state
 */
export function getSessionState(sessionId: string): SessionState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = {
      allowAll: false,
      allowedTools: new Set(),
      createdAt: Date.now(),
    };
    sessionStates.set(sessionId, state);
  }
  return state;
}

/**
 * Set "Allow All" for a session
 */
export function setSessionAllowAll(sessionId: string): void {
  const state = getSessionState(sessionId);
  state.allowAll = true;
}

/**
 * Check if session has "Allow All" enabled
 */
export function isSessionAllowAll(sessionId: string): boolean {
  const state = sessionStates.get(sessionId);
  return state?.allowAll ?? false;
}

/**
 * Clean up a session
 */
export function cleanupSession(sessionId: string): void {
  sessionStates.delete(sessionId);
  // Also clean up any pending requests for this session
  for (const [id, request] of pendingRequests) {
    if (request.sessionId === sessionId) {
      pendingRequests.delete(id);
    }
  }
}

/**
 * Clean up old requests and sessions (called periodically)
 */
export function cleanupStale(): void {
  const now = Date.now();

  // Clean up timed out requests
  for (const [id, request] of pendingRequests) {
    if (now - request.createdAt > REQUEST_TIMEOUT * 2) {
      pendingRequests.delete(id);
    }
  }

  // Clean up old sessions
  for (const [id, state] of sessionStates) {
    if (now - state.createdAt > SESSION_TTL) {
      sessionStates.delete(id);
    }
  }
}

/**
 * Get all pending requests (for debugging)
 */
export function getAllPendingRequests(): PendingRequest[] {
  return Array.from(pendingRequests.values());
}

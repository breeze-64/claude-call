import type { PendingRequest, SessionState, RequestType, QuestionOption } from "./types";

/**
 * In-memory store for pending requests
 */
const pendingRequests = new Map<string, PendingRequest>();

/**
 * In-memory store for session states (Allow All)
 */
const sessionStates = new Map<string, SessionState>();

/**
 * Timeout for requests in milliseconds (10 minutes max)
 */
const REQUEST_TIMEOUT = Number(process.env.AUTH_TIMEOUT_MS) || 600000;

/**
 * Session TTL in milliseconds (1 hour)
 */
const SESSION_TTL = 60 * 60 * 1000;

/**
 * Create a new authorization request
 */
export function createAuthRequest(
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
    type: "authorization",
  };
  pendingRequests.set(request.id, request);
  return request;
}

/**
 * Create a new question request
 */
export function createQuestionRequest(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  question: string,
  options: QuestionOption[],
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
    type: "question",
    question,
    options,
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
 * Get a pending request by Telegram message ID
 */
export function getRequestByMessageId(messageId: number): PendingRequest | undefined {
  for (const request of pendingRequests.values()) {
    if (request.messageId === messageId) {
      return request;
    }
  }
  return undefined;
}

/**
 * Resolve an authorization request with a decision
 */
export function resolveAuthRequest(
  requestId: string,
  decision: "allow" | "deny"
): boolean {
  const request = pendingRequests.get(requestId);
  if (!request || request.resolved || request.type !== "authorization") {
    return false;
  }
  request.resolved = true;
  request.decision = decision;
  return true;
}

/**
 * Resolve a question request with selected option
 */
export function resolveQuestionRequest(
  requestId: string,
  selectedOption: string
): boolean {
  const request = pendingRequests.get(requestId);
  if (!request || request.resolved || request.type !== "question") {
    return false;
  }
  request.resolved = true;
  request.selectedOption = selectedOption;
  return true;
}

/**
 * Cancel a request (mark as timed out/cancelled)
 * Returns the request if found and not already resolved
 */
export function cancelRequest(requestId: string): PendingRequest | null {
  const request = pendingRequests.get(requestId);
  if (!request || request.resolved) {
    return null;
  }
  request.resolved = true;
  request.cancelled = true;
  return request;
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

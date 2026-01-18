/**
 * Task Queue and Session Registry for PTY injection
 *
 * Manages:
 * 1. Active PTY sessions (register/unregister)
 * 2. Tasks per session for PTY injection
 */

export interface PendingTask {
  id: string;
  sessionId: string;
  message: string;
  createdAt: number;
  acknowledged: boolean;
  type?: "message" | "keystroke";  // Task type: message (default) or keystroke for PTY key injection
  requestId?: string;               // Associated request ID (for AskUserQuestion answers)
}

export interface Session {
  id: string;
  shortId: string;
  name: string;
  cwd: string;
  createdAt: number;
  lastActivity: number;
}

// Task storage: taskId -> Task
const tasks = new Map<string, PendingTask>();

// Session registry: sessionId -> Session
const sessions = new Map<string, Session>();

// Task timeout: 10 minutes
const TASK_TIMEOUT = 10 * 60 * 1000;

// Cleanup delay after acknowledgment: 5 minutes
const CLEANUP_DELAY = 5 * 60 * 1000;

// Session timeout: 1 hour of inactivity
const SESSION_TIMEOUT = 60 * 60 * 1000;

// ========== Session Management ==========

/**
 * Generate a short ID from UUID
 */
function generateShortId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Register a new PTY session
 */
export function registerSession(name?: string, cwd?: string): Session {
  const id = crypto.randomUUID();
  const shortId = id.slice(0, 8);

  const session: Session = {
    id,
    shortId,
    name: name || `claude-${shortId}`,
    cwd: cwd || process.cwd(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };

  sessions.set(id, session);
  console.log(`[Session] Registered: ${session.name} (${shortId})`);
  return session;
}

/**
 * Unregister a PTY session
 */
export function unregisterSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (session) {
    sessions.delete(sessionId);
    // Also clean up pending tasks for this session
    for (const [taskId, task] of tasks) {
      if (task.sessionId === sessionId) {
        tasks.delete(taskId);
      }
    }
    console.log(`[Session] Unregistered: ${session.name}`);
    return true;
  }
  return false;
}

/**
 * Get a session by ID (full or short)
 */
export function getSession(idOrShortId: string): Session | undefined {
  // Try full ID first
  if (sessions.has(idOrShortId)) {
    return sessions.get(idOrShortId);
  }
  // Try short ID
  for (const session of sessions.values()) {
    if (session.shortId === idOrShortId) {
      return session;
    }
  }
  return undefined;
}

/**
 * Get all active sessions
 */
export function getAllSessions(): Session[] {
  return Array.from(sessions.values()).sort(
    (a, b) => b.lastActivity - a.lastActivity
  );
}

/**
 * Update session last activity time
 */
export function touchSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastActivity = Date.now();
  }
}

/**
 * Get session count
 */
export function getSessionCount(): number {
  return sessions.size;
}

// ========== Task Management ==========

/**
 * Add a new task to the queue for a specific session
 */
export function addTask(sessionId: string, message: string): PendingTask {
  const task: PendingTask = {
    id: crypto.randomUUID(),
    sessionId,
    message: message.trim(),
    createdAt: Date.now(),
    acknowledged: false,
  };
  tasks.set(task.id, task);

  // Update session activity
  touchSession(sessionId);

  const session = sessions.get(sessionId);
  const sessionName = session?.name || sessionId.slice(0, 8);
  console.log(
    `[TaskQueue] Task added for ${sessionName}: ${task.id.slice(0, 8)}... "${task.message.slice(0, 50)}"`
  );
  return task;
}

/**
 * Add a keystroke task for PTY injection (for AskUserQuestion answers)
 * Keystrokes are injected directly into the terminal without Enter key
 */
export function addKeystrokeTask(
  sessionId: string,
  keystroke: string,
  requestId?: string
): PendingTask {
  const task: PendingTask = {
    id: crypto.randomUUID(),
    sessionId,
    message: keystroke,
    createdAt: Date.now(),
    acknowledged: false,
    type: "keystroke",
    requestId,
  };
  tasks.set(task.id, task);
  touchSession(sessionId);

  const session = sessions.get(sessionId);
  const sessionName = session?.name || sessionId.slice(0, 8);
  console.log(
    `[TaskQueue] Keystroke task added for ${sessionName}: "${keystroke}"`
  );
  return task;
}

/**
 * Add task to a session (by short ID or full ID)
 * Returns null if session not found
 */
export function addTaskToSession(
  sessionIdOrShortId: string,
  message: string
): PendingTask | null {
  const session = getSession(sessionIdOrShortId);
  if (!session) {
    return null;
  }
  return addTask(session.id, message);
}

/**
 * Add task to the default session (most recent active, or single session)
 * Returns null if no sessions available
 */
export function addTaskToDefaultSession(message: string): {
  task: PendingTask;
  session: Session;
} | null {
  const allSessions = getAllSessions();
  if (allSessions.length === 0) {
    return null;
  }
  // Use most recently active session
  const session = allSessions[0];
  const task = addTask(session.id, message);
  return { task, session };
}

/**
 * Get all pending (unacknowledged) tasks for a specific session
 * Keystroke tasks are prioritized over regular message tasks
 */
export function getPendingTasks(sessionId: string): PendingTask[] {
  const pending = Array.from(tasks.values())
    .filter((t) => t.sessionId === sessionId && !t.acknowledged)
    .sort((a, b) => {
      // Keystroke tasks first (higher priority for responsive UI interaction)
      if (a.type === "keystroke" && b.type !== "keystroke") return -1;
      if (a.type !== "keystroke" && b.type === "keystroke") return 1;
      // Then by creation time (oldest first)
      return a.createdAt - b.createdAt;
    });

  if (pending.length > 0) {
    console.log(
      `[TaskQueue] Returning ${pending.length} pending task(s) for session ${sessionId.slice(0, 8)}`
    );
  }
  return pending;
}

/**
 * Acknowledge that a task has been processed
 */
export function acknowledgeTask(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (task) {
    task.acknowledged = true;
    console.log(`[TaskQueue] Task acknowledged: ${taskId.slice(0, 8)}...`);

    // Update session activity
    touchSession(task.sessionId);

    // Schedule cleanup after delay
    setTimeout(() => {
      tasks.delete(taskId);
      console.log(`[TaskQueue] Task cleaned up: ${taskId.slice(0, 8)}...`);
    }, CLEANUP_DELAY);

    return true;
  }
  return false;
}

/**
 * Get a task by ID
 */
export function getTask(taskId: string): PendingTask | undefined {
  return tasks.get(taskId);
}

/**
 * Clean up expired tasks and inactive sessions (called periodically)
 */
export function cleanupTasks(): void {
  const now = Date.now();
  let cleanedTasks = 0;
  let cleanedSessions = 0;

  // Clean up expired tasks
  for (const [id, task] of tasks) {
    if (now - task.createdAt > TASK_TIMEOUT) {
      tasks.delete(id);
      cleanedTasks++;
    }
  }

  // Clean up inactive sessions
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      sessions.delete(id);
      cleanedSessions++;
    }
  }

  if (cleanedTasks > 0 || cleanedSessions > 0) {
    console.log(
      `[Cleanup] Removed ${cleanedTasks} task(s), ${cleanedSessions} session(s)`
    );
  }
}

/**
 * Get task queue stats (for debugging)
 */
export function getTaskStats(): {
  totalTasks: number;
  pendingTasks: number;
  acknowledgedTasks: number;
  activeSessions: number;
} {
  const allTasks = Array.from(tasks.values());
  return {
    totalTasks: allTasks.length,
    pendingTasks: allTasks.filter((t) => !t.acknowledged).length,
    acknowledgedTasks: allTasks.filter((t) => t.acknowledged).length,
    activeSessions: sessions.size,
  };
}

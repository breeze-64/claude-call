/**
 * Task Queue for PTY injection
 *
 * Manages tasks sent from Telegram that need to be injected into Claude Code's PTY.
 * Tasks are stored in memory and cleaned up after processing or timeout.
 */

export interface PendingTask {
  id: string;
  message: string;
  createdAt: number;
  acknowledged: boolean;
}

const tasks = new Map<string, PendingTask>();

// Task timeout: 10 minutes
const TASK_TIMEOUT = 10 * 60 * 1000;

// Cleanup delay after acknowledgment: 5 minutes
const CLEANUP_DELAY = 5 * 60 * 1000;

/**
 * Add a new task to the queue
 */
export function addTask(message: string): PendingTask {
  const task: PendingTask = {
    id: crypto.randomUUID(),
    message: message.trim(),
    createdAt: Date.now(),
    acknowledged: false,
  };
  tasks.set(task.id, task);
  console.log(`[TaskQueue] Task added: ${task.id.slice(0, 8)}... "${task.message.slice(0, 50)}"`);
  return task;
}

/**
 * Get all pending (unacknowledged) tasks
 */
export function getPendingTasks(): PendingTask[] {
  const pending = Array.from(tasks.values())
    .filter((t) => !t.acknowledged)
    .sort((a, b) => a.createdAt - b.createdAt); // Oldest first

  if (pending.length > 0) {
    console.log(`[TaskQueue] Returning ${pending.length} pending task(s)`);
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
 * Clean up expired tasks (called periodically)
 */
export function cleanupTasks(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, task] of tasks) {
    // Remove tasks older than timeout
    if (now - task.createdAt > TASK_TIMEOUT) {
      tasks.delete(id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[TaskQueue] Cleaned up ${cleaned} expired task(s)`);
  }
}

/**
 * Get task queue stats (for debugging)
 */
export function getTaskStats(): { total: number; pending: number; acknowledged: number } {
  const all = Array.from(tasks.values());
  return {
    total: all.length,
    pending: all.filter((t) => !t.acknowledged).length,
    acknowledged: all.filter((t) => t.acknowledged).length,
  };
}

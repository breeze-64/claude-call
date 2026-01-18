#!/usr/bin/env bun
/**
 * PTY Wrapper for Claude Code using tmux
 *
 * Uses tmux for reliable task injection:
 * 1. Creates a tmux session running claude
 * 2. Attaches to the session (user sees claude interface)
 * 3. Uses `tmux send-keys` to inject tasks from Telegram
 *
 * This is the most reliable approach - tmux is battle-tested.
 */

import { $ } from "bun";

const SERVER_URL = process.env.CLAUDE_CALL_SERVER_URL || "http://localhost:3847";
const POLL_INTERVAL = 1000;
const SESSION_NAME = "claude-call";

interface PendingTask {
  id: string;
  message: string;
  createdAt: number;
}

let isShuttingDown = false;

/**
 * Fetch pending tasks from server
 */
async function fetchPendingTasks(): Promise<PendingTask[]> {
  try {
    const response = await fetch(`${SERVER_URL}/tasks/pending`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      return await response.json();
    }
  } catch {
    // Server unavailable
  }
  return [];
}

/**
 * Acknowledge task as processed
 */
async function acknowledgeTask(taskId: string): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/tasks/${taskId}/ack`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Ignore
  }
}

/**
 * Inject a task using tmux send-keys
 */
async function injectTask(task: PendingTask): Promise<void> {
  console.log(`\r\n[PTY] Injecting task: "${task.message.slice(0, 50)}..."\r\n`);

  try {
    // Use tmux send-keys to send the message and Enter
    // -t specifies the target session
    // -l sends literal characters (no special key handling for the message)
    await $`tmux send-keys -t ${SESSION_NAME} -l ${task.message}`.quiet();
    await $`tmux send-keys -t ${SESSION_NAME} Enter`.quiet();
    console.log(`[PTY] Task injected successfully\r\n`);
  } catch (error) {
    console.error(`[PTY] Injection failed:`, error);
  }
}

/**
 * Start the task polling loop
 */
async function startTaskPolling(): Promise<void> {
  // Wait a bit for the session to start
  await Bun.sleep(2000);

  while (!isShuttingDown) {
    try {
      const tasks = await fetchPendingTasks();

      for (const task of tasks) {
        await injectTask(task);
        await acknowledgeTask(task.id);
        await Bun.sleep(500);
      }
    } catch (error) {
      if (!isShuttingDown) {
        console.error("[PTY] Task polling error:", error);
      }
    }

    await Bun.sleep(POLL_INTERVAL);
  }
}

/**
 * Check if tmux session exists
 */
async function sessionExists(): Promise<boolean> {
  try {
    await $`tmux has-session -t ${SESSION_NAME}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill existing session if any
 */
async function killExistingSession(): Promise<void> {
  try {
    await $`tmux kill-session -t ${SESSION_NAME}`.quiet();
  } catch {
    // Session doesn't exist, that's fine
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════╗
║           Claude-Call PTY Wrapper                 ║
╠═══════════════════════════════════════════════════╣
║  Wrapping Claude Code with Telegram integration   ║
║  Using tmux for reliable task injection           ║
║  Server: ${SERVER_URL.padEnd(39)}║
╚═══════════════════════════════════════════════════╝
`);

  // Check if server is available
  try {
    const response = await fetch(`${SERVER_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      console.log("✓ Server connection verified\n");
    } else {
      console.log("⚠ Server responded but with error - continuing anyway\n");
    }
  } catch {
    console.log("⚠ Server not available - task injection disabled\n");
    console.log("  Run 'bun run start' to start the server\n");
  }

  // Kill existing session if any
  await killExistingSession();

  // Build claude command with arguments
  const claudeArgs = process.argv.slice(2);
  const claudeCmd = claudeArgs.length > 0
    ? `/opt/homebrew/bin/claude ${claudeArgs.join(" ")}`
    : "/opt/homebrew/bin/claude";

  console.log(`Starting claude in tmux session '${SESSION_NAME}'...\n`);

  // Create a new tmux session running claude
  // -d: detached mode (we'll attach after)
  // -s: session name
  // -x/-y: window size
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  try {
    await $`tmux new-session -d -s ${SESSION_NAME} -x ${cols} -y ${rows} ${claudeCmd}`.quiet();
  } catch (error) {
    console.error("Failed to create tmux session:", error);
    process.exit(1);
  }

  // Set environment variables in the session
  try {
    await $`tmux set-environment -t ${SESSION_NAME} TERM xterm-256color`.quiet();
    await $`tmux set-environment -t ${SESSION_NAME} COLORTERM truecolor`.quiet();
    await $`tmux set-environment -t ${SESSION_NAME} CLAUDE_CALL_SERVER_URL ${SERVER_URL}`.quiet();
  } catch {
    // Ignore
  }

  // Start task polling in the background
  startTaskPolling();

  // Attach to the session
  // This will block until the session ends
  const proc = Bun.spawn(["tmux", "attach-session", "-t", SESSION_NAME], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      TERM: "xterm-256color",
    },
  });

  // Wait for the attach to exit
  const exitCode = await proc.exited;

  // Cleanup
  isShuttingDown = true;
  await killExistingSession();

  process.exit(exitCode);
}

// Handle signals
process.on("SIGINT", async () => {
  // tmux will handle SIGINT
});

process.on("SIGTERM", async () => {
  isShuttingDown = true;
  await killExistingSession();
  process.exit(0);
});

process.on("exit", () => {
  // Sync cleanup - can't await here
  isShuttingDown = true;
});

main().catch((error) => {
  console.error("[PTY] Fatal error:", error);
  process.exit(1);
});

#!/usr/bin/env bun
/**
 * PTY Wrapper for Claude Code using tmux
 *
 * Features:
 * 1. Registers a unique session with the server
 * 2. Creates a tmux session with unique name
 * 3. Polls for tasks specific to this session
 * 4. Uses `tmux send-keys` to inject tasks from Telegram
 * 5. Unregisters session on exit
 */

import { $ } from "bun";

const SERVER_URL = process.env.CLAUDE_CALL_SERVER_URL || "http://localhost:3847";
const POLL_INTERVAL = 1000;

interface PendingTask {
  id: string;
  sessionId: string;
  message: string;
  createdAt: number;
  type?: "message" | "keystroke";  // Task type: message (default) or keystroke for PTY key injection
  requestId?: string;               // Associated request ID (for AskUserQuestion answers)
}

interface Session {
  id: string;
  shortId: string;
  name: string;
  cwd: string;
}

let isShuttingDown = false;
let currentSession: Session | null = null;

/**
 * Register a new session with the server
 */
async function registerSession(): Promise<Session | null> {
  try {
    const response = await fetch(`${SERVER_URL}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `claude-${Date.now().toString(36)}`,
        cwd: process.cwd(),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const data = await response.json();
      return data.session;
    }
  } catch (error) {
    console.error("[PTY] Failed to register session:", error);
  }
  return null;
}

/**
 * Unregister session from the server
 */
async function unregisterSession(sessionId: string): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/sessions/${sessionId}/unregister`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Fetch pending tasks for this session from server
 */
async function fetchPendingTasks(sessionId: string): Promise<PendingTask[]> {
  try {
    const response = await fetch(`${SERVER_URL}/tasks/pending/${sessionId}`, {
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
 * Handles both regular message tasks and keystroke tasks differently
 */
async function injectTask(tmuxSession: string, task: PendingTask): Promise<void> {
  const isKeystroke = task.type === "keystroke";

  if (isKeystroke) {
    console.log(`\r\n[PTY] Injecting keystroke: "${task.message}"\r\n`);
  } else {
    console.log(`\r\n[PTY] Injecting task: "${task.message.slice(0, 50)}..."\r\n`);
  }

  try {
    if (isKeystroke) {
      // === KEYSTROKE INJECTION ===
      // Small delay to ensure Claude Code UI is ready to receive input
      await Bun.sleep(100);

      // Check if it's a single digit (option selection in Claude Code UI)
      const isNumericKeystroke = /^\d$/.test(task.message);

      if (isNumericKeystroke) {
        // Single digit - send directly without -l flag (no Enter needed)
        // Claude Code's selection UI responds immediately to digit keys
        const sendKey = Bun.spawn(["tmux", "send-keys", "-t", tmuxSession, task.message], {
          stdout: "ignore",
          stderr: "pipe",
        });
        const exitCode = await sendKey.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(sendKey.stderr).text();
          console.error(`[PTY] tmux send-keys failed (${exitCode}): ${stderr}`);
          return;
        }
      } else {
        // Custom text - send with -l flag for literal interpretation, then Enter
        const sendText = Bun.spawn(["tmux", "send-keys", "-t", tmuxSession, "-l", task.message], {
          stdout: "ignore",
          stderr: "pipe",
        });
        const textExitCode = await sendText.exited;
        if (textExitCode !== 0) {
          const stderr = await new Response(sendText.stderr).text();
          console.error(`[PTY] tmux send-keys (text) failed (${textExitCode}): ${stderr}`);
          return;
        }

        const sendEnter = Bun.spawn(["tmux", "send-keys", "-t", tmuxSession, "Enter"], {
          stdout: "ignore",
          stderr: "pipe",
        });
        const enterExitCode = await sendEnter.exited;
        if (enterExitCode !== 0) {
          const stderr = await new Response(sendEnter.stderr).text();
          console.error(`[PTY] tmux send-keys (enter) failed (${enterExitCode}): ${stderr}`);
          return;
        }
      }

      console.log(`[PTY] Keystroke injected successfully\r\n`);
    } else {
      // === REGULAR MESSAGE INJECTION ===
      // Use Bun.spawn instead of shell template to avoid variable escaping issues
      const sendText = Bun.spawn(["tmux", "send-keys", "-t", tmuxSession, "-l", task.message], {
        stdout: "ignore",
        stderr: "pipe",
      });
      await sendText.exited;

      const sendEnter = Bun.spawn(["tmux", "send-keys", "-t", tmuxSession, "Enter"], {
        stdout: "ignore",
        stderr: "pipe",
      });
      await sendEnter.exited;

      console.log(`[PTY] Task injected successfully\r\n`);
    }
  } catch (error) {
    console.error(`[PTY] Injection failed:`, error);
  }
}

/**
 * Start the task polling loop
 */
async function startTaskPolling(sessionId: string, tmuxSession: string): Promise<void> {
  // Wait a bit for the session to start
  await Bun.sleep(2000);

  while (!isShuttingDown) {
    try {
      const tasks = await fetchPendingTasks(sessionId);

      for (const task of tasks) {
        await injectTask(tmuxSession, task);
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
 * Kill tmux session
 */
async function killTmuxSession(tmuxSession: string): Promise<void> {
  try {
    await $`tmux kill-session -t ${tmuxSession}`.quiet();
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

  // Check if server is available and register session
  try {
    const response = await fetch(`${SERVER_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      console.log("✓ Server connection verified");

      // Register session
      currentSession = await registerSession();
      if (currentSession) {
        console.log(`✓ Session registered: ${currentSession.name} (${currentSession.shortId})\n`);
      } else {
        console.log("⚠ Failed to register session - task injection may not work\n");
      }
    } else {
      console.log("⚠ Server responded but with error - continuing anyway\n");
    }
  } catch {
    console.log("⚠ Server not available - task injection disabled\n");
    console.log("  Run 'bun run start' to start the server\n");
  }

  // Check for headless mode (for Telegram /claude-call command)
  const isHeadless = process.argv.includes("--headless");

  // Determine tmux session name
  const tmuxSession = currentSession?.name || `claude-${Date.now().toString(36)}`;

  // Build claude command with arguments (filter out --headless)
  // Use CLAUDE_PATH env var, or fall back to 'claude' (requires claude in PATH)
  const claudePath = process.env.CLAUDE_PATH || "claude";
  const claudeArgs = process.argv.slice(2).filter(arg => arg !== "--headless");
  const claudeCmd = claudeArgs.length > 0
    ? `${claudePath} ${claudeArgs.join(" ")}`
    : claudePath;

  console.log(`Starting claude in tmux session '${tmuxSession}'...\n`);

  // Create a new tmux session running claude
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  try {
    await $`tmux new-session -d -s ${tmuxSession} -x ${cols} -y ${rows} ${claudeCmd}`.quiet();
  } catch (error) {
    console.error("Failed to create tmux session:", error);
    if (currentSession) {
      await unregisterSession(currentSession.id);
    }
    process.exit(1);
  }

  // Set environment variables and options in the session
  try {
    await $`tmux set-environment -t ${tmuxSession} TERM xterm-256color`.quiet();
    await $`tmux set-environment -t ${tmuxSession} COLORTERM truecolor`.quiet();
    await $`tmux set-environment -t ${tmuxSession} CLAUDE_CALL_SERVER_URL ${SERVER_URL}`.quiet();
    // Disable mouse to prevent flickering issues
    await $`tmux set-option -t ${tmuxSession} mouse off`.quiet();
    // Disable status bar for cleaner display
    await $`tmux set-option -t ${tmuxSession} status off`.quiet();
  } catch {
    // Ignore
  }

  // Start task polling in the background (only if session registered)
  if (currentSession) {
    startTaskPolling(currentSession.id, tmuxSession);
  }

  if (isHeadless) {
    // Headless mode: don't attach, just keep running for task polling
    console.log(`[PTY] Running in headless mode, session: ${tmuxSession}`);
    console.log(`[PTY] Use 'tmux attach-session -t ${tmuxSession}' to attach manually`);

    // Keep process alive for task polling
    while (!isShuttingDown) {
      await Bun.sleep(5000);
    }
  } else {
    // Interactive mode: attach to the session
    const proc = Bun.spawn(["tmux", "attach-session", "-t", tmuxSession], {
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
    await cleanup(tmuxSession);

    process.exit(exitCode);
  }
}

/**
 * Cleanup resources
 */
async function cleanup(tmuxSession: string): Promise<void> {
  isShuttingDown = true;

  // Unregister session
  if (currentSession) {
    console.log(`\n[PTY] Unregistering session ${currentSession.shortId}...`);
    await unregisterSession(currentSession.id);
  }

  // Kill tmux session
  await killTmuxSession(tmuxSession);
}

// Handle signals
process.on("SIGINT", async () => {
  // tmux will handle SIGINT
});

process.on("SIGTERM", async () => {
  const tmuxSession = currentSession?.name || "claude-call";
  await cleanup(tmuxSession);
  process.exit(0);
});

main().catch((error) => {
  console.error("[PTY] Fatal error:", error);
  process.exit(1);
});

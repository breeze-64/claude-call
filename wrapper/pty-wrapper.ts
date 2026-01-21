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
import { createLogger } from "../server/logger";

const log = createLogger("PTY");

const SERVER_URL = process.env.CLAUDE_CALL_SERVER_URL || "http://localhost:3847";
const POLL_INTERVAL = 1000;

interface PendingTask {
  id: string;
  sessionId: string;
  message: string;
  createdAt: number;
  type?: "message" | "keystroke" | "sequence";  // Task type: message (default), keystroke for single key, or sequence for multiple keys
  requestId?: string;               // Associated request ID (for AskUserQuestion answers)
  sequence?: string[];              // Array of keystrokes for sequence type
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
    log.error("Failed to register session", { error: String(error) });
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
 * Acknowledge task as processed with optional status
 */
async function acknowledgeTask(
  taskId: string,
  status?: { success: boolean; error?: string }
): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/tasks/${taskId}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: status ? JSON.stringify(status) : undefined,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Ignore
  }
}

/**
 * Injection result
 */
interface InjectionResult {
  success: boolean;
  error?: string;
}

/**
 * Send a single keystroke to tmux session
 * Returns success/failure status
 */
async function sendKeystroke(tmuxSession: string, keystroke: string): Promise<InjectionResult> {
  // Check keystroke type:
  // 1. Single digit (1-9): option selection, send directly
  // 2. Special keys (Tab, Enter, Escape, etc.): send as tmux key name
  // 3. Custom text: send with -l flag for literal interpretation + Enter
  const isNumericKeystroke = /^\d$/.test(keystroke);
  const isSpecialKey = /^(Tab|Enter|Escape|Space|BSpace|Up|Down|Left|Right|Home|End|PageUp|PageDown)$/i.test(keystroke);

  if (isNumericKeystroke || isSpecialKey) {
    // Single digit or special key - send directly without -l flag
    // tmux recognizes key names like Tab, Enter, etc.
    const sendKey = Bun.spawn(["tmux", "send-keys", "-t", tmuxSession, keystroke], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await sendKey.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(sendKey.stderr).text();
      log.error(`tmux send-keys failed (${exitCode}): ${stderr}`);
      return { success: false, error: `tmux send-keys 失败: ${stderr.trim() || `exit code ${exitCode}`}` };
    }
    return { success: true };
  } else {
    // Custom text - send with -l flag for literal interpretation, then Enter
    const sendText = Bun.spawn(["tmux", "send-keys", "-t", tmuxSession, "-l", keystroke], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const textExitCode = await sendText.exited;
    if (textExitCode !== 0) {
      const stderr = await new Response(sendText.stderr).text();
      log.error(`tmux send-keys (text) failed (${textExitCode}): ${stderr}`);
      return { success: false, error: `tmux send-keys 失败: ${stderr.trim() || `exit code ${textExitCode}`}` };
    }

    const sendEnter = Bun.spawn(["tmux", "send-keys", "-t", tmuxSession, "Enter"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const enterExitCode = await sendEnter.exited;
    if (enterExitCode !== 0) {
      const stderr = await new Response(sendEnter.stderr).text();
      log.error(`tmux send-keys (enter) failed (${enterExitCode}): ${stderr}`);
      return { success: false, error: `tmux Enter 失败: ${stderr.trim() || `exit code ${enterExitCode}`}` };
    }
    return { success: true };
  }
}

/**
 * Inject a task using tmux send-keys
 * Handles regular message tasks, keystroke tasks, and sequence tasks differently
 * Returns success/failure status for notification
 */
async function injectTask(tmuxSession: string, task: PendingTask): Promise<InjectionResult> {
  const isKeystroke = task.type === "keystroke";
  const isSequence = task.type === "sequence";

  if (isSequence) {
    log.info(`Injecting sequence: [${task.sequence?.join(", ")}]`);
  } else if (isKeystroke) {
    log.info(`Injecting keystroke: "${task.message}"`);
  } else {
    log.info(`Injecting task: "${task.message.slice(0, 50)}..."`);
  }

  try {
    if (isSequence && task.sequence) {
      // === SEQUENCE INJECTION ===
      // Send multiple keystrokes with delays between them
      // Used for multi-step interactions (e.g., select option + Tab + Enter)
      await Bun.sleep(100); // Initial delay for UI readiness

      for (let i = 0; i < task.sequence.length; i++) {
        const keystroke = task.sequence[i];
        log.debug(`Sending sequence step ${i + 1}/${task.sequence.length}: "${keystroke}"`);

        const result = await sendKeystroke(tmuxSession, keystroke);
        if (!result.success) {
          return { success: false, error: `序列第 ${i + 1} 步失败: ${result.error}` };
        }

        // Delay between keystrokes to allow UI to process
        // Longer delay after non-special keys (like digits) to let the UI update
        if (i < task.sequence.length - 1) {
          const delayMs = /^\d$/.test(keystroke) ? 300 : 150;
          await Bun.sleep(delayMs);
        }
      }

      log.info("Sequence injected successfully");
      return { success: true };
    } else if (isKeystroke) {
      // === KEYSTROKE INJECTION ===
      // Small delay to ensure Claude Code UI is ready to receive input
      await Bun.sleep(100);

      const result = await sendKeystroke(tmuxSession, task.message);
      if (!result.success) {
        return result;
      }

      log.info("Keystroke injected successfully");
      return { success: true };
    } else {
      // === REGULAR MESSAGE INJECTION ===
      // Use Bun.spawn instead of shell template to avoid variable escaping issues
      const sendText = Bun.spawn(["tmux", "send-keys", "-t", tmuxSession, "-l", task.message], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const textExitCode = await sendText.exited;
      if (textExitCode !== 0) {
        const stderr = await new Response(sendText.stderr).text();
        log.error(`tmux send-keys failed (${textExitCode}): ${stderr}`);
        return { success: false, error: `tmux send-keys 失败: ${stderr.trim() || `exit code ${textExitCode}`}` };
      }

      const sendEnter = Bun.spawn(["tmux", "send-keys", "-t", tmuxSession, "Enter"], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const enterExitCode = await sendEnter.exited;
      if (enterExitCode !== 0) {
        const stderr = await new Response(sendEnter.stderr).text();
        log.error(`tmux send-keys (enter) failed (${enterExitCode}): ${stderr}`);
        return { success: false, error: `tmux Enter 失败: ${stderr.trim() || `exit code ${enterExitCode}`}` };
      }

      log.info("Task injected successfully");
      return { success: true };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error("Injection failed", { error: errorMsg });
    return { success: false, error: `注入异常: ${errorMsg}` };
  }
}

// Track server connection state
let serverConnected = true;
let lastHealthCheck = Date.now();
const HEALTH_CHECK_INTERVAL = 30000; // Check tmux health every 30 seconds

// Terminal monitoring state
const PROMPT_MONITOR_INTERVAL = 500; // Check for prompts every 500ms
let lastPromptHash = ""; // Track last detected prompt to avoid duplicates
let lastPromptTime = 0; // Debounce prompt detection

/**
 * Detected prompt from terminal
 */
interface DetectedPrompt {
  type: "permission" | "question" | "unknown";
  title: string;
  options: Array<{ number: string; label: string }>;
  rawContent: string;
}

/**
 * Capture terminal content using tmux capture-pane
 */
async function captureTerminal(tmuxSession: string): Promise<string> {
  try {
    const proc = Bun.spawn(["tmux", "capture-pane", "-t", tmuxSession, "-p"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output;
  } catch {
    return "";
  }
}

/**
 * Strip ANSI escape codes from text
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/**
 * Detect if terminal is showing an interactive prompt
 * Returns null if no prompt detected, or prompt details if found
 */
function detectPrompt(terminalContent: string): DetectedPrompt | null {
  const clean = stripAnsi(terminalContent);
  const lines = clean.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  if (lines.length < 3) return null;

  // Look for numbered options pattern (common in Claude Code prompts)
  // Format: "1. Option text" or "1) Option text"
  const optionPattern = /^(\d+)[.)]\s+(.+)$/;
  const options: Array<{ number: string; label: string }> = [];
  let titleLineIndex = -1;

  // Scan from bottom up to find options (they're usually at the bottom)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const match = line.match(optionPattern);

    if (match) {
      options.unshift({ number: match[1], label: match[2] });
    } else if (options.length > 0) {
      // We've found options and now hit a non-option line
      // This might be the title/question
      titleLineIndex = i;
      break;
    }
  }

  // Need at least 2 options to be considered a prompt
  if (options.length < 2) {
    // Check for permission-style prompts (Yes/No patterns)
    const lastFewLines = lines.slice(-10).join("\n");

    // Claude Code permission prompt patterns
    if (lastFewLines.includes("Allow") && lastFewLines.includes("Deny")) {
      return {
        type: "permission",
        title: "Permission Request",
        options: [
          { number: "1", label: "Yes" },
          { number: "2", label: "Yes, allow all" },
          { number: "3", label: "No" },
        ],
        rawContent: lastFewLines,
      };
    }

    // Check for "? " at start of line (common prompt indicator)
    const questionLine = lines.find(l => l.startsWith("?") || l.includes("?"));
    if (questionLine && lastFewLines.match(/\d+[.)]/)) {
      // There's a question and numbered items, try to parse
      const allOptions: Array<{ number: string; label: string }> = [];
      for (const line of lines.slice(-15)) {
        const m = line.match(optionPattern);
        if (m) {
          allOptions.push({ number: m[1], label: m[2] });
        }
      }
      if (allOptions.length >= 2) {
        return {
          type: "question",
          title: questionLine.replace(/^\?\s*/, ""),
          options: allOptions,
          rawContent: lastFewLines,
        };
      }
    }

    return null;
  }

  // Extract title from lines before options
  let title = "请选择";
  if (titleLineIndex >= 0) {
    // Look for question mark or meaningful title
    for (let i = titleLineIndex; i >= Math.max(0, titleLineIndex - 3); i--) {
      const line = lines[i];
      if (line.includes("?") || line.length > 10) {
        title = line.replace(/^\?\s*/, "");
        break;
      }
    }
  }

  // Determine type
  const rawContent = lines.slice(Math.max(0, titleLineIndex - 2)).join("\n");
  const type = rawContent.toLowerCase().includes("allow") ||
               rawContent.toLowerCase().includes("permission") ? "permission" : "question";

  return { type, title, options, rawContent };
}

/**
 * Simple hash function for prompt content
 */
function hashPrompt(prompt: DetectedPrompt): string {
  return `${prompt.type}:${prompt.options.map(o => o.label).join("|")}`;
}

/**
 * Send prompt notification to server
 */
async function sendPromptNotification(
  sessionId: string,
  prompt: DetectedPrompt,
  cwd: string
): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/prompt-detected`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        type: prompt.type,
        title: prompt.title,
        options: prompt.options,
        rawContent: prompt.rawContent,
        cwd,
      }),
      signal: AbortSignal.timeout(5000),
    });
    log.info(`Prompt notification sent: ${prompt.type} with ${prompt.options.length} options`);
  } catch (error) {
    log.error("Failed to send prompt notification", { error: String(error) });
  }
}

/**
 * Start the terminal monitoring loop
 * Watches for interactive prompts and sends notifications to Telegram
 */
async function startPromptMonitoring(sessionId: string, tmuxSession: string, cwd: string): Promise<void> {
  // Wait for session to initialize
  await Bun.sleep(3000);

  log.info("Starting terminal prompt monitoring...");

  while (!isShuttingDown) {
    try {
      const content = await captureTerminal(tmuxSession);
      const prompt = detectPrompt(content);

      if (prompt) {
        const hash = hashPrompt(prompt);
        const now = Date.now();

        // Only send notification if this is a new prompt (different from last one)
        // and enough time has passed (debounce)
        if (hash !== lastPromptHash && now - lastPromptTime > 1000) {
          lastPromptHash = hash;
          lastPromptTime = now;

          log.info(`Detected ${prompt.type} prompt: "${prompt.title}" with ${prompt.options.length} options`);
          await sendPromptNotification(sessionId, prompt, cwd);
        }
      } else {
        // No prompt detected - reset state after a delay
        // This allows detecting the same prompt again if it reappears
        if (lastPromptHash && Date.now() - lastPromptTime > 5000) {
          lastPromptHash = "";
        }
      }
    } catch (error) {
      if (!isShuttingDown) {
        log.error("Prompt monitoring error", { error: String(error) });
      }
    }

    await Bun.sleep(PROMPT_MONITOR_INTERVAL);
  }
}

/**
 * Start the task polling loop
 */
async function startTaskPolling(sessionId: string, tmuxSession: string): Promise<void> {
  // Wait a bit for the session to start
  await Bun.sleep(2000);

  while (!isShuttingDown) {
    // Periodic health check for tmux session
    if (Date.now() - lastHealthCheck > HEALTH_CHECK_INTERVAL) {
      lastHealthCheck = Date.now();
      const alive = await isTmuxSessionAlive(tmuxSession);
      if (!alive) {
        log.error(`tmux session ${tmuxSession} is dead!`);
        await sendServerNotification(
          `💀 *会话已结束*\n\n📋 会话: ${currentSession?.name || tmuxSession}\n\ntmux 会话已不存在`
        );
        // Trigger cleanup and exit
        isShuttingDown = true;
        break;
      }
    }

    try {
      const tasks = await fetchPendingTasks(sessionId);

      // Track connection recovery
      if (!serverConnected) {
        serverConnected = true;
        log.info("Server connection restored");
        await sendServerNotification(
          `🔄 *连接已恢复*\n\n📋 会话: ${currentSession?.name || tmuxSession}\n\nPTY wrapper 已重新连接到服务器`
        );
      }

      for (const task of tasks) {
        const result = await injectTask(tmuxSession, task);
        // Pass injection result to server for notification
        await acknowledgeTask(task.id, result);
        await Bun.sleep(500);
      }
    } catch (error) {
      if (!isShuttingDown) {
        // Track connection loss
        if (serverConnected) {
          serverConnected = false;
          log.error("Lost connection to server");
        }
        log.error("Task polling error", { error: String(error) });
      }
    }

    await Bun.sleep(POLL_INTERVAL);
  }

  // Clean up on exit
  if (currentSession) {
    await unregisterSession(currentSession.id);
  }
}

/**
 * Check if tmux session is still alive
 */
async function isTmuxSessionAlive(tmuxSession: string): Promise<boolean> {
  try {
    const result = Bun.spawn(["tmux", "has-session", "-t", tmuxSession], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await result.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Send notification to server (for health/status updates)
 */
async function sendServerNotification(message: string): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Server unreachable, can't notify
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
  log.info(`
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
      log.info("Server connection verified");

      // Register session
      currentSession = await registerSession();
      if (currentSession) {
        log.info(`Session registered: ${currentSession.name} (${currentSession.shortId})`);
      } else {
        log.warn("Failed to register session - task injection may not work");
      }
    } else {
      log.warn("Server responded but with error - continuing anyway");
    }
  } catch {
    log.warn("Server not available - task injection disabled");
    log.warn("Run 'bun run start' to start the server");
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

  log.info(`Starting claude in tmux session '${tmuxSession}'...`);

  // Create a new tmux session running claude
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Build environment variables string for tmux
  // Include proxy vars so Claude can access the API
  const proxyVars = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
  const envExports = proxyVars
    .filter(v => process.env[v])
    .map(v => `export ${v}="${process.env[v]}"`)
    .join("; ");

  // Wrap claude command with environment setup
  const wrappedCmd = envExports
    ? `${envExports}; ${claudeCmd}`
    : claudeCmd;

  if (envExports) {
    log.debug("Proxy vars detected, passing to tmux session");
  }

  try {
    await $`tmux new-session -d -s ${tmuxSession} -x ${cols} -y ${rows} ${wrappedCmd}`.quiet();
  } catch (error) {
    log.error("Failed to create tmux session", { error: String(error) });
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
    // Note: Terminal prompt monitoring is disabled - we use hook notifications instead
  }

  if (isHeadless) {
    // Headless mode: don't attach, just keep running for task polling
    log.info(`Running in headless mode, session: ${tmuxSession}`);
    log.info(`Use 'tmux attach-session -t ${tmuxSession}' to attach manually`);

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
    log.info(`Unregistering session ${currentSession.shortId}...`);
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
  log.fatal("Fatal error", { error: String(error) });
  process.exit(1);
});

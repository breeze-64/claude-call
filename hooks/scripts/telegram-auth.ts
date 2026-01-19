#!/usr/bin/env bun

/**
 * Claude Code PreToolUse Hook Script
 *
 * This script intercepts tool usage and requests authorization via Telegram.
 * It supports both authorization requests and multi-option questions.
 */

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  hook_event_name: string;
  cwd?: string;
  permission_mode?: string;
}

interface HookOutput {
  hookSpecificOutput?: {
    permissionDecision?: "allow" | "deny" | "ask";
    selectedAnswer?: string;
  };
  systemMessage?: string;
}

interface AuthorizeResponse {
  requestId: string;
  status: "pending" | "resolved";
  decision?: "allow" | "deny";
  selectedOption?: string;
}

interface PollResponse {
  status: "pending" | "resolved" | "timeout" | "not_found";
  decision?: "allow" | "deny";
  selectedOption?: string;
  elapsed?: number;
}

interface ServerOption {
  id: string;
  label: string;
  description?: string;
}

const SERVER_URL = process.env.CLAUDE_CALL_SERVER_URL || "http://localhost:3847";
const POLL_INTERVAL = 500; // ms
const MAX_WAIT = 600000; // ms (10 minutes max)

/**
 * Cancel a request on the server (updates Telegram message)
 */
async function cancelRequest(requestId: string): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/cancel/${requestId}`, { method: "POST" });
  } catch {
    // Ignore errors - best effort cancellation
  }
}

/**
 * Tools that don't require authorization (safe, read-only)
 */
const SKIP_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
]);

/**
 * Tools that need PTY keystroke injection for authorization
 * These tools will show a local prompt in Claude Code terminal
 * We send a notification to Telegram and return "ask" immediately
 */
const PTY_AUTH_TOOLS = new Set([
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * Claude Code settings structure
 */
interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
}

/**
 * Read Claude Code settings from global and project-level config
 */
async function readClaudeSettings(cwd?: string): Promise<ClaudeSettings> {
  const settings: ClaudeSettings = { permissions: { allow: [], deny: [] } };

  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const globalSettingsPath = `${homeDir}/.claude/settings.json`;
  const projectSettingsPath = cwd ? `${cwd}/.claude/settings.json` : null;

  // Read global settings
  try {
    const file = Bun.file(globalSettingsPath);
    if (await file.exists()) {
      const globalSettings: ClaudeSettings = await file.json();
      if (globalSettings.permissions?.allow) {
        settings.permissions!.allow = globalSettings.permissions.allow;
      }
      if (globalSettings.permissions?.deny) {
        settings.permissions!.deny = globalSettings.permissions.deny;
      }
    }
  } catch {
    // Ignore errors reading global settings
  }

  // Read project settings (merge with global)
  if (projectSettingsPath) {
    try {
      const file = Bun.file(projectSettingsPath);
      if (await file.exists()) {
        const projectSettings: ClaudeSettings = await file.json();
        if (projectSettings.permissions?.allow) {
          settings.permissions!.allow = [
            ...settings.permissions!.allow!,
            ...projectSettings.permissions.allow,
          ];
        }
        if (projectSettings.permissions?.deny) {
          settings.permissions!.deny = [
            ...settings.permissions!.deny!,
            ...projectSettings.permissions.deny,
          ];
        }
      }
    } catch {
      // Ignore errors reading project settings
    }
  }

  return settings;
}

/**
 * Check if a permission pattern matches the current tool call
 *
 * Pattern formats:
 * - "Bash(npm :*)" - Bash tool with command starting with "npm "
 * - "Write(**)" - All Write operations
 * - "Edit(src/**)" - Edit operations on files in src/
 */
function matchesPermissionPattern(
  pattern: string,
  toolName: string,
  toolInput: Record<string, unknown>
): boolean {
  // Parse pattern: "ToolName(arg)"
  const match = pattern.match(/^(\w+)\((.+)\)$/);
  if (!match) {
    // Simple tool name match (e.g., "Bash")
    return pattern === toolName;
  }

  const [, patternTool, patternArg] = match;

  // Tool name must match
  if (patternTool !== toolName) {
    return false;
  }

  // Handle different tools
  if (toolName === "Bash") {
    const command = toolInput.command as string | undefined;
    if (!command) return false;

    // Pattern like "npm :*" means command starts with "npm "
    if (patternArg.endsWith(" :*")) {
      const prefix = patternArg.slice(0, -3); // Remove " :*"
      return command.startsWith(prefix + " ") || command === prefix;
    }

    // Pattern like "npm*" means command starts with "npm"
    if (patternArg.endsWith("*")) {
      const prefix = patternArg.slice(0, -1);
      return command.startsWith(prefix);
    }

    // Exact match
    return command === patternArg;
  }

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const filePath = toolInput.file_path as string | undefined;
    if (!filePath) return false;

    // "**" matches everything
    if (patternArg === "**") {
      return true;
    }

    // "src/**" matches files under src/
    if (patternArg.endsWith("/**")) {
      const prefix = patternArg.slice(0, -3);
      return filePath.startsWith(prefix + "/") || filePath === prefix;
    }

    // Glob-like matching with *
    if (patternArg.includes("*")) {
      const regex = new RegExp(
        "^" + patternArg.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$"
      );
      return regex.test(filePath);
    }

    // Exact match
    return filePath === patternArg;
  }

  // For other tools, just check if pattern allows all ("**")
  return patternArg === "**";
}

/**
 * Check if tool call is already allowed by Claude Code's allowedTools config
 */
async function isAlreadyAllowed(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd?: string
): Promise<boolean> {
  const settings = await readClaudeSettings(cwd);

  // Check deny patterns first (deny takes precedence)
  for (const pattern of settings.permissions?.deny || []) {
    if (matchesPermissionPattern(pattern, toolName, toolInput)) {
      return false; // Explicitly denied
    }
  }

  // Check allow patterns
  for (const pattern of settings.permissions?.allow || []) {
    if (matchesPermissionPattern(pattern, toolName, toolInput)) {
      return true; // Matches an allow pattern
    }
  }

  return false;
}

/**
 * Output decision and exit
 *
 * According to Claude Code hook docs:
 * - "allow": exit 0, output to stdout
 * - "deny": exit 2, output to stderr
 * - "ask": exit 0, output to stdout (falls back to terminal prompt)
 */
function outputDecision(
  decision: "allow" | "deny" | "ask",
  message?: string,
  selectedAnswer?: string
): never {
  const output: HookOutput = {
    hookSpecificOutput: {
      permissionDecision: decision,
    },
  };

  if (selectedAnswer) {
    output.hookSpecificOutput!.selectedAnswer = selectedAnswer;
  }

  if (message) {
    output.systemMessage = message;
  }

  const jsonOutput = JSON.stringify(output);

  if (decision === "deny") {
    // For deny: output to stderr and exit 2
    console.error(jsonOutput);
    process.exit(2);
  } else {
    // For allow/ask: output to stdout and exit 0
    console.log(jsonOutput);
    process.exit(0);
  }
}

/**
 * Parse AskUserQuestion input and extract options
 */
function parseAskUserQuestion(toolInput: Record<string, unknown>): {
  question: string;
  options: ServerOption[];
} | null {
  const questions = toolInput.questions as Question[] | undefined;

  if (!questions || questions.length === 0) {
    return null;
  }

  // Take the first question
  const q = questions[0];
  if (!q.options || q.options.length === 0) {
    return null;
  }

  // Convert options to server format with IDs
  const options: ServerOption[] = q.options.map((opt, index) => {
    // Use A, B, C... for IDs
    const id = String.fromCharCode(65 + index); // A, B, C, D...
    return {
      id,
      label: opt.label,
      description: opt.description,
    };
  });

  return {
    question: q.question || q.header || "请选择一个选项",
    options,
  };
}

/**
 * Main entry point
 */
async function main() {
  // Read input from stdin
  const inputText = await Bun.stdin.text();

  let input: HookInput;
  try {
    input = JSON.parse(inputText);
  } catch {
    // Invalid input - allow by default
    console.error(`[claude-call] Failed to parse input JSON: ${inputText.slice(0, 200)}`);
    return outputDecision("allow", "Invalid hook input");
  }

  // Debug: Log the full input to understand what Claude Code sends
  console.error(`[claude-call] Hook input: tool_name=${input.tool_name}, event=${input.hook_event_name}, has_tool_input=${!!input.tool_input}`);
  if (!input.tool_name) {
    console.error(`[claude-call] WARNING: tool_name is missing! Full input: ${JSON.stringify(input).slice(0, 500)}`);
  }

  const { session_id, tool_input, cwd } = input;
  let { tool_name } = input;

  // Infer tool_name from tool_input if missing
  if (!tool_name && tool_input) {
    if ("command" in tool_input) {
      tool_name = "Bash";
      console.error(`[claude-call] Inferred tool_name as "Bash" from command field`);
    } else if ("file_path" in tool_input && ("new_string" in tool_input || "old_string" in tool_input)) {
      tool_name = "Edit";
      console.error(`[claude-call] Inferred tool_name as "Edit"`);
    } else if ("file_path" in tool_input && "content" in tool_input) {
      tool_name = "Write";
      console.error(`[claude-call] Inferred tool_name as "Write"`);
    } else if ("questions" in tool_input) {
      tool_name = "AskUserQuestion";
      console.error(`[claude-call] Inferred tool_name as "AskUserQuestion"`);
    }
  }

  // Skip safe tools
  if (tool_name && SKIP_TOOLS.has(tool_name)) {
    return outputDecision("allow");
  }

  // Check if already allowed by Claude Code's allowedTools config
  // Skip this check for PTY_AUTH_TOOLS - we want those to always send Telegram notifications
  // so users can authorize remote sessions via keystroke injection
  if (tool_name && tool_name !== "AskUserQuestion" && !PTY_AUTH_TOOLS.has(tool_name)) {
    try {
      const alreadyAllowed = await isAlreadyAllowed(tool_name, tool_input, cwd);
      if (alreadyAllowed) {
        console.error(`[claude-call] Tool ${tool_name} already allowed by Claude Code config, skipping Telegram`);
        return outputDecision("allow", "Auto-approved (allowedTools config)");
      }
    } catch (error) {
      console.error(`[claude-call] Error checking allowedTools: ${error}`);
      // Continue to normal flow if check fails
    }
  }

  try {
    // Check if this is an AskUserQuestion
    if (tool_name === "AskUserQuestion") {
      const parsed = parseAskUserQuestion(tool_input);

      if (parsed) {
        // Send as question request
        const authResponse = await fetch(`${SERVER_URL}/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: session_id,
            toolName: tool_name,
            toolInput: tool_input,
            cwd,
            type: "question",
            question: parsed.question,
            options: parsed.options,
          }),
        });

        if (!authResponse.ok) {
          throw new Error(`Server responded with ${authResponse.status}`);
        }

        const authResult: AuthorizeResponse = await authResponse.json();

        // Poll for decision
        const startTime = Date.now();
        const requestId = authResult.requestId;

        while (Date.now() - startTime < MAX_WAIT) {
          await Bun.sleep(POLL_INTERVAL);

          const pollResponse = await fetch(`${SERVER_URL}/poll/${requestId}`);
          const pollResult: PollResponse = await pollResponse.json();

          if (pollResult.status === "resolved" && pollResult.selectedOption) {
            const selectedOption = pollResult.selectedOption;

            // Check if it's a custom input (prefixed with __CUSTOM__:)
            if (selectedOption.startsWith("__CUSTOM__:")) {
              const customText = selectedOption.slice("__CUSTOM__:".length);
              // Return custom text directly as the answer
              outputDecision("allow", `自定义输入: ${customText}`, customText);
              return; // Safety return (outputDecision calls process.exit)
            }

            // Find the index of the selected option (A=0, B=1, etc.)
            const optionIndex = selectedOption.charCodeAt(0) - 65;
            const questions = tool_input.questions as Question[];
            const selectedLabel = questions[0]?.options[optionIndex]?.label || selectedOption;

            // Return the selected answer
            outputDecision("allow", `用户选择: ${selectedLabel}`, selectedLabel);
            return; // Safety return
          }

          if (pollResult.status === "timeout") {
            // Cancel request to update Telegram message
            await cancelRequest(requestId);
            return outputDecision("ask", "Telegram 超时，请在终端选择");
          }

          if (pollResult.status === "not_found") {
            return outputDecision("ask", "请求未找到");
          }
        }

        // Local timeout - cancel request to update Telegram message
        await cancelRequest(requestId);
        return outputDecision("ask", "本地超时，请在终端选择");
      }

      // If can't parse, fall through to terminal
      return outputDecision("ask");
    }

    // Check if this tool needs PTY keystroke injection for authorization
    // These tools show a local prompt in Claude Code, so we:
    // 1. Send a notification to Telegram with keystroke buttons
    // 2. Return "ask" immediately to let Claude Code show its prompt
    // 3. User clicks button in Telegram → PTY injects keystroke
    if (tool_name && PTY_AUTH_TOOLS.has(tool_name)) {
      console.error(`[claude-call] Tool ${tool_name} needs PTY auth, sending notification`);

      // Send auth notification and wait for it to complete before exiting
      // (process.exit in outputDecision would cancel pending async operations)
      try {
        await fetch(`${SERVER_URL}/auth-notify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: session_id,
            toolName: tool_name,
            toolInput: tool_input,
            cwd,
          }),
        });
        console.error(`[claude-call] Auth notification sent successfully`);
      } catch (err) {
        console.error(`[claude-call] Failed to send auth notification: ${err}`);
      }

      // Return "ask" to let Claude Code show its local prompt
      // User will respond via Telegram → PTY keystroke injection
      return outputDecision("ask", "Authorization via Telegram (PTY injection)");
    }

    // For other tools, use the traditional blocking authorization flow
    const authResponse = await fetch(`${SERVER_URL}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session_id,
        toolName: tool_name,
        toolInput: tool_input,
        cwd,
      }),
    });

    if (!authResponse.ok) {
      throw new Error(`Server responded with ${authResponse.status}`);
    }

    const authResult: AuthorizeResponse = await authResponse.json();

    // If immediately resolved (Allow All session), return
    if (authResult.status === "resolved") {
      return outputDecision(authResult.decision!, "Auto-approved (Allow All)");
    }

    // Poll for decision
    const startTime = Date.now();
    const requestId = authResult.requestId;

    while (Date.now() - startTime < MAX_WAIT) {
      await Bun.sleep(POLL_INTERVAL);

      const pollResponse = await fetch(`${SERVER_URL}/poll/${requestId}`);
      const pollResult: PollResponse = await pollResponse.json();

      if (pollResult.status === "resolved") {
        const msg = pollResult.decision === "allow" ? "Authorized via Telegram" : "Denied via Telegram";
        return outputDecision(pollResult.decision!, msg);
      }

      if (pollResult.status === "timeout") {
        // Server already updated Telegram message
        return outputDecision("deny", "Authorization timeout");
      }

      if (pollResult.status === "not_found") {
        return outputDecision("deny", "Authorization request not found");
      }
    }

    // Local timeout - cancel request to update Telegram message
    await cancelRequest(requestId);
    return outputDecision("deny", "Local timeout waiting for authorization");

  } catch (error) {
    // Server unreachable - fall through to terminal prompt
    console.error(`[claude-call] Server error: ${error}`);

    // Return "ask" to let Claude Code handle it normally
    outputDecision("ask", "Authorization server unreachable - asking user directly");
  }
}

main().catch((error) => {
  console.error(`[claude-call] Fatal error: ${error}`);
  // On fatal error, allow the operation to prevent blocking
  outputDecision("ask", "Hook error - asking user directly");
});

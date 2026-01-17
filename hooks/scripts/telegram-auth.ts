#!/usr/bin/env bun

/**
 * Claude Code PreToolUse Hook Script
 *
 * This script intercepts tool usage and requests authorization via Telegram.
 * It communicates with the claude-call authorization server.
 */

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
    permissionDecision: "allow" | "deny" | "ask";
  };
  systemMessage?: string;
}

interface AuthorizeResponse {
  requestId: string;
  status: "pending" | "resolved";
  decision?: "allow" | "deny";
}

interface PollResponse {
  status: "pending" | "resolved" | "timeout" | "not_found";
  decision?: "allow" | "deny";
  elapsed?: number;
}

const SERVER_URL = process.env.CLAUDE_CALL_SERVER_URL || "http://localhost:3847";
const POLL_INTERVAL = 500; // ms
const MAX_WAIT = 32000; // ms

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
  "AskUserQuestion",
]);

/**
 * Output decision and exit
 */
function outputDecision(decision: "allow" | "deny" | "ask", message?: string): never {
  const output: HookOutput = {
    hookSpecificOutput: {
      permissionDecision: decision,
    },
  };

  if (message) {
    output.systemMessage = message;
  }

  console.log(JSON.stringify(output));
  process.exit(decision === "deny" ? 2 : 0);
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
    outputDecision("allow", "Invalid hook input");
  }

  const { session_id, tool_name, tool_input, cwd } = input!;

  // Skip safe tools
  if (SKIP_TOOLS.has(tool_name)) {
    outputDecision("allow");
  }

  try {
    // Request authorization from server
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
      outputDecision(authResult.decision!, "Auto-approved (Allow All)");
    }

    // Poll for decision
    const startTime = Date.now();
    const requestId = authResult.requestId;

    while (Date.now() - startTime < MAX_WAIT) {
      await Bun.sleep(POLL_INTERVAL);

      const pollResponse = await fetch(`${SERVER_URL}/poll/${requestId}`);
      const pollResult: PollResponse = await pollResponse.json();

      if (pollResult.status === "resolved") {
        outputDecision(pollResult.decision!, "Authorized via Telegram");
      }

      if (pollResult.status === "timeout") {
        outputDecision("deny", "Authorization timeout");
      }

      if (pollResult.status === "not_found") {
        outputDecision("deny", "Authorization request not found");
      }
    }

    // Local timeout - deny
    outputDecision("deny", "Local timeout waiting for authorization");

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

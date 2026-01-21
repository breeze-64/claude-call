#!/usr/bin/env bun
/**
 * Hook Configuration Merge Tool
 *
 * Safely merges Claude-Call hook configuration into existing Claude Code settings.
 * Preserves user's other configurations while adding or updating our hooks.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface HookConfig {
  type: string;
  command: string;
}

interface HookMatcher {
  matcher: string;
  hooks: HookConfig[];
}

interface ClaudeSettings {
  hooks?: {
    PreToolUse?: HookMatcher[];
    PostToolUse?: HookMatcher[];
    [key: string]: HookMatcher[] | undefined;
  };
  [key: string]: unknown;
}

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");

// Get the installation directory (parent of scripts/)
const INSTALL_DIR = join(import.meta.dir, "..");

// Our hook configuration
const CLAUDE_CALL_MATCHER = "Bash|Edit|Write|MultiEdit|NotebookEdit|AskUserQuestion";
const CLAUDE_CALL_HOOK: HookConfig = {
  type: "command",
  command: `bun run ${INSTALL_DIR}/hooks/scripts/telegram-auth.ts`,
};

/**
 * Check if a hook entry is ours
 */
function isClaudeCallHook(hook: HookConfig): boolean {
  return hook.command?.includes("telegram-auth.ts") || false;
}

/**
 * Check if a matcher entry contains our hook
 */
function hasClaudeCallHook(matcher: HookMatcher): boolean {
  return matcher.hooks?.some(isClaudeCallHook) || false;
}

/**
 * Merge our hook configuration into existing settings
 */
function mergeHooks(settings: ClaudeSettings): ClaudeSettings {
  // Deep clone to avoid mutations
  const result: ClaudeSettings = JSON.parse(JSON.stringify(settings));

  // Initialize hooks structure if not present
  if (!result.hooks) {
    result.hooks = {};
  }

  if (!result.hooks.PreToolUse) {
    result.hooks.PreToolUse = [];
  }

  // Check if our hook already exists
  const existingMatcherIndex = result.hooks.PreToolUse.findIndex(
    (m) => m.matcher === CLAUDE_CALL_MATCHER && hasClaudeCallHook(m)
  );

  if (existingMatcherIndex >= 0) {
    // Update existing entry
    const existingMatcher = result.hooks.PreToolUse[existingMatcherIndex];

    // Remove old claude-call hooks
    existingMatcher.hooks = existingMatcher.hooks.filter((h) => !isClaudeCallHook(h));

    // Add our hook
    existingMatcher.hooks.push(CLAUDE_CALL_HOOK);

    console.log("✓ Updated existing Claude-Call hook configuration");
  } else {
    // Check if there's a matching matcher with same pattern
    const matchingPatternIndex = result.hooks.PreToolUse.findIndex(
      (m) => m.matcher === CLAUDE_CALL_MATCHER
    );

    if (matchingPatternIndex >= 0) {
      // Add our hook to existing matcher
      result.hooks.PreToolUse[matchingPatternIndex].hooks.push(CLAUDE_CALL_HOOK);
      console.log("✓ Added Claude-Call hook to existing matcher");
    } else {
      // Add new matcher entry
      result.hooks.PreToolUse.push({
        matcher: CLAUDE_CALL_MATCHER,
        hooks: [CLAUDE_CALL_HOOK],
      });
      console.log("✓ Created new Claude-Call hook configuration");
    }
  }

  return result;
}

async function main() {
  console.log("Claude-Call Hook Configuration Tool\n");

  // Check if .claude directory exists
  if (!existsSync(CLAUDE_DIR)) {
    await Bun.write(CLAUDE_DIR + "/.gitkeep", "");
    console.log(`Created ${CLAUDE_DIR}`);
  }

  // Read existing settings or create new
  let settings: ClaudeSettings = {};

  if (existsSync(SETTINGS_FILE)) {
    try {
      const content = await Bun.file(SETTINGS_FILE).text();
      settings = JSON.parse(content);
      console.log(`Loaded existing settings from ${SETTINGS_FILE}`);
    } catch (error) {
      console.error(`Warning: Could not parse existing settings: ${error}`);
      console.log("Creating new settings file...");
    }
  } else {
    console.log("No existing settings file found, creating new one...");
  }

  // Merge our hooks
  const mergedSettings = mergeHooks(settings);

  // Write back
  await Bun.write(SETTINGS_FILE, JSON.stringify(mergedSettings, null, 2) + "\n");

  console.log(`\nSettings saved to ${SETTINGS_FILE}`);
  console.log("\nHook configuration:");
  console.log(`  Matcher: ${CLAUDE_CALL_MATCHER}`);
  console.log(`  Command: ${CLAUDE_CALL_HOOK.command}`);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

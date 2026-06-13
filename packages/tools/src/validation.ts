// @taor/tools — shared tool name validation
//
// Extracted from descriptor.ts and registry.ts (both used inline copies).
// Single source of truth for the tool name regex and validation logic.

/**
 * Tool names must be compatible with Anthropic/OpenAI API requirements:
 * `^[a-zA-Z0-9_-]{1,64}$` — letters, digits, underscores, hyphens only.
 */
export const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Validate a tool name against provider API naming rules.
 *
 * Throws with a clear error message if the name is invalid.
 * Called at `defineTool()` time (fast-fail), `Tool.toDescriptor()` time,
 * and `ToolRegistry.register()` time (canonical gate).
 *
 * @throws {Error} if name is empty, not a string, or doesn't match the required pattern.
 */
export function validateToolName(name: string): void {
  if (!name || typeof name !== "string") {
    throw new Error(
      `Tool name must be a non-empty string, got: ${JSON.stringify(name)}`,
    )
  }
  if (!TOOL_NAME_RE.test(name)) {
    throw new Error(
      `Invalid tool name: "${name}". Tool names must match ` +
        `/^[a-zA-Z0-9_-]{1,64}$/ (letters, digits, underscores, hyphens; ` +
        `1–64 characters).`,
    )
  }
}

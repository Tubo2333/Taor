// @harness/permission — glob pattern matching for tool name rules
//
// TG0: Self-contained implementation — no external glob library dependency.
// Handles only the patterns needed for PermissionRule matching:
//   - Exact match: "ReadFile"
//   - Wildcard: "Write*", "*File", "*"
//   - Character class: not supported (TG0 limitation)
//
// TG1: Replace with micromatch or similar if full glob support is needed.

/**
 * Convert a glob pattern to a RegExp.
 *
 * Supported syntax:
 * - `*` matches zero or more characters (except newline)
 * - All other characters are treated as literal (regex-escaped)
 *
 * Does NOT support: `?`, `[...]`, `{...}`, `**` (TG0 limitation).
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = ""
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === "*") {
      regexStr += ".*"
    } else {
      // Escape regex-special characters.
      // TG0: Uses `ch.replace(/[...]/g,...)` per-character — this is O(n·k)
      // where k = regex character class size (~15). For TG0's expected rule
      // count (≤100) and pattern lengths (≤64), the overhead is negligible.
      // TG1: Replace with Set.has() or micromatch if glob matching becomes
      // a hot path.
      regexStr += ch.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&")
    }
  }
  return new RegExp(`^${regexStr}$`)
}

/**
 * Test a string against a glob pattern.
 *
 * @param pattern — glob pattern (e.g. "Write*", "*File", "ReadFile")
 * @param str — the string to test (e.g. tool name)
 * @returns true if the string matches the pattern
 */
export function matchesGlob(pattern: string, str: string): boolean {
  return globToRegex(pattern).test(str)
}

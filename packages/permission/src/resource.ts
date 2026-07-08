// @taor/permission — @resource annotation parser + constraint matcher

import type { ToolDescriptor, JSONSchemaProperty } from "@taor/tools"
import { matchesGlob } from "./glob.js"

/**
 * Standard resource annotation types embedded in JSONSchema descriptions.
 * Format: @resource:<type>
 */
export const RESOURCE_TYPES = [
  "@resource:fs-path",
  "@resource:url",
  "@resource:shell-command",
  "@resource:env-var",
] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

/**
 * Regex to match @resource:<type> in description strings.
 *
 * Requires `@resource:` to appear at the start of the string or after whitespace,
 * reducing false matches when users write natural descriptions containing
 * the literal text `@resource:` (e.g. "A file path pointing to @resource:fs-path storage").
 *
 * Group 1 captures the full `@resource:<type>` token (without leading whitespace).
 * See I-3 in Step 8 review.
 */
const RESOURCE_RE = /(?:^|\s)(@resource:(?:fs-path|url|shell-command|env-var))/

/**
 * Extract @resource annotations from a ToolDescriptor's JSONSchema.
 *
 * Walks `tool.parameters.properties` and for each property, checks whether
 * its `description` string contains a `@resource:<type>` marker anchored at
 * word boundaries (line start or whitespace before the marker).
 *
 * ## Known limitation (API-D8)
 *
 * Uses regex on the description string. A description written as
 * `"This is a @resource:fs-path parameter"` could still match because there
 * is whitespace before `@resource:`. TG1 should migrate to Zod `.annotations()`
 * or a custom metadata field on JSONSchemaProperty.
 *
 * @returns Map of parameter name → ResourceType. Empty map if no annotations found.
 */
export function extractResourceAnnotations(
  tool: ToolDescriptor,
): Map<string, ResourceType> {
  const result = new Map<string, ResourceType>()
  const props = tool.parameters.properties
  if (!props) return result

  for (const [paramName, prop] of Object.entries(props)) {
    const desc = (prop as JSONSchemaProperty).description
    if (typeof desc !== "string") continue

    const match = RESOURCE_RE.exec(desc)
    if (match) {
      // match[1] = capture group 1: "@resource:<type>" (no leading whitespace)
      result.set(paramName, match[1] as ResourceType)
    }
  }

  return result
}

/**
 * Match a parameter value against a resource constraint (allowlist / denylist).
 *
 * Evaluation order:
 * 1. If denylist is provided and the value matches any denylist glob → deny
 * 2. If allowlist is provided and the value matches any allowlist glob → allow
 * 3. If allowlist is provided but value matches none → deny (not in allowlist)
 * 4. Neither provided → allow
 *
 * @param value — the actual parameter value (file path, URL, command, env var name)
 * @param constraint — { allowlist?, denylist? } with glob patterns
 * @returns verdict with `allowed` flag and human-readable `reason`
 */
export function matchResourceConstraint(
  value: string,
  constraint: { allowlist?: string[]; denylist?: string[] },
): { allowed: boolean; reason: string } {
  // ── Denylist check (takes priority) ──
  if (constraint.denylist && constraint.denylist.length > 0) {
    for (const pattern of constraint.denylist) {
      if (matchesGlob(pattern, value)) {
        return {
          allowed: false,
          reason: `"${value}" matches denylist pattern "${pattern}"`,
        }
      }
    }
  }

  // ── Allowlist check ──
  if (constraint.allowlist && constraint.allowlist.length > 0) {
    for (const pattern of constraint.allowlist) {
      if (matchesGlob(pattern, value)) {
        return {
          allowed: true,
          reason: `"${value}" matches allowlist pattern "${pattern}"`,
        }
      }
    }
    // Not in allowlist → deny
    return {
      allowed: false,
      reason: `"${value}" is not in the allowlist`,
    }
  }

  // ── Neither allowlist nor denylist → allow ──
  return {
    allowed: true,
    reason: "No resource constraints to match against",
  }
}

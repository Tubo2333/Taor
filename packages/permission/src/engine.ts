// @harness/permission — PermissionEngine

import type { ToolDescriptor, RiskLevel } from "@harness/tools"
import type { PermissionRule, PermissionVerdict, PermissionConfig, PermissionLevel } from "./types.js"
import { extractResourceAnnotations, matchResourceConstraint, type ResourceType } from "./resource.js"
import { matchesGlob } from "./glob.js"

// ═══════════════════════════════════════════════════════════════════
// ─── Defaults ───
// ═══════════════════════════════════════════════════════════════════

const DEFAULTS: PermissionConfig = {
  mode: "interactive",
  rules: [],
  defaultLevel: "ask",
  allowlist: [],
  denylist: [],
  nonInteractiveDefault: "deny",
  approvalTimeout: 120,
}

// ═══════════════════════════════════════════════════════════════════
// ─── PermissionEngine ───
// ═══════════════════════════════════════════════════════════════════

/**
 * PermissionEngine — evaluates tool calls against permission rules.
 *
 * ## 4-tier permission model
 *
 * | Level | Behavior |
 * |-------|----------|
 * | deny | Refuse execution. No user prompt. |
 * | boundary | Ask only if the tool touches resources outside allowed boundaries. @resource annotations required. |
 * | allow | Execute without asking. |
 * | ask | Always ask the user before executing. |
 *
 * ## Matching algorithm (§8.4)
 *
 * ```
 * 1. Session/turn scope overrides → immediate allow/deny
 * 2. Denylist first → matching rule ⇒ DENY
 * 3. Allowlist next → matching rule ⇒ ALLOW
 * 4. Rules in order (first match wins):
 *    a. Glob match tool name
 *    b. Risk filter (if set)
 *    c. Resource constraints (for boundary level)
 *    d. Apply rule level (boundary without @resource → downgraded to ask)
 * 5. No rule matched → defaultLevel
 * ```
 *
 * ## Internal tool descriptor map
 *
 * The engine holds a `Map<string, ToolDescriptor>` populated at construction
 * time (or via `registerTool()`). `evaluate()` looks up tool descriptors by
 * name to extract @resource annotations for resourceConstraints matching.
 */
export class PermissionEngine {
  // ── Tool descriptors (for @resource annotation extraction) ──
  private toolDescriptors = new Map<string, ToolDescriptor>()

  // ── Rule storage ──
  private rules: PermissionRule[]
  private denylist: PermissionRule[]
  private allowlist: PermissionRule[]

  // ── Configuration ──
  private defaultLevel: PermissionLevel
  private nonInteractiveDefault: "allow" | "deny"
  private approvalTimeout: number
  private mode: "interactive" | "non-interactive" | "custom"

  // ── Scope overrides ──
  private sessionOverride: { allowAll?: boolean; denyAll?: boolean } = {}
  private turnOverride: { allowAll?: boolean; denyAll?: boolean } = {}

  /**
   * @param config — Partial permission configuration. Defaults are filled for all missing fields.
   * @param tools — Optional array of tool descriptors to populate the internal lookup map.
   *   Tools can also be added later via `registerTool()`.
   */
  constructor(
    config: Partial<PermissionConfig> = {},
    tools?: readonly ToolDescriptor[],
  ) {
    // ── Fill defaults ──
    this.mode = config.mode ?? DEFAULTS.mode
    this.rules = config.rules ?? [...DEFAULTS.rules]
    this.defaultLevel = config.defaultLevel ?? DEFAULTS.defaultLevel
    // TG0: Allowlist/denylist are optional in PermissionConfig but stored as arrays.
    // The undefined case is normalized to empty arrays at construction time.
    this.allowlist = config.allowlist ?? []
    this.denylist = config.denylist ?? []
    // TS strict: optional field from Partial<> retains |undefined in ternary.
    // Explicit assertion needed — the ?? operator has the same issue.
    this.nonInteractiveDefault = (config.nonInteractiveDefault ??
      DEFAULTS.nonInteractiveDefault) as "allow" | "deny"
    this.approvalTimeout = config.approvalTimeout ?? DEFAULTS.approvalTimeout

    // ── Populate tool descriptor map ──
    if (tools) {
      for (const t of tools) {
        this.toolDescriptors.set(t.name, t)
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Tool descriptor management ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Register a tool descriptor for @resource annotation lookup.
   * Call after construction if tools weren't provided to the constructor,
   * or when tools are added dynamically at runtime.
   */
  registerTool(tool: ToolDescriptor): void {
    this.toolDescriptors.set(tool.name, tool)
  }

  /**
   * Remove a tool descriptor from the lookup map.
   */
  unregisterTool(name: string): boolean {
    return this.toolDescriptors.delete(name)
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Core evaluation ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Evaluate a tool call against the permission rules.
   *
   * Uses the internal tool descriptor map to resolve @resource annotations
   * for resourceConstraints matching (boundary level only).
   *
   * @param tool — tool name (e.g. "WriteFile", "Bash")
   * @param params — the tool call arguments
   * @returns PermissionVerdict with level, reason, and the matching rule (if any)
   */
  evaluate(tool: string, params: Record<string, unknown>): PermissionVerdict {
    // ── Step 0: Scope overrides (session > turn) ──
    if (this.sessionOverride.denyAll || this.turnOverride.denyAll) {
      const scope = this.sessionOverride.denyAll ? "session" : "turn"
      return {
        level: "deny",
        reason: `All tools denied for this ${scope} by scope override`,
      }
    }
    if (this.sessionOverride.allowAll || this.turnOverride.allowAll) {
      const scope = this.sessionOverride.allowAll ? "session" : "turn"
      return {
        level: "allow",
        reason: `All tools allowed for this ${scope} by scope override`,
      }
    }

    // ── Resolve tool descriptor once (used by all matchRisk calls) ──
    const toolDesc = this.toolDescriptors.get(tool) ?? null

    // ── Step 1: Denylist first — matching rule → immediate DENY ──
    for (const rule of this.denylist) {
      if (matchesGlob(rule.pattern, tool)) {
        if (!this.matchRisk(rule, toolDesc?.risk ?? null, "denylist")) continue
        return {
          level: "deny",
          reason: rule.reason ?? `Tool "${tool}" matches denylist pattern "${rule.pattern}"`,
          rule,
        }
      }
    }

    // ── Step 2: Allowlist next — matching rule → immediate ALLOW ──
    for (const rule of this.allowlist) {
      if (matchesGlob(rule.pattern, tool)) {
        if (!this.matchRisk(rule, toolDesc?.risk ?? null, "allowlist")) continue
        return {
          level: "allow",
          reason: rule.reason ?? `Tool "${tool}" matches allowlist pattern "${rule.pattern}"`,
          rule,
        }
      }
    }

    // ── Step 3: Rules in order (first match wins) ──
    for (const rule of this.rules) {
      // 3a. Pattern match on tool name
      if (!matchesGlob(rule.pattern, tool)) continue

      // 3b. Risk filter (if set on rule)
      if (!this.matchRisk(rule, toolDesc?.risk ?? null, "rules")) continue

      // 3c. Resource constraints (for boundary level)
      if (rule.level === "boundary" && rule.resourceConstraints) {
        const annotations = toolDesc
          ? extractResourceAnnotations(toolDesc)
          : new Map<string, ResourceType>()

        // If tool has no @resource annotations, boundary cannot be enforced —
        // downgrade to "ask" per API spec §8.2
        if (annotations.size === 0) {
          return {
            level: "ask",
            reason:
              `Tool "${tool}" matched boundary rule "${rule.pattern}" but has no ` +
              `@resource annotations — downgrading to ask`,
            rule,
          }
        }

        // Find the parameter annotated with the required resource type
        const { paramAnnotation, allowlist: resAllowlist, denylist: resDenylist } =
          rule.resourceConstraints

        let constrainedParam: string | null = null
        for (const [param, resourceType] of annotations) {
          if (resourceType === paramAnnotation) {
            constrainedParam = param
            break
          }
        }

        if (!constrainedParam) {
          // Tool doesn't have the required annotation type
          return {
            level: "deny",
            reason:
              `Tool "${tool}" has no parameter annotated with ${paramAnnotation}, ` +
              `required by boundary rule`,
            rule,
          }
        }

        // Evaluate the parameter value against resource constraints
        const paramValue = params[constrainedParam]
        if (typeof paramValue !== "string") {
          return {
            level: "deny",
            reason:
              `Resource-constrained parameter "${constrainedParam}" is not a string ` +
              `(got ${typeof paramValue})`,
            rule,
          }
        }

        const constraintResult = matchResourceConstraint(paramValue, {
          allowlist: resAllowlist,
          denylist: resDenylist,
        })

        if (!constraintResult.allowed) {
          return {
            level: "deny",
            reason: constraintResult.reason,
            rule,
          }
        }

        // Resource constraint passed — apply boundary level
        return {
          level: "boundary",
          reason:
            rule.reason ??
            `Tool "${tool}" matched boundary rule "${rule.pattern}" (resource check passed)`,
          rule,
        }
      }

      // 3d. Non-boundary with matching resourceConstraints — apply rule level
      if (rule.resourceConstraints && rule.level !== "boundary") {
        // Resource constraints on non-boundary rules: evaluate as a gate.
        // If the constraint check fails, skip this rule (try next).
        // If it passes, apply the rule's level.
        const toolDesc2 = this.toolDescriptors.get(tool)
        if (!toolDesc2) {
          // Tool not found — can't verify resource constraints, skip this rule
          continue
        }
        const annotations = extractResourceAnnotations(toolDesc2)
        const { paramAnnotation, allowlist: resAllowlist, denylist: resDenylist } =
          rule.resourceConstraints

        let constrainedParam: string | null = null
        for (const [param, resourceType] of annotations) {
          if (resourceType === paramAnnotation) {
            constrainedParam = param
            break
          }
        }
        if (!constrainedParam) continue

        const paramValue = params[constrainedParam]
        if (typeof paramValue !== "string") continue

        const constraintResult = matchResourceConstraint(paramValue, {
          allowlist: resAllowlist,
          denylist: resDenylist,
        })
        if (!constraintResult.allowed) continue
      }

      // 3e. Rule matched — apply its level
      return {
        level: rule.level,
        reason:
          rule.reason ??
          `Tool "${tool}" matched rule "${rule.pattern}" (level: ${rule.level})`,
        rule,
      }
    }

    // ── Step 4: No rule matched → defaultLevel ──
    return {
      level: this.defaultLevel,
      reason: `No rule matched for "${tool}" — using default level "${this.defaultLevel}"`,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Rule management ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Add a permission rule dynamically.
   * Rules are evaluated in order — later rules are checked after earlier ones.
   */
  addRule(rule: PermissionRule): void {
    this.rules.push(rule)
  }

  /**
   * Remove all rules matching a tool name pattern.
   *
   * @param pattern — glob pattern matching the rule's `pattern` field
   * @returns number of rules removed
   */
  removeRule(pattern: string): number {
    const before = this.rules.length
    this.rules = this.rules.filter((r) => !matchesGlob(pattern, r.pattern))
    return before - this.rules.length
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Scope overrides ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Allow all tool calls for the given scope.
   * Overrides all rules for the duration of the scope.
   *
   * - `"turn"`: reset on next `resetScope()` or turn boundary
   * - `"session"`: persists until `resetScope()` or session end
   */
  allowAll(scope: "turn" | "session"): void {
    if (scope === "session") {
      this.sessionOverride.allowAll = true
      this.sessionOverride.denyAll = false
    } else {
      this.turnOverride.allowAll = true
      this.turnOverride.denyAll = false
    }
  }

  /**
   * Deny all tool calls for the given scope.
   * Overrides all rules for the duration of the scope.
   *
   * - `"turn"`: reset on next `resetScope()` or turn boundary
   * - `"session"`: persists until `resetScope()` or session end
   */
  denyAll(scope: "turn" | "session"): void {
    if (scope === "session") {
      this.sessionOverride.denyAll = true
      this.sessionOverride.allowAll = false
    } else {
      this.turnOverride.denyAll = true
      this.turnOverride.allowAll = false
    }
  }

  /**
   * Reset turn-level scope overrides.
   * Session-level overrides persist (call `allowAll("session")` or
   * `denyAll("session")` with opposite action to clear them).
   */
  resetScope(): void {
    this.turnOverride = {}
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Queries ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if the engine is in a non-interactive mode.
   * When true, calls to `evaluate()` should use `nonInteractiveDefault`
   * instead of prompting the user.
   */
  get isInteractive(): boolean {
    return this.mode === "interactive"
  }

  /**
   * The fallback level for non-interactive mode.
   */
  get fallbackLevel(): "allow" | "deny" {
    return this.nonInteractiveDefault
  }

  /**
   * Timeout in seconds before an approval request is auto-denied.
   */
  get approvalTimeoutSeconds(): number {
    return this.approvalTimeout
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Helpers ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if a tool's risk level matches a rule's risk filter.
   *
   * The fallback for unknown tool risk depends on the evaluation context:
   * - `"denylist"`: unknown risk → assume "high" (conservative: deny unknown tools)
   * - `"allowlist"`: unknown risk → assume "low" (conservative: don't auto-allow risky unknowns)
   * - `"rules"`: unknown risk → assume "medium" (neutral)
   *
   * @param rule — the rule with optional risk filter
   * @param toolRisk — the tool's declared risk level (null if tool not found)
   * @param context — which evaluation phase is calling (denylist/allowlist/rules)
   * @returns true if the risk filter passes (or if no filter is set)
   */
  private matchRisk(
    rule: PermissionRule,
    toolRisk: RiskLevel | null,
    context: "denylist" | "allowlist" | "rules" = "rules",
  ): boolean {
    if (rule.risk === undefined) return true

    const allowed = Array.isArray(rule.risk) ? rule.risk : [rule.risk]

    // Conservative fallback depends on context:
    // - denylist: unknown tool → assume high (more likely to deny)
    // - allowlist: unknown tool → assume low (less likely to auto-allow)
    // - rules: unknown tool → assume medium (neutral)
    const effectiveRisk = toolRisk ?? (
      context === "denylist" ? "high" :
      context === "allowlist" ? "low" :
      "medium"
    )

    return allowed.includes(effectiveRisk)
  }
}

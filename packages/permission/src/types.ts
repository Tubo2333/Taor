// @taor/permission — type definitions

import type { RiskLevel } from "@taor/tools"

export type PermissionLevel = "deny" | "boundary" | "allow" | "ask"

export interface PermissionRule {
  level: PermissionLevel
  /** Match tool name, supports glob: "Write*", "ReadFile", "*" */
  pattern: string
  /** Resource constraints — only active if tool params declare @resource: annotations */
  resourceConstraints?: {
    paramAnnotation: string
    allowlist?: string[]
    denylist?: string[]
  }
  risk?: RiskLevel | RiskLevel[]
  reason?: string
}

export interface PermissionConfig {
  mode: "interactive" | "non-interactive" | "custom"
  rules: PermissionRule[]
  defaultLevel: PermissionLevel
  allowlist?: PermissionRule[]
  denylist?: PermissionRule[]
  nonInteractiveDefault?: "allow" | "deny"
  approvalTimeout: number
}

export interface PermissionVerdict {
  level: PermissionLevel
  reason: string
  rule?: PermissionRule
}

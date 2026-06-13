// @harness/tools — public API
export { defineTool, tool } from "./descriptor.js"
export { Tool } from "./base.js"
export type { ToolDescriptor, ToolResult, ToolResultMeta, ToolErrorCode, ToolContext, JSONSchema, JSONSchemaProperty, RetryPolicy, PermissionHint, RiskLevel, ApprovalPredicate, ToolInput, ToolConstructor } from "./types.js"
export { ToolRegistry } from "./registry.js"
export { validateToolName } from "./validation.js"
// Builtin tools — TG0 placeholder, re-export when implemented:
// export * from "./builtin/index.js"

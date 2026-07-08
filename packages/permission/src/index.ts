// @taor/permission — public API
export { PermissionEngine } from "./engine.js"
export type { PermissionConfig, PermissionRule, PermissionVerdict, PermissionLevel } from "./types.js"
export {
  extractResourceAnnotations,
  matchResourceConstraint,
  RESOURCE_TYPES,
} from "./resource.js"
export type { ResourceType } from "./resource.js"
export { matchesGlob } from "./glob.js"

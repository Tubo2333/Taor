# Permission API Reference

> 4-tier permission engine (deny/boundary/allow/ask) with `@resource` annotations.

## Permission Levels

| Level | Behavior |
|-------|----------|
| `deny` | Block immediately, no user prompt |
| `boundary` | Block if tool accesses resources outside allowed boundaries |
| `allow` | Auto-approve, skip user prompt |
| `ask` | Prompt user for approval (default) |

---

## Configuration

```typescript
const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [],
  permission: {
    defaultLevel: "ask",
    mode: "interactive",
    approvalTimeout: 120,
  },
})
```

---

## Runtime API

```typescript
// Via harness.permission
harness.permission.evaluate("read_file", { path: "/etc/passwd" })
// → { level: "deny", reason: "Path not in allowlist" }

harness.permission.addRule({
  level: "allow",
  pattern: "read_file:*",
  reason: "Reading files is safe",
})

harness.permission.removeRule("read_file:*")
harness.permission.allowAll("turn")     // Auto-approve for current turn
harness.permission.denyAll("session")    // Deny all for current session
harness.permission.resetScope()          // Clear turn-level overrides
```

---

## Rule Structure

```typescript
interface PermissionRule {
  level: "deny" | "boundary" | "allow" | "ask"
  pattern: string              // Glob pattern matching "tool:resource"
  resourceConstraints?: {
    paramAnnotation: string    // Which parameter holds the resource path
    allowlist?: string[]       // Allowed values
    denylist?: string[]        // Blocked values
  }
  risk?: string | string[]     // Matched risk levels
  reason?: string              // Human-readable explanation
}
```

---

## Permission Flow

1. ACT phase begins for a tool call
2. Permission engine evaluates the tool + parameters against all rules
3. Rule match = immediate verdict (deny/allow/boundary)
4. No rule match → falls through to built-in risk-based check
5. High-risk tools or `requiresApproval=true` → user prompt
6. User decision (allow/deny/approve-all) flows back to TAOR loop

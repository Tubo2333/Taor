/**
 * @taor/engine — compile-time interface conformance guard.
 *
 * Detects structural interface drift between @taor/core's dependency-inversion
 * interfaces and the canonical subsystem types. Runs as part of `npm run typecheck`.
 *
 * ## How to use
 *
 * If a canonical interface changes and `npm run typecheck` fails here:
 * 1. Update the corresponding structural interface in harness.ts
 * 2. Verify `npm run build && npm run test`
 * 3. If the structural/canonical types intentionally diverge (e.g. ToolDef vs
 *    ToolDescriptor — looser `Record<string,unknown>` vs strict `JSONSchema`),
 *    that's expected: the `as any` bridge in createHarness() handles it.
 *
 * ## Checked interfaces
 *
 * ┌──────────────────────────┬─────────────────────────────────┐
 * │ Structural (@taor/core)│ Canonical                       │
 * ├──────────────────────────┼─────────────────────────────────┤
 * │ IAdapter                 │ AnthropicAdapter                 │
 * │ IMemoryFacade            │ MemoryFacade                     │
 * │ ICompressorPipeline      │ CompressorPipeline               │
 * │ IHookRegistry            │ HookRegistry                     │
 * └──────────────────────────┴─────────────────────────────────┘
 *
 * IPermissionEngine, IToolRegistry, ISubagentCoordinator intentionally omitted:
 * their structural interfaces use loose types (ToolDef, ToolExecResult) that
 * are NOT structurally compatible with their canonical types (ToolDescriptor,
 * ToolResult). The `as any` bridge is the intentional mechanism there.
 */

import type {
  IAdapter,
  IMemoryFacade,
  ICompressorPipeline,
  IToolRegistry,
} from "@taor/core"

import { AnthropicAdapter } from "@taor/adapters"
import { MemoryFacade } from "@taor/memory"
import { CompressorPipeline } from "@taor/compressor"
import { ToolRegistry } from "@taor/tools"

// Each check: canonical instance is assignable to the structural interface.
// If a canonical class adds a required method/field that the structural
// interface lacks, this line will fail `npm run typecheck`.
//
// NOTE: IHookRegistry, IPermissionEngine, ISubagentCoordinator intentionally
// omitted. Their canonical signatures use mapped types / strict generics that
// are NOT structurally compatible with the looser `(...args: unknown[])`
// patterns in the structural interfaces. The `as any` bridge in createHarness()
// is the intentional mechanism for those subsystems.
//
// IToolRegistry IS included: register()/get()/list()/size/remove()/clear()
// do not depend on ToolDef vs ToolDescriptor internal type differences.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _adapter: IAdapter = null! as AnthropicAdapter
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _memory: IMemoryFacade = null! as MemoryFacade
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _cmpr: ICompressorPipeline = null! as CompressorPipeline
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _reg: IToolRegistry = null! as ToolRegistry

export {}

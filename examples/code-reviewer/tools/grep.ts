/**
 * grep tool — search source code with regex patterns.
 *
 * Demonstrates: low-risk tool, fs-read permission, fallback strategy (rg → grep/findstr).
 */

import { defineTool } from "@taor/engine"
import { z } from "zod"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const grepTool = defineTool({
  name: "grep",
  description:
    "Search for a regex pattern across files. Uses ripgrep (rg) if available, falls back to grep/findstr.",
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for. Supports standard regex syntax."),
    path: z
      .string()
      .optional()
      .describe("Directory or file to search in. Defaults to the current working directory."),
    glob: z
      .string()
      .optional()
      .describe("Glob pattern to filter files (e.g., '*.ts', '*.{js,ts}'). Maps to rg --glob."),
    ignore_case: z
      .boolean()
      .optional()
      .describe("Case-insensitive search. Default: false."),
  }),
  permissions: ["fs-read"],
  risk: "low",

  async execute(params, ctx) {
    const start = Date.now()
    const searchPath = params.path ?? "."
    const args: string[] = ["-n", "--no-heading"]

    if (params.ignore_case) args.push("-i")
    if (params.glob) args.push("--glob", params.glob)
    args.push(params.pattern, searchPath)

    // Try ripgrep first (fast, handles large codebases well)
    try {
      const { stdout } = await execFileAsync("rg", args, {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      })

      const lines = stdout.trim().split("\n").filter(Boolean)
      const truncated = lines.length > 500

      return {
        ok: true,
        data: {
          pattern: params.pattern,
          path: searchPath,
          matches: truncated ? lines.slice(0, 500) : lines,
          matchCount: lines.length,
        },
        meta: { duration: Date.now() - start, truncated },
      }
    } catch (err: any) {
      // ripgrep not installed — try fallback
      if (err?.code === "ENOENT") {
        try {
          const isWindows = process.platform === "win32"
          const tool = isWindows ? "findstr" : "grep"
          const fallbackArgs: string[] = isWindows
            ? ["/N", "/R", params.ignore_case ? "/I" : "", params.pattern, searchPath].filter(Boolean)
            : ["-rn", ...(params.ignore_case ? ["-i"] : []), params.pattern, searchPath]

          const { stdout } = await execFileAsync(tool, fallbackArgs, {
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024,
          })

          const lines = stdout.trim().split("\n").filter(Boolean)
          const truncated = lines.length > 500

          return {
            ok: true,
            data: {
              pattern: params.pattern,
              path: searchPath,
              matches: truncated ? lines.slice(0, 500) : lines,
              matchCount: lines.length,
            },
            meta: { duration: Date.now() - start, truncated },
          }
        } catch (fallbackErr) {
          return {
            ok: false,
            error: `Search failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
            code: "execution_failed",
            recoverable: true,
          }
        }
      }

      // rg exit code 1 = no matches (not an error)
      if (err?.code === 1 && !err?.stderr) {
        return {
          ok: true,
          data: {
            pattern: params.pattern,
            path: searchPath,
            matches: [],
            matchCount: 0,
          },
          meta: { duration: Date.now() - start, truncated: false },
        }
      }

      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: "execution_failed",
        recoverable: true,
      }
    }
  },
})

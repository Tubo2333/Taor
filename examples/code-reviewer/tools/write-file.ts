/**
 * write-file tool — writes a code change to a file.
 *
 * Demonstrates:
 * - HIGH risk tool (mutates filesystem)
 * - requiresApproval=true (HITL gating — user must approve every write)
 * - fs-write permission
 * - onBeforeExecute hook for pre-flight path validation
 */

import { defineTool } from "@taor/engine"
import { z } from "zod"
import { writeFile } from "node:fs/promises"

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Write a code change to a file. ALWAYS explain your reasoning before calling this tool. " +
    "The user will be prompted to approve each write operation before it executes.",
  parameters: z.object({
    file_path: z
      .string()
      .describe("Path to the file to write"),
    content: z
      .string()
      .describe("The new file content to write"),
    reason: z
      .string()
      .optional()
      .describe("A brief explanation of why this change is being made"),
  }),
  permissions: ["fs-write"],
  risk: "high",
  requiresApproval: true,

  onBeforeExecute: async (params, _ctx) => {
    const path = params.file_path as string
    if (path.includes("\0")) {
      throw new Error("Null byte in path — potential injection attempt")
    }
  },

  async execute(params, ctx) {
    const start = Date.now()
    try {
      await writeFile(params.file_path, params.content, "utf-8")

      const bytesWritten = Buffer.byteLength(params.content, "utf-8")
      return {
        ok: true,
        data: {
          path: params.file_path,
          bytesWritten,
          message: `File written successfully (${bytesWritten} bytes)`,
        },
        meta: {
          duration: Date.now() - start,
          artifacts: [params.file_path],
        },
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: "execution_failed",
        recoverable: true,
      }
    }
  },
})

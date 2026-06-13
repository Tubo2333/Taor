/**
 * read-file tool — reads a file from the local filesystem.
 *
 * Demonstrates: low-risk tool, fs-read permission, line-range support.
 */

import { defineTool } from "@harness/engine"
import { z } from "zod"
import { readFile } from "node:fs/promises"

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read the contents of a file. Use this to inspect source code before proposing changes. " +
    "Supports reading the whole file or a specific line range.",
  parameters: z.object({
    file_path: z
      .string()
      .describe("Absolute or relative path to the file to read"),
    start_line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Line number to start reading from (1-indexed). Omit to read from the beginning."),
    line_count: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe("Maximum number of lines to read. Use with start_line for partial reads. Max 2000."),
  }),
  permissions: ["fs-read"],
  risk: "low",

  async execute(params, ctx) {
    const start = Date.now()
    try {
      const content = await readFile(params.file_path, "utf-8")
      const lines = content.split("\n")

      const startLine = (params.start_line ?? 1) - 1
      const endLine = params.line_count
        ? Math.min(startLine + params.line_count, lines.length)
        : lines.length

      const selected = lines.slice(startLine, endLine)
      const result = selected
        .map((line, i) => `${String(startLine + i + 1).padStart(4, " ")}| ${line}`)
        .join("\n")

      return {
        ok: true,
        data: {
          path: params.file_path,
          totalLines: lines.length,
          startLine: startLine + 1,
          endLine,
          content: result,
        },
        meta: {
          duration: Date.now() - start,
          truncated: lines.length > endLine,
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

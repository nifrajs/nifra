/** Test adapters for typed tool contracts. Assertions stay on the shared core pipeline. */

import {
  createToolHttpHandler,
  executeTool,
  type ToolAdapter,
  type ToolAdapterResult,
  type ToolCallOptions,
  type ToolContract,
  type ToolError,
  type ToolEvidence,
} from "@nifrajs/core/tool-contract"
import { toMcpTool } from "@nifrajs/mcp"

export function inProcessToolAdapter<Input, Output>(
  tool: ToolContract<Input, Output>,
  baseOptions: ToolCallOptions = {},
): ToolAdapter {
  return {
    name: "in-process",
    call: (input, options) => executeTool(tool, input, { ...baseOptions, ...options }),
  }
}

export function testToolAdapter<Input, Output>(
  tool: ToolContract<Input, Output>,
  baseOptions: ToolCallOptions = {},
): ToolAdapter {
  return {
    name: "test",
    call: (input, options) => executeTool(tool, input, { ...baseOptions, ...options }),
  }
}

export function mcpToolAdapter<Input, Output>(
  tool: ToolContract<Input, Output>,
  baseOptions: Omit<ToolCallOptions, "signal" | "ledger"> = {},
): ToolAdapter {
  return {
    name: "mcp",
    async call(input, options) {
      const args = recordOf(input)
      if (args === undefined) throw new Error("tool adapter: MCP input must be an object")
      const mcp = toMcpTool(tool, { ...baseOptions, ...options })
      const result = await mcp.handler(args, {
        signal: options?.signal ?? new AbortController().signal,
        requestId: "test",
        reportProgress: () => {},
      })
      if (typeof result === "string") throw new Error("tool adapter: MCP returned plain text")
      const text = result.content?.find((item) => item.type === "text")
      if (text === undefined || text.type !== "text")
        throw new Error("tool adapter: MCP result has no text")
      const parsed = JSON.parse(text.text)
      const record = recordOf(parsed)
      if (result.isError === true) {
        const error = toolErrorOf(record?.error)
        return {
          ok: false,
          dryRun: record?.dryRun === true,
          error,
          evidence: evidenceOf(record?.evidence),
        }
      }
      return {
        ok: true,
        dryRun: record?.dryRun === true,
        ...(record?.output === undefined ? {} : { output: record.output }),
        evidence: evidenceOf(record?.evidence),
      }
    },
  }
}

/** Exercise the Web adapter while returning the same normalized result shape as direct calls. */
export function httpToolAdapter<Input, Output>(
  tool: ToolContract<Input, Output>,
  baseOptions: Omit<ToolCallOptions, "signal" | "ledger"> = {},
): ToolAdapter {
  return {
    name: "http",
    async call(input, options) {
      const handler = createToolHttpHandler(tool, { ...baseOptions, ...options })
      const request = new Request("http://nifra.local/tool", {
        method: "POST",
        body: JSON.stringify(input),
      })
      const response = await handler(request)
      const body = (await response.json()) as unknown
      if (response.status >= 200 && response.status < 300) {
        const record = recordOf(body)
        return {
          ok: true,
          dryRun: record?.dryRun === true,
          ...(record?.output === undefined ? {} : { output: record.output }),
          evidence: Array.isArray(record?.evidence) ? record.evidence : [],
        } satisfies ToolAdapterResult
      }
      const record = recordOf(body)
      const error = toolErrorOf(record?.error)
      return {
        ok: false,
        dryRun: record?.dryRun === true,
        error,
        evidence: Array.isArray(record?.evidence) ? record.evidence : [],
      } satisfies ToolAdapterResult
    },
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function toolErrorOf(value: unknown): ToolError {
  const record = recordOf(value)
  const code = record?.code
  const stage = record?.stage
  if (!isToolErrorCode(code) || !isToolEvidenceStage(stage)) {
    throw new Error("tool adapter: malformed error result")
  }
  return { code, stage }
}

function evidenceOf(value: unknown): readonly ToolEvidence[] {
  if (!Array.isArray(value)) return []
  const evidence: ToolEvidence[] = []
  for (const item of value) {
    const record = recordOf(item)
    if (record === undefined || typeof record.seq !== "number" || !Number.isSafeInteger(record.seq))
      continue
    if (!isToolEvidenceStage(record.stage) || !isToolEvidenceOutcome(record.outcome)) continue
    evidence.push({
      seq: record.seq,
      stage: record.stage,
      outcome: record.outcome,
      ...(typeof record.code === "string" ? { code: record.code } : {}),
    })
  }
  return evidence
}

function isToolErrorCode(value: unknown): value is ToolError["code"] {
  return (
    typeof value === "string" &&
    [
      "input_invalid",
      "capability_denied",
      "execution_policy_unsatisfied",
      "approval_required",
      "approval_denied",
      "idempotency_store_missing",
      "idempotency_durability",
      "idempotency_duplicate",
      "idempotency_in_flight",
      "idempotency_capacity",
      "budget_exceeded",
      "cancelled",
      "execution_failed",
      "output_invalid",
      "ledger_failed",
    ].includes(value)
  )
}

function isToolEvidenceStage(value: unknown): value is ToolEvidence["stage"] {
  return (
    typeof value === "string" &&
    [
      "input",
      "capability",
      "policy",
      "approval",
      "idempotency",
      "budget",
      "execution",
      "output",
    ].includes(value)
  )
}

function isToolEvidenceOutcome(value: unknown): value is ToolEvidence["outcome"] {
  return (
    typeof value === "string" &&
    ["passed", "denied", "failed", "skipped", "committed", "dry-run"].includes(value)
  )
}

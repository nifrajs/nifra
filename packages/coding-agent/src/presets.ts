import type { SubagentSpec } from "./subagents.ts"

export type AgentPresetName =
  | "planner"
  | "implementer"
  | "test-fixer"
  | "reviewer"
  | "security-reviewer"
  | "final-verifier"

export interface AgentPreset extends Omit<SubagentSpec, "id" | "prompt"> {
  readonly name: AgentPresetName
  readonly summary: string
}

const PRESETS: Readonly<Record<AgentPresetName, AgentPreset>> = Object.freeze({
  planner: {
    name: "planner",
    role: "planner",
    summary: "Break a task into bounded, verifiable phases.",
    capabilities: Object.freeze(["read"]),
    maxDepth: 1,
    timeoutMs: 120_000,
  },
  implementer: {
    name: "implementer",
    role: "implementer",
    summary: "Apply a narrowly scoped implementation and report changed files.",
    capabilities: Object.freeze(["read", "write", "process"]),
    maxDepth: 1,
    timeoutMs: 600_000,
  },
  "test-fixer": {
    name: "test-fixer",
    role: "test-fixer",
    summary: "Reproduce and repair a failing test within the task boundary.",
    capabilities: Object.freeze(["read", "write", "process"]),
    maxDepth: 1,
    timeoutMs: 600_000,
  },
  reviewer: {
    name: "reviewer",
    role: "reviewer",
    summary: "Review a proposed change for correctness and regressions.",
    capabilities: Object.freeze(["read", "process"]),
    maxDepth: 1,
    timeoutMs: 240_000,
  },
  "security-reviewer": {
    name: "security-reviewer",
    role: "security-reviewer",
    summary: "Review capabilities, trust boundaries, secrets, and process execution.",
    capabilities: Object.freeze(["read", "process"]),
    maxDepth: 1,
    timeoutMs: 240_000,
  },
  "final-verifier": {
    name: "final-verifier",
    role: "final-verifier",
    summary: "Run the configured verification gates and return structured evidence.",
    capabilities: Object.freeze(["read", "process"]),
    maxDepth: 1,
    timeoutMs: 300_000,
  },
})

export const AGENT_PRESETS = PRESETS

export function getAgentPreset(name: AgentPresetName): AgentPreset {
  return PRESETS[name]
}

export function createPresetSpec(
  name: AgentPresetName,
  prompt: string,
  id = `${name}-${Date.now().toString(36)}`,
): SubagentSpec {
  const preset = getAgentPreset(name)
  if (!prompt || prompt.length > 16_384)
    throw new TypeError("agent preset: prompt is empty or too long")
  if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(id)) throw new TypeError("agent preset: id is invalid")
  return {
    id,
    role: preset.role,
    prompt,
    ...(preset.capabilities === undefined ? {} : { capabilities: preset.capabilities }),
    ...(preset.maxDepth === undefined ? {} : { maxDepth: preset.maxDepth }),
    ...(preset.timeoutMs === undefined ? {} : { timeoutMs: preset.timeoutMs }),
  }
}

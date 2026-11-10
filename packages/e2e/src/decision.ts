import type { Selector, Step } from "./engine.ts"
import { isRecord } from "./internal/record.ts"

/** Which control a step means: exactly one of `role`, `label`, `text`, `testId`. */
export interface Target {
  readonly role?: string
  readonly name?: string
  readonly label?: string
  readonly text?: string
  readonly testId?: string
  readonly exact?: boolean
  /** Zero-based pick among several matches. */
  readonly nth?: number
}

export type ActDecision =
  | { readonly kind: "tap"; readonly target: Target }
  | { readonly kind: "fill"; readonly target: Target; readonly value: string }
  | { readonly kind: "press"; readonly target: Target; readonly key: string }
  | { readonly kind: "goto"; readonly path: string }
  | { readonly kind: "done"; readonly summary?: string }
  | { readonly kind: "fail"; readonly reason: string }

export type PerformedDecision = Exclude<ActDecision, { kind: "done" } | { kind: "fail" }>

export interface Verdict {
  readonly pass: boolean | "inconclusive"
  readonly reason: string
}

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string }

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

function parseTarget(raw: unknown): Parsed<Target> {
  if (!isRecord(raw)) return fail("target must be an object")
  const finders = (["role", "label", "text", "testId"] as const).filter(
    (key) => raw[key] !== undefined,
  )
  if (finders.length !== 1) return fail("target needs exactly one of role, label, text, testId")
  const target: {
    role?: string
    name?: string
    label?: string
    text?: string
    testId?: string
    exact?: boolean
    nth?: number
  } = {}
  for (const key of ["role", "name", "label", "text", "testId"] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== "string" || value === "")
      return fail(`target.${key} must be a non-empty string`)
    target[key] = value
  }
  if (raw.exact !== undefined) {
    if (typeof raw.exact !== "boolean") return fail("target.exact must be a boolean")
    target.exact = raw.exact
  }
  if (raw.nth !== undefined) {
    if (typeof raw.nth !== "number" || !Number.isInteger(raw.nth) || raw.nth < 0) {
      return fail("target.nth must be a non-negative integer")
    }
    target.nth = raw.nth
  }
  return { ok: true, value: target }
}

export function parseActDecision(raw: unknown): Parsed<ActDecision> {
  if (!isRecord(raw)) return fail("a decision must be an object")
  switch (raw.kind) {
    case "done":
      return {
        ok: true,
        value:
          typeof raw.summary === "string"
            ? { kind: "done", summary: raw.summary }
            : { kind: "done" },
      }
    case "fail":
      return typeof raw.reason === "string" && raw.reason !== ""
        ? { ok: true, value: { kind: "fail", reason: raw.reason } }
        : fail("fail needs a reason")
    case "goto":
      return typeof raw.path === "string" && raw.path.startsWith("/")
        ? { ok: true, value: { kind: "goto", path: raw.path } }
        : fail("goto needs a path that starts with /")
    case "tap":
    case "fill":
    case "press": {
      const target = parseTarget(raw.target)
      if (!target.ok) return target
      if (raw.kind === "tap") return { ok: true, value: { kind: "tap", target: target.value } }
      if (raw.kind === "fill") {
        return typeof raw.value === "string"
          ? { ok: true, value: { kind: "fill", target: target.value, value: raw.value } }
          : fail("fill needs a string value")
      }
      return typeof raw.key === "string" && raw.key !== ""
        ? { ok: true, value: { kind: "press", target: target.value, key: raw.key } }
        : fail("press needs a key")
    }
    default:
      return fail(`unknown decision kind ${JSON.stringify(raw.kind)}`)
  }
}

export function parseVerdict(raw: unknown): Parsed<Verdict> {
  if (!isRecord(raw)) return fail("a verdict must be an object")
  const { pass } = raw
  if (pass !== true && pass !== false && pass !== "inconclusive") {
    return fail('a verdict needs pass: true, false or "inconclusive"')
  }
  return { ok: true, value: { pass, reason: typeof raw.reason === "string" ? raw.reason : "" } }
}

export function parseExtraction(raw: unknown): Parsed<unknown> {
  if (!isRecord(raw) || !Object.hasOwn(raw, "value")) return fail("an extraction needs a value")
  return { ok: true, value: raw.value }
}

export function targetSelector(target: Target): Selector {
  const steps: Step[] = []
  if (target.role !== undefined) {
    const step: { kind: "role"; role: string; name?: string; exact?: boolean } = {
      kind: "role",
      role: target.role,
    }
    if (target.name !== undefined) step.name = target.name
    if (target.exact !== undefined) step.exact = target.exact
    steps.push(step)
  } else if (target.label !== undefined) {
    const step: { kind: "label"; text: string; exact?: boolean } = {
      kind: "label",
      text: target.label,
    }
    if (target.exact !== undefined) step.exact = target.exact
    steps.push(step)
  } else if (target.text !== undefined) {
    const step: { kind: "text"; text: string; exact?: boolean } = {
      kind: "text",
      text: target.text,
    }
    if (target.exact !== undefined) step.exact = target.exact
    steps.push(step)
  } else if (target.testId !== undefined) steps.push({ kind: "testId", id: target.testId })
  if (target.nth !== undefined) steps.push({ kind: "nth", index: target.nth })
  return steps
}

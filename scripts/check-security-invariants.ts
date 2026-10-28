#!/usr/bin/env bun
/**
 * Validate the repository's security invariant ledger.
 *
 * The ledger is deliberately boring JSON so documentation, mutation jobs, and external review
 * tooling can consume the same claims. A missing test or mutation target is a failed check: an
 * invariant without executable evidence is a label, not a security guarantee.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export interface SecurityInvariant {
  readonly id: string
  readonly area: string
  readonly statement: string
  readonly tests: readonly string[]
  readonly mutationTargets: readonly string[]
  readonly docs: string
}

export interface SecurityInvariantLedger {
  readonly schemaVersion: 1
  readonly invariants: readonly SecurityInvariant[]
}

type MutationTargets = Readonly<
  Record<string, { readonly files?: readonly string[]; readonly tests?: readonly string[] }>
>

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Object-shape guard above excludes null, arrays, and primitives.
  return value as Record<string, unknown>
}

const strings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)

export function readSecurityInvariantLedger(root: string): SecurityInvariantLedger {
  const value: unknown = JSON.parse(readFileSync(resolve(root, "security-invariants.json"), "utf8"))
  const record = asRecord(value)
  if (record?.schemaVersion !== 1 || !Array.isArray(record.invariants)) {
    throw new Error("security-invariants.json must declare schemaVersion 1 and invariants[]")
  }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The schemaVersion and invariants checks above establish the ledger shape.
  return value as SecurityInvariantLedger
}

export function readMutationTargets(root: string): MutationTargets {
  const value: unknown = JSON.parse(readFileSync(resolve(root, "mutation-targets.json"), "utf8"))
  const record = asRecord(value)
  if (record === undefined) throw new Error("mutation-targets.json must be an object")
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Mutation target entries are validated before use.
  return record as MutationTargets
}

/** Return every missing or malformed evidence link; an empty result is a passing check. */
export function validateSecurityInvariantLedger(
  root: string,
  ledger: SecurityInvariantLedger,
  targets: MutationTargets = readMutationTargets(root),
): readonly string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const [index, invariant] of ledger.invariants.entries()) {
    const prefix = `invariants[${index}]`
    if (typeof invariant.id !== "string" || invariant.id.length === 0)
      errors.push(`${prefix}.id is required`)
    else {
      if (ids.has(invariant.id)) errors.push(`${prefix}.id duplicates ${invariant.id}`)
      ids.add(invariant.id)
    }
    if (typeof invariant.area !== "string" || invariant.area.length === 0)
      errors.push(`${prefix}.area is required`)
    if (typeof invariant.statement !== "string" || invariant.statement.length < 20)
      errors.push(`${prefix}.statement must explain a meaningful invariant`)
    if (!strings(invariant.tests) || invariant.tests.length === 0)
      errors.push(`${prefix}.tests must be non-empty strings`)
    if (!strings(invariant.mutationTargets) || invariant.mutationTargets.length === 0)
      errors.push(`${prefix}.mutationTargets must be non-empty strings`)
    if (typeof invariant.docs !== "string" || !invariant.docs.startsWith("/docs/"))
      errors.push(`${prefix}.docs must be a /docs/ path`)
    for (const path of invariant.tests ?? []) {
      if (typeof path === "string" && !existsSync(resolve(root, path)))
        errors.push(`${invariant.id}: missing test path ${path}`)
    }
    for (const target of invariant.mutationTargets ?? []) {
      const targetSpec = targets[target]
      if (targetSpec === undefined)
        errors.push(`${invariant.id}: missing mutation target ${target}`)
      else {
        if (!strings(targetSpec.files) || targetSpec.files.length === 0)
          errors.push(`${invariant.id}: mutation target ${target} has no files`)
        for (const file of strings(targetSpec.files) ? targetSpec.files : []) {
          if (!existsSync(resolve(root, file)))
            errors.push(`${invariant.id}: mutation target ${target} missing file ${file}`)
        }
        if (!strings(targetSpec.tests) || targetSpec.tests.length === 0)
          errors.push(`${invariant.id}: mutation target ${target} has no tests`)
        for (const test of strings(targetSpec.tests) ? targetSpec.tests : []) {
          if (!existsSync(resolve(root, test)))
            errors.push(`${invariant.id}: mutation target ${target} missing test ${test}`)
        }
      }
    }
  }
  return errors
}

export function runSecurityInvariantCheck(root = process.cwd()): boolean {
  const ledger = readSecurityInvariantLedger(root)
  const errors = validateSecurityInvariantLedger(root, ledger)
  if (errors.length > 0) {
    console.error(
      `security invariant ledger failed (${errors.length} issue${errors.length === 1 ? "" : "s"})`,
    )
    for (const error of errors) console.error(`- ${error}`)
    return false
  }
  console.log(
    `security invariant ledger: ${ledger.invariants.length} invariants with executable evidence`,
  )
  return true
}

if (import.meta.main && !runSecurityInvariantCheck()) process.exitCode = 1

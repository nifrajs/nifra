import { describe, expect, test } from "bun:test"
import { runRuleRegistry } from "../src/rules/index.ts"
import { nanoRules } from "../src/rules/nano.ts"
import { projectFacts } from "./rule-facts.ts"

async function scan(file: string, content: string) {
  const facts = projectFacts(file, content)
  return runRuleRegistry({ root: process.cwd(), sources: facts.source, project: facts }, nanoRules)
}
const codes = (findings: readonly { code: string }[]) => findings.map((f) => f.code).sort()

describe("NF-C021 nano binding cleanup", () => {
  test("flags a bare bind(...) whose disposer is discarded", async () => {
    const findings = await scan(
      "app/todo.client.ts",
      [
        'import { bind, signal } from "@nifrajs/web/nano"',
        "const n = signal(0)",
        "const el = document.body",
        "bind(el, n, (e, v) => { e.textContent = String(v) })",
      ].join("\n"),
    )
    expect(codes(findings)).toEqual(["NF-C021"])
    expect(findings[0]?.severity).toBe("warn")
  })

  test("flags a bare bindList(...)", async () => {
    const findings = await scan(
      "app/todo.client.ts",
      [
        'import { bindList, signal } from "@nifrajs/web/nano"',
        "const items = signal([])",
        "bindList(items, document.body, { key: (i) => i.id, create: () => document.createElement('li') })",
      ].join("\n"),
    )
    expect(codes(findings)).toEqual(["NF-C021"])
  })

  test("does NOT flag when the disposer is collected into an array", async () => {
    const findings = await scan(
      "app/todo.client.ts",
      [
        'import { bind, signal } from "@nifrajs/web/nano"',
        "const n = signal(0)",
        "const cleanups = [bind(document.body, n, (e, v) => { e.textContent = String(v) })]",
      ].join("\n"),
    )
    expect(codes(findings)).toEqual([])
  })

  test("does NOT flag when the disposer is returned", async () => {
    const findings = await scan(
      "app/todo.client.ts",
      [
        'import { bind, signal } from "@nifrajs/web/nano"',
        "const n = signal(0)",
        "export const wire = (el) => bind(el, n, (e, v) => { e.textContent = String(v) })",
      ].join("\n"),
    )
    expect(codes(findings)).toEqual([])
  })
})

describe("NF-C022 nano bindList key", () => {
  test("flags an index key (concise arrow)", async () => {
    const findings = await scan(
      "app/todo.client.ts",
      [
        'import { bindList, signal } from "@nifrajs/web/nano"',
        "const items = signal([])",
        "const off = bindList(items, document.body, { key: (item, i) => i, create: () => document.createElement('li') })",
      ].join("\n"),
    )
    expect(codes(findings)).toEqual(["NF-C022"])
  })

  test("flags an index key (block return)", async () => {
    const findings = await scan(
      "app/todo.client.ts",
      [
        'import { bindList, signal } from "@nifrajs/web/nano"',
        "const items = signal([])",
        "const off = bindList(items, document.body, { key: (item, idx) => { return idx }, create: () => document.createElement('li') })",
      ].join("\n"),
    )
    expect(codes(findings)).toEqual(["NF-C022"])
  })

  test("does NOT flag a stable id key", async () => {
    const findings = await scan(
      "app/todo.client.ts",
      [
        'import { bindList, signal } from "@nifrajs/web/nano"',
        "const items = signal([])",
        "const off = bindList(items, document.body, { key: (item) => item.id, create: () => document.createElement('li') })",
      ].join("\n"),
    )
    expect(codes(findings)).toEqual([])
  })
})

describe("NF-C023 nano computed deps", () => {
  test("flags a computed that reads a signal its deps omit", async () => {
    const findings = await scan(
      "app/todo.client.ts",
      [
        'import { computed, signal } from "@nifrajs/web/nano"',
        "const todos = signal([])",
        "const remaining = computed(() => todos.get().length, [])",
      ].join("\n"),
    )
    expect(codes(findings)).toEqual(["NF-C023"])
    expect(findings[0]?.message).toContain("todos")
  })

  test("does NOT flag when the read signal is declared", async () => {
    const findings = await scan(
      "app/todo.client.ts",
      [
        'import { computed, signal } from "@nifrajs/web/nano"',
        "const a = signal(1)",
        "const b = signal(2)",
        "const sum = computed(() => a.get() + b.get(), [a, b])",
      ].join("\n"),
    )
    expect(codes(findings)).toEqual([])
  })

  test("does NOT flag a computed reading no signals", async () => {
    const findings = await scan(
      "app/todo.client.ts",
      [
        'import { computed, signal } from "@nifrajs/web/nano"',
        "const n = signal(0)",
        "const c = computed(() => 42, [])",
      ].join("\n"),
    )
    expect(codes(findings)).toEqual([])
  })
})

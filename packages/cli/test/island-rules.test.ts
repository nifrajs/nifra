import { describe, expect, test } from "bun:test"
import { runRuleRegistry } from "../src/rules/index.ts"
import { islandRules } from "../src/rules/islands.ts"
import { projectFacts } from "./rule-facts.ts"

async function scan(file: string, content: string) {
  const facts = projectFacts(file, content)
  return runRuleRegistry(
    { root: process.cwd(), sources: facts.source, project: facts },
    islandRules,
  )
}

const codes = (findings: readonly { code: string }[]) => findings.map((f) => f.code)

describe("NF-C020 island enhancer cleanup", () => {
  test("flags a defineIsland enhancer that adds a listener but returns no cleanup", async () => {
    const findings = await scan(
      "app/islands.client.ts",
      [
        'import { defineIsland, mountIslands } from "@nifrajs/web/islands"',
        "const counter = defineIsland((el) => {",
        '  el.addEventListener("click", () => {})',
        "})",
        "mountIslands({ counter })",
      ].join("\n"),
    )
    expect(codes(findings)).toEqual(["NF-C020"])
    expect(findings[0]?.severity).toBe("warn")
  })

  test("does NOT flag when the block returns a cleanup", async () => {
    const findings = await scan(
      "app/islands.client.ts",
      [
        'import { defineIsland } from "@nifrajs/web/islands"',
        "const counter = defineIsland((el) => {",
        "  const f = () => {}",
        '  el.addEventListener("click", f)',
        '  return () => el.removeEventListener("click", f)',
        "})",
      ].join("\n"),
    )
    expect(codes(findings)).toEqual([])
  })

  test("does NOT flag a concise-body arrow (it already returns its value)", async () => {
    const findings = await scan(
      "app/islands.client.ts",
      [
        'import { defineIsland, createIslandBus } from "@nifrajs/web/islands"',
        "const bus = createIslandBus()",
        'const badge = defineIsland((el) => bus.on("n", (v) => { el.textContent = String(v) }))',
      ].join("\n"),
    )
    expect(codes(findings)).toEqual([])
  })

  test("does NOT flag an enhancer that adds no listener", async () => {
    const findings = await scan(
      "app/islands.client.ts",
      [
        'import { defineIsland } from "@nifrajs/web/islands"',
        'const label = defineIsland((el) => { el.textContent = "hi" })',
      ].join("\n"),
    )
    expect(codes(findings)).toEqual([])
  })

  test("flags an inline enhancer inside mountIslands({...})", async () => {
    const findings = await scan(
      "app/islands.client.ts",
      [
        'import { mountIslands } from "@nifrajs/web/islands"',
        "mountIslands({",
        '  box: (el) => { el.addEventListener("input", () => {}) },',
        "})",
      ].join("\n"),
    )
    expect(codes(findings)).toEqual(["NF-C020"])
  })

  test("a nested handler's return is not mistaken for the enhancer's cleanup", async () => {
    const findings = await scan(
      "app/islands.client.ts",
      [
        'import { defineIsland } from "@nifrajs/web/islands"',
        "const x = defineIsland((el) => {",
        '  el.addEventListener("click", () => { return true })',
        "})",
      ].join("\n"),
    )
    expect(codes(findings)).toEqual(["NF-C020"])
  })
})

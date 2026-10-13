import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { bindCommandArgv } from "../src/command-catalog.ts"
import { explainSpec } from "../src/dev-feed-tool.ts"
import { projectTools } from "../src/mcp-exec.ts"
import { explainRule } from "../src/rule-explain.ts"
import { RULE_CODES } from "../src/rules/codes.ts"
import { RULE_EXPLANATIONS } from "../src/rules/explanations.ts"

const SITE_DOCS = join(import.meta.dir, "../../../site/routes")

describe("the rule explanation catalog", () => {
  test("explains every built-in code, and nothing else", () => {
    expect(Object.keys(RULE_EXPLANATIONS).sort()).toEqual(Object.keys(RULE_CODES).sort())
  })

  test("each entry links a docs page that exists, at an anchor the page carries", () => {
    for (const [code, { docs }] of Object.entries(RULE_EXPLANATIONS)) {
      const [path = "", anchor] = docs.split("#")
      const page = join(SITE_DOCS, `${path.replace(/^\//, "")}.tsx`)
      expect({ code, page: existsSync(page) }).toEqual({ code, page: true })
      if (anchor !== undefined) expect(readFileSync(page, "utf8")).toContain(`id="${anchor}"`)
    }
  })

  test("a `nifra fix --code` command names the code it explains; the text is plain sentences", () => {
    for (const [code, entry] of Object.entries(RULE_EXPLANATIONS)) {
      const fixCode = entry.command?.match(/^nifra fix --code (\S+)$/)?.[1]
      if (fixCode !== undefined) expect(fixCode).toBe(code)
      for (const text of [entry.why, entry.fix]) {
        expect(text).toMatch(/[.)]$/)
        expect(text).not.toMatch(/[–—]/)
      }
    }
  })
})

describe("nifra explain NF-xxxx", () => {
  test("a rule code is answered from the catalog, with its fix command and docs", async () => {
    const input = bindCommandArgv(explainSpec, ["NF-C041"])
    const out = await explainSpec.run(input, { cwd: process.cwd() })
    expect(out).toEqual({
      kind: "rule",
      code: "NF-C041",
      title: RULE_CODES["NF-C041"],
      category: "route-boundary",
      message: RULE_EXPLANATIONS["NF-C041"].why,
      fix: RULE_EXPLANATIONS["NF-C041"].fix,
      command: "nifra fix --code NF-C041",
      docs: "https://nifra.dev/docs/structure",
    })
    expect(explainSpec.output.parse(JSON.parse(JSON.stringify(out)))).toEqual(out)
    const lines = explainSpec.render?.(out, input) ?? []
    expect(lines[0]).toBe(`NF-C041  ${RULE_CODES["NF-C041"]}  (route-boundary)`)
    expect(lines).toContain("  run: nifra fix --code NF-C041")
    expect(explainSpec.exitCode?.(out, input)).toBe(0)
  })

  test("an unknown code is a clear refusal with exit 1, never an unhandled error", async () => {
    const out = await explainSpec.run({ error: " NF-C999 " }, { cwd: process.cwd() })
    expect(out).toEqual({
      code: "NIFRA_UNKNOWN_RULE",
      message: expect.stringContaining("NF-C999 is not a nifra rule code."),
    })
    expect(explainSpec.output.parse(out)).toEqual(out)
    expect(explainSpec.render?.(out, {})).toEqual([out.message])
    expect(explainSpec.exitCode?.(out, {})).toBe(1)
  })

  test("with a stack, a code-shaped message is still explained as an error", async () => {
    const out = await explainSpec.run(
      { error: "NF-C007", stack: "Error: NF-C007\n    at x (/nowhere.ts:1:1)" },
      { cwd: process.cwd() },
    )
    expect("kind" in out).toBe(false)
    expect(out.code).not.toBe("NIFRA_UNKNOWN_RULE")
  })

  test("the MCP tool answers a code the same way", async () => {
    const explain = projectTools(process.cwd()).find((tool) => tool.name === "nifra_explain")
    const context = { signal: new AbortController().signal, requestId: 1, reportProgress: () => {} }
    const answer = JSON.parse(String(await explain?.handler({ error: "NF-D003" }, context)))
    expect(answer).toEqual(await explainRule("NF-D003"))
    expect(answer.docs).toBe("https://nifra.dev/docs/troubleshooting#stale-file-links")
  })
})

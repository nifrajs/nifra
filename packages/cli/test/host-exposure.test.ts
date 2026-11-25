import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectCheckResult } from "../src/check.ts"
import { runRuleRegistry, sourceIndex } from "../src/rules/index.ts"
import { hostExposureRule } from "../src/rules/security.ts"
import { projectFacts } from "./rule-facts.ts"

type Files = readonly { file: string; content: string }[]

async function scan(files: Files, hostTopology?: "direct" | "proxied") {
  const base = projectFacts(files[0]?.file ?? "app.ts", files[0]?.content ?? "")
  const source = sourceIndex([...files])
  const facts = {
    ...base,
    source,
    policies: {
      ...base.policies,
      checkConfig:
        hostTopology === undefined
          ? { externalMounts: [], rules: {} }
          : { externalMounts: [], rules: {}, hostTopology },
    },
  }
  const found = await runRuleRegistry({ root: "/tmp/project", sources: source, project: facts }, [
    hostExposureRule,
  ])
  return found.filter((finding) => finding.code === "NF-S010")
}

const one = (content: string, hostTopology?: "direct" | "proxied") =>
  scan([{ file: "server.ts", content }], hostTopology)

const DENO = 'import { serve } from "@nifrajs/deno"\n'
const CORE = 'import { server } from "@nifrajs/core"\n'

describe("NF-S010 a listener that answers with Host unchecked", () => {
  test("a plain listener is silent: nothing says it is reachable directly", async () => {
    expect(await one(`${DENO}await serve(app, { port: 8000 })`)).toEqual([])
    expect(await one(`${CORE}app.listen(3000)`)).toEqual([])
  })

  test("a listener that terminates TLS itself is named, with what its runtime does", async () => {
    const deno = await one(`${DENO}await serve(app, { port: 443, tls: { cert, key } })`)
    expect(deno).toHaveLength(1)
    expect(deno[0]?.severity).toBe("warn")
    expect(deno[0]?.line).toBe(2)
    expect(deno[0]?.message).toContain("Deno")
    expect(deno[0]?.message).toContain("routes the request to `/admin`")
    expect(deno[0]?.evidence?.[0]).toBe("the listener terminates TLS itself")
    const bun = await one(`${CORE}app.listen(443, { tls: { cert, key } })`)
    expect(bun[0]?.message).toContain("Bun")
    const bunServe = await one("Bun.serve({ port: 443, tls: { cert, key }, fetch })")
    expect(bunServe).toHaveLength(1)
    const denoServe = await one("Deno.serve({ port: 443, cert, key }, handler)")
    expect(denoServe).toHaveLength(1)
  })

  test("a Host check anywhere in the project leaves it alone", async () => {
    const listener = { file: "serve.ts", content: `${DENO}await serve(app, { port: 1, tls })` }
    expect(
      await scan([
        listener,
        { file: "app.ts", content: `${CORE}export const app = server({ validateHost: true })` },
      ]),
    ).toEqual([])
    expect(
      await scan([
        listener,
        { file: "app.ts", content: `${CORE}server({ allowedHosts: ["a.test"] })` },
      ]),
    ).toEqual([])
    expect(
      await scan([
        listener,
        { file: "app.ts", content: `${CORE}server({ canonicalHost: "a.test" })` },
      ]),
    ).toEqual([])
  })

  test("validateHost: false, a comment or a string that names it configures nothing", async () => {
    const listener = { file: "serve.ts", content: `${DENO}await serve(app, { port: 1, tls })` }
    for (const content of [
      `${CORE}server({ validateHost: false })`,
      "// validateHost: true would cost a header read",
      'const note = "set validateHost: true"',
    ]) {
      expect(await scan([listener, { file: "app.ts", content }])).toHaveLength(1)
    }
  })

  test("a nifra-expect comment with a reason accepts it; without one it does not", async () => {
    const accepted = await one(
      `${DENO}// nifra-expect NF-S010: behind Cloudflare, which checks Host\nawait serve(app, { port: 1, tls })`,
    )
    expect(accepted).toEqual([])
    const named = await one(
      `${DENO}// nifra-expect host-exposure: the edge checks Host\nawait serve(app, { port: 1, tls })`,
    )
    expect(named).toEqual([])
    const bare = await one(`${DENO}// nifra-expect NF-S010\nawait serve(app, { port: 1, tls })`)
    expect(bare).toHaveLength(1)
    expect(bare[0]?.message).toContain("gives no reason")
  })

  test('hostTopology "proxied" silences it and "direct" widens it to every listener', async () => {
    const withTls = `${DENO}await serve(app, { port: 1, tls })`
    const plain = `${DENO}await serve(app, { port: 1 })`
    expect(await one(withTls, "proxied")).toEqual([])
    const direct = await one(plain, "direct")
    expect(direct).toHaveLength(1)
    expect(direct[0]?.evidence?.[0]).toBe('nifra.check.json declares "hostTopology": "direct"')
  })

  test("@nifrajs/node and node-uws check Host themselves, and an adapter with no listener has none to name", async () => {
    expect(
      await one('import { serve } from "@nifrajs/node"\nawait serve(app, { port: 1, tls })'),
    ).toEqual([])
    expect(
      await one('import { serve } from "@nifrajs/node-uws"\nawait serve(app, { port: 1, tls })'),
    ).toEqual([])
    expect(
      await one('import { handle } from "@nifrajs/aws-lambda"\nexport const h = handle(app)'),
    ).toEqual([])
  })

  test("a serve() imported from somewhere else, and an alias, are told apart", async () => {
    expect(
      await one('import { serve } from "other-lib"\nawait serve(app, { port: 1, tls })'),
    ).toEqual([])
    expect(
      await one('import { serve as run } from "@nifrajs/deno"\nawait run(app, { port: 1, tls })'),
    ).toHaveLength(1)
  })
})

describe("nifra.check.json hostTopology", () => {
  async function project(config: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-"))
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(join(dir, "src", "serve.ts"), `${DENO}await serve(app, { port: 1 })\n`)
    await writeFile(join(dir, "nifra.check.json"), JSON.stringify(config))
    return dir
  }

  test('"direct" turns the finding on and is echoed in the result', async () => {
    const dir = await project({ hostTopology: "direct" })
    const result = await collectCheckResult(dir, { lintsOnly: true })
    expect(result.structuredDiagnostics?.filter((d) => d.code === "NF-S010")).toHaveLength(1)
    expect(result.hostTopology).toBe("direct")
    await rm(dir, { recursive: true, force: true })
  })

  test("a value it does not know is a warning and changes nothing", async () => {
    const dir = await project({ hostTopology: "edge" })
    const result = await collectCheckResult(dir, { lintsOnly: true })
    expect(result.structuredDiagnostics?.filter((d) => d.code === "NF-S010")).toHaveLength(0)
    expect(result.hostTopology).toBeUndefined()
    expect(result.diagnostics.some((d) => d.rule === "check-config")).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })
})

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

  test("one guarded app cannot suppress another listener", async () => {
    const findings = await scan([
      {
        file: "serve.ts",
        content: `${CORE}${DENO}const checked = server({ validateHost: true })
const unchecked = server()
await serve(checked, { port: 1, tls })
await serve(unchecked, { port: 2, tls })`,
      },
      { file: "unrelated.ts", content: "const settings = { validateHost: true }" },
    ])
    expect(findings.map(({ line }) => line)).toEqual([6])
  })

  test("an unconnected guard cannot suppress a raw listener", async () => {
    const found = await one(`${CORE}server({ validateHost: true })
Bun.serve({ port: 443, tls, fetch })`)
    expect(found).toHaveLength(1)
  })

  test("allowedHosts and canonicalHost are the Node adapters' options: a Deno or Bun listener ignores them", async () => {
    const listener = { file: "serve.ts", content: `${DENO}await serve(app, { port: 1, tls })` }
    for (const options of ['{ allowedHosts: ["a.test"] }', '{ canonicalHost: "a.test" }']) {
      const found = await scan([
        listener,
        { file: "app.ts", content: `${CORE}export const app = server(${options})` },
      ])
      expect(found).toHaveLength(1)
    }
  })

  test("a validateHost a later spread may switch off is not a guarantee", async () => {
    const listener = "await serve(app, { port: 1, tls })"
    const ambiguous =
      "const app = server({ validateHost: true, ...(disabled ? { validateHost: false } : {}) })"
    expect(await one(`${CORE}${DENO}${ambiguous}\n${listener}`)).toHaveLength(1)
    const unrelated = "const app = server({ validateHost: true, ...(more ? { port: 1 } : {}) })"
    expect(await one(`${CORE}${DENO}${unrelated}\n${listener}`)).toEqual([])
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

  test("a listen() chained off the server factory is named, as is one off a bound name", async () => {
    const chained = await one(
      `${CORE}server().get("/", handler).listen(443, { tls: { cert, key } })`,
    )
    expect(chained).toHaveLength(1)
    const bound = await one(`${CORE}const app = server()\napp.listen(9000, { tls: { cert, key } })`)
    expect(bound).toHaveLength(1)
    // Not a Nifra server: a socket server in a file that merely imports core.
    expect(
      await one(
        `${CORE}import net from "node:net"\nconst tcp = net.createServer()\ntcp.listen(9000, { tls: { cert, key } })`,
        "direct",
      ),
    ).toEqual([])
  })

  test("TLS is read from the argument that holds the listener's options", async () => {
    // The first argument of an adapter's serve() is the app, whose own `tls` key is not the listener's.
    expect(await one(`${DENO}await serve({ tls, fetch }, { port: 8000 })`)).toEqual([])
    expect(await one(`${DENO}await serve(app, { port: 443, tls: { cert, key } })`)).toHaveLength(1)
    expect(await one(`${DENO}await serve(app, { port: 8000, tls: undefined })`)).toEqual([])
  })

  test("a listener in a .js file is scanned like a .ts one", async () => {
    const found = await scan([
      { file: "backend/server.js", content: "Bun.serve({ port: 443, tls: { cert, key }, fetch })" },
    ])
    expect(found).toHaveLength(1)
  })

  test("a bare Deno or Bun handler is told to check Host itself; a Nifra server is told validateHost", async () => {
    const native = await one("Deno.serve({ port: 443, cert, key }, handler)")
    expect(native[0]?.message).toContain("Check `Host` in the handler")
    expect(native[0]?.message).not.toContain("Set `validateHost: true`")
    const app = await one(`${DENO}await serve(app, { port: 443, tls: { cert, key } })`)
    expect(app[0]?.message).toContain("Set `validateHost: true`")
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

describe("what counts as configuring or serving", () => {
  const listen = (options: string): string =>
    `${CORE}${options}\nawait server(o).listen(443, { tls })`

  test("a later writer wins over a spread, and an unreadable spread proves nothing", async () => {
    for (const options of [
      "{ ...{ validateHost: true }, validateHost: false }",
      "{ validateHost: true, ...overrides }",
      "{ validateHost: toggle }",
    ]) {
      expect(await one(listen(`const o = ${options}`))).toHaveLength(1)
    }
    expect(
      await one(listen("const base = { port: 1 }\nconst o = { validateHost: true, ...base }")),
    ).toEqual([])
  })

  test("a source is judged where it is spread, and && may write nothing", async () => {
    for (const code of [
      "const defaults = { validateHost: true }\nconst o = { ...defaults, validateHost: false }",
      "const o = { validateHost: false, ...(enabled && { validateHost: true }) }",
      "const o = { ...(flag ? { validateHost: true } : undefined) }",
    ]) {
      expect(await one(listen(code))).toHaveLength(1)
    }
    expect(await one(listen("const base = { validateHost: true }\nconst o = { ...base }"))).toEqual(
      [],
    )
  })

  test("an options binding must remain local to spreads and server configuration", async () => {
    const options = "const o = { validateHost: true }"
    expect(await one(listen(options))).toEqual([])
    for (const use of ["updateOptions(o)", "const alias = o", "o.port = 1"]) {
      expect(await one(listen(`${options}\n${use}`))).toHaveLength(1)
    }
  })

  test("a long route chain is still a server", async () => {
    const routes = '.get("/a", h)'.repeat(12)
    expect(
      await one(
        `import { server } from "@nifrajs/core"\nawait server()${routes}.listen(443, { tls })`,
      ),
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

describe("NF-S010 a guard traced through types and unrelated names", () => {
  const WRAPPERS = ["x", "(x)", "x as const", "x!", "x satisfies object", "(x as any)!"]
  const listen = "\nawait app.listen(443, { tls })"

  test("a type-only wrapper changes nothing, wherever the guard passes through", async () => {
    for (const wrapper of WRAPPERS) {
      const wrap = (inner: string) => wrapper.replace("x", () => inner)
      for (const body of [
        `const o = ${wrap("{ validateHost: true }")}\nconst app = server(o)`,
        `const o = { validateHost: true }\nconst app = server(${wrap("o")})`,
        `const app = server(${wrap("{ validateHost: true }")})`,
        `const app = server({ validateHost: ${wrap("true")} })`,
        `const app = ${wrap("server({ validateHost: true })")}`,
        `const o = { validateHost: true }\nconst app = server({ ...${wrap("o")} })`,
      ])
        expect([body, await one(`${CORE}${body}${listen}`)]).toEqual([body, []])
      const off = `const app = server(${wrap("{ validateHost: false }")})`
      expect([off, (await one(`${CORE}${off}${listen}`)).length]).toEqual([off, 1])
    }
  })

  test("a member that shares the options' name does not touch them", async () => {
    const guarded = `${CORE}const options = { validateHost: true }\nconst app = server(options)\n`
    for (const use of [
      "log(request.options)",
      "log({ options: 1 })",
      "class A { options = 1 }",
      "class B { options() {} }",
      "interface C { options: number }",
      "const { options: renamed } = request",
    ])
      expect([use, await one(`${guarded}${use}${listen}`)]).toEqual([use, []])
    for (const use of ["mutate(options)", "log({ options })", "options.validateHost = false"])
      expect([use, (await one(`${guarded}${use}${listen}`)).length]).toEqual([use, 1])
  })
})

describe("NF-S010 writes and scopes the guard trace must not miss", () => {
  const listen = "await app.listen(443, { tls })"

  test("an accessor named validateHost proves nothing, and another accessor changes nothing", async () => {
    for (const accessor of ["get validateHost() { return false }", "set validateHost(v) {}"])
      for (const options of [`{ ${accessor} }`, `{ validateHost: true, ...{ ${accessor} } }`]) {
        const found = await one(`${CORE}const app = server(${options})\n${listen}`)
        // A spread copies a setter-only property as `undefined`, which is no guarantee either.
        expect([options, found.length]).toEqual([options, 1])
      }
    const other = "{ validateHost: true, ...{ get logger() { return log } } }"
    expect(await one(`${CORE}const app = server(${other})\n${listen}`)).toEqual([])
  })

  test("a scope that can redeclare the app does not inherit the module app's guard", async () => {
    const guarded = `${CORE}const app = server({ validateHost: true })\n`
    for (const scope of [
      `for (const app of [server()]) ${listen}`,
      `for (const app in apps) ${listen}`,
      `for (let app = server(); ; ) ${listen}`,
      `switch (kind) { case 1: const app = server(); ${listen} }`,
      `namespace N { export const app = server(); ${listen} }`,
    ])
      expect([scope, (await one(`${guarded}${scope}`)).length]).toEqual([scope, 1])
    expect(await one(`${guarded}if (ready) ${listen}`)).toEqual([])
  })
})

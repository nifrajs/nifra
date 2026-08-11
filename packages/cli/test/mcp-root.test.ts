import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clientSupportsRoots, guardTools } from "../src/mcp.ts"
import type { McpTool, McpToolContext } from "../src/mcp-protocol.ts"
import {
  applyClientRoots,
  findNifraRoot,
  isNifraProjectDir,
  type McpRootState,
  pathsFromRootsResult,
  resolveRootState,
  rootInstructions,
  rootMismatch,
  rootVerdict,
} from "../src/mcp-root.ts"

/** A temp dir carrying the `@nifrajs/*` dependency marker. */
const projectDir = async (prefix = "nifra-root-proj-"): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "p", dependencies: { "@nifrajs/core": "0.0.0" } }),
  )
  return dir
}

/** A temp dir with no nifra marker at all. */
const plainDir = async (prefix = "nifra-root-plain-"): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }))
  return dir
}

describe("isNifraProjectDir / findNifraRoot", () => {
  test("@nifrajs/* in any dependency section is the marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-root-"))
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", devDependencies: { "@nifrajs/cli": "1.0.0" } }),
    )
    expect(await isNifraProjectDir(dir)).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  test("nifra.config.ts alone is the marker (monorepo root)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-root-"))
    await writeFile(join(dir, "nifra.config.ts"), "export default {}\n")
    expect(await isNifraProjectDir(dir)).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  test("a plain package.json is not a project; nor is an empty dir", async () => {
    const dir = await plainDir()
    expect(await isNifraProjectDir(dir)).toBe(false)
    const empty = await mkdtemp(join(tmpdir(), "nifra-root-empty-"))
    expect(await isNifraProjectDir(empty)).toBe(false)
    await rm(dir, { recursive: true, force: true })
    await rm(empty, { recursive: true, force: true })
  })

  test("walk-up finds the nearest marked ancestor", async () => {
    const root = await projectDir()
    const deep = join(root, "src", "routes")
    await mkdir(deep, { recursive: true })
    expect(await findNifraRoot(deep)).toBe(root)
    await rm(root, { recursive: true, force: true })
  })
})

describe("resolveRootState", () => {
  test("cwd guess walks up: source is `parent`, root is the marked ancestor", async () => {
    const root = await projectDir()
    const sub = join(root, "src")
    await mkdir(sub)
    const state = await resolveRootState(sub, false)
    expect(state).toEqual({ root, source: "parent", isProject: true, clientRoots: null })
    await rm(root, { recursive: true, force: true })
  })

  test("an explicit dir is taken literally - no walk-up, isProject reflects THAT dir", async () => {
    const root = await projectDir()
    const sub = join(root, "src")
    await mkdir(sub)
    const state = await resolveRootState(sub, true)
    expect(state.root).toBe(sub)
    expect(state.source).toBe("arg")
    expect(state.isProject).toBe(false)
    await rm(root, { recursive: true, force: true })
  })
})

describe("pathsFromRootsResult", () => {
  test("file:// URIs become paths; non-file and malformed URIs are skipped", () => {
    expect(
      pathsFromRootsResult({
        roots: [
          { uri: "file:///a/b" },
          { uri: "https://example.com" },
          { uri: "file://remote-host/x" },
          { notUri: true },
        ],
      }),
    ).toEqual(["/a/b"])
  })

  test("garbage shapes yield no roots", () => {
    expect(pathsFromRootsResult(undefined)).toEqual([])
    expect(pathsFromRootsResult("nope")).toEqual([])
    expect(pathsFromRootsResult({ roots: "nope" })).toEqual([])
  })
})

describe("rootMismatch", () => {
  const base: McpRootState = {
    root: "/w/app",
    source: "cwd",
    isProject: true,
    clientRoots: null,
  }
  test("no client data (null or empty) is never a mismatch", () => {
    expect(rootMismatch(base)).toBe(false)
    expect(rootMismatch({ ...base, clientRoots: [] })).toBe(false)
  })
  test("containment in either direction is not a mismatch", () => {
    expect(rootMismatch({ ...base, clientRoots: ["/w"] })).toBe(false)
    expect(rootMismatch({ ...base, root: "/w", clientRoots: ["/w/app"] })).toBe(false)
    expect(rootMismatch({ ...base, clientRoots: ["/w/app"] })).toBe(false)
  })
  test("disjoint trees are a mismatch - and prefix-sharing names do not count as containment", () => {
    expect(rootMismatch({ ...base, clientRoots: ["/other"] })).toBe(true)
    expect(rootMismatch({ ...base, root: "/w/app", clientRoots: ["/w/app2"] })).toBe(true)
  })
})

describe("applyClientRoots", () => {
  test("non-project root adopts the single nifra workspace root", async () => {
    const proj = await projectDir()
    const start = await plainDir()
    const state = await resolveRootState(start, false)
    const next = await applyClientRoots(state, [proj])
    expect(next.root).toBe(proj)
    expect(next.source).toBe("client-root")
    expect(next.isProject).toBe(true)
    await rm(proj, { recursive: true, force: true })
    await rm(start, { recursive: true, force: true })
  })

  test("a VALID project disjoint from the workspace is corrected too", async () => {
    const wrongProj = await projectDir("nifra-root-wrong-")
    const workspaceProj = await projectDir("nifra-root-ws-")
    const state = await resolveRootState(wrongProj, false)
    expect(state.isProject).toBe(true)
    const next = await applyClientRoots(state, [workspaceProj])
    expect(next.root).toBe(workspaceProj)
    expect(next.source).toBe("client-root")
    await rm(wrongProj, { recursive: true, force: true })
    await rm(workspaceProj, { recursive: true, force: true })
  })

  test("an explicit `nifra mcp <dir>` root is never moved", async () => {
    const explicit = await plainDir()
    const proj = await projectDir()
    const state = await resolveRootState(explicit, true)
    const next = await applyClientRoots(state, [proj])
    expect(next.root).toBe(explicit)
    expect(next.source).toBe("arg")
    expect(next.clientRoots).toEqual([proj])
    await rm(explicit, { recursive: true, force: true })
    await rm(proj, { recursive: true, force: true })
  })

  test("ambiguity (two candidate projects) adopts nothing", async () => {
    const a = await projectDir()
    const b = await projectDir()
    const start = await plainDir()
    const state = await resolveRootState(start, false)
    const next = await applyClientRoots(state, [a, b])
    expect(next.root).toBe(start)
    expect(next.isProject).toBe(false)
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
    await rm(start, { recursive: true, force: true })
  })

  test("a matching root just records the client roots", async () => {
    const proj = await projectDir()
    const state = await resolveRootState(proj, false)
    const next = await applyClientRoots(state, [proj])
    expect(next).toEqual({ ...state, clientRoots: [proj] })
    await rm(proj, { recursive: true, force: true })
  })
})

describe("rootVerdict / rootInstructions", () => {
  test("non-project root blocks with remediation; instructions warn", async () => {
    const state: McpRootState = {
      root: "/nowhere",
      source: "cwd",
      isProject: false,
      clientRoots: null,
    }
    const verdict = await rootVerdict(state)
    expect(verdict.blocked).toContain("No nifra project at /nowhere")
    expect(verdict.blocked).toContain("nifra mcp <dir>")
    expect(rootInstructions(state)).toContain("WARNING")
  })

  test("guessed root disjoint from the workspace blocks; explicit root only annotates", async () => {
    const guessed: McpRootState = {
      root: "/w/app",
      source: "parent",
      isProject: true,
      clientRoots: ["/other"],
    }
    const g = await rootVerdict(guessed)
    expect(g.blocked).toContain("Wrong project")
    expect(g.blocked).toContain("/other")

    const explicit = await rootVerdict({ ...guessed, source: "arg" })
    expect(explicit.blocked).toBeUndefined()
    expect(explicit.note).toContain("outside the client workspace")
  })

  test("healthy root: no block, a root note, serving instructions", async () => {
    const state: McpRootState = {
      root: "/w/app",
      source: "cwd",
      isProject: true,
      clientRoots: ["/w/app"],
    }
    const verdict = await rootVerdict(state)
    expect(verdict.blocked).toBeUndefined()
    expect(verdict.note).toBe("[nifra] project root: /w/app")
    expect(rootInstructions(state)).toBe("Serving the nifra project at /w/app.")
  })
})

describe("detectToolingDrift - the CLI answering vs the nifra the project builds with", () => {
  const install = async (root: string, name: string, version: string): Promise<void> => {
    const dir = join(root, "node_modules", ...name.split("/"))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }))
  }

  test("reports the installed CLI when it disagrees on the feature version", async () => {
    const dir = await projectDir("nifra-root-drift-")
    try {
      await install(dir, "@nifrajs/cli", "2.4.0")
      await install(dir, "@nifrajs/core", "2.4.0")
      const drift = await detectToolingDrift(dir, "2.11.0")
      expect(drift).toEqual({ cli: "2.11.0", project: "2.4.0", package: "@nifrajs/cli" })
      expect(
        rootInstructions(
          {
            root: dir,
            source: "cwd",
            isProject: true,
            clientRoots: null,
          },
          drift,
        ),
      ).toContain("nifra CLI 2.11.0")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("falls back to @nifrajs/core, and stays silent on patch-only drift", async () => {
    const dir = await projectDir("nifra-root-drift-core-")
    try {
      await install(dir, "@nifrajs/core", "2.11.4")
      expect(await detectToolingDrift(dir, "2.11.0")).toBeUndefined()
      const other = await projectDir("nifra-root-drift-core2-")
      try {
        await install(other, "@nifrajs/core", "3.0.1")
        expect(await detectToolingDrift(other, "2.11.0")).toEqual({
          cli: "2.11.0",
          project: "3.0.1",
          package: "@nifrajs/core",
        })
      } finally {
        await rm(other, { recursive: true, force: true })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("nothing installed: no drift claim", async () => {
    const dir = await projectDir("nifra-root-drift-none-")
    try {
      expect(await detectToolingDrift(dir, "2.11.0")).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("guardTools", () => {
  const context = {} as McpToolContext
  const tools: McpTool[] = [
    {
      name: "nifra_context",
      description: "project tool",
      inputSchema: { type: "object" },
      handler: async () => "project answer",
    },
    {
      name: "nifra_docs",
      description: "corpus tool",
      inputSchema: { type: "object" },
      handler: async () => "docs answer",
    },
  ]

  test("blocked verdict: project tools refuse in-band, docs tools pass through", async () => {
    const guarded = guardTools(tools, { blocked: "nope, wrong root", note: "" })
    const project = await guarded[0]?.handler({}, context)
    expect(project).toEqual({
      content: [{ type: "text", text: "nope, wrong root" }],
      isError: true,
    })
    expect(await guarded[1]?.handler({}, context)).toBe("docs answer")
  })

  test("healthy verdict: the root note is appended to string and rich results", async () => {
    const note = "[nifra] project root: /w/app"
    const guarded = guardTools(
      [
        ...tools,
        {
          name: "nifra_rich",
          description: "rich result",
          inputSchema: { type: "object" },
          handler: async () => ({
            content: [{ type: "text" as const, text: "rich" }],
            structuredContent: { a: 1 },
          }),
        },
      ],
      { note },
    )
    expect(await guarded[0]?.handler({}, context)).toEqual({
      content: [
        { type: "text", text: "project answer" },
        { type: "text", text: note },
      ],
    })
    const rich = (await guarded[2]?.handler({}, context)) as {
      content: unknown[]
      structuredContent: unknown
    }
    expect(rich.content).toEqual([
      { type: "text", text: "rich" },
      { type: "text", text: note },
    ])
    expect(rich.structuredContent).toEqual({ a: 1 })
  })
})

describe("clientSupportsRoots", () => {
  test("only an object-valued capabilities.roots counts", () => {
    expect(clientSupportsRoots({ capabilities: { roots: {} } })).toBe(true)
    expect(clientSupportsRoots({ capabilities: { roots: { listChanged: true } } })).toBe(true)
    expect(clientSupportsRoots({ capabilities: {} })).toBe(false)
    expect(clientSupportsRoots({ capabilities: { roots: true } })).toBe(false)
    expect(clientSupportsRoots({})).toBe(false)
    expect(clientSupportsRoots(undefined)).toBe(false)
  })
})

describe("runMcpServer root gating over stdio", () => {
  /**
   * Drive the server over stdio. `onServerRequest` sees every server-initiated request (id + method,
   * e.g. `roots/list`) and its return value - one or more messages - is written back to the server
   * in a single ordered write: the client half of the roots handshake, plus anything that must only
   * reach the server AFTER the answer. Same incremental-read reasoning as the harness in mcp.test.ts:
   * a live server never closes stdout, so the read must be incremental with a deadline.
   */
  const rpc = async (
    dir: string,
    messages: object[],
    expect_: number[],
    onServerRequest?: (req: { id: unknown; method: string }) => object[] | undefined,
  ): Promise<Record<number, unknown>> => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "mcp"], {
      cwd: dir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    const stdin = proc.stdin as { write(s: string): unknown }
    for (const m of messages) stdin.write(`${JSON.stringify(m)}\n`)

    const byId: Record<number, unknown> = {}
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    const deadline = Date.now() + 40_000
    try {
      while (expect_.some((id) => byId[id] === undefined) && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), 40_000),
          ),
        ])
        if (chunk.done) break
        buffered += decoder.decode(chunk.value, { stream: true })
        const lines = buffered.split("\n")
        buffered = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("{")) continue
          const parsed = JSON.parse(line) as { id?: unknown; method?: string }
          if (typeof parsed.method === "string" && parsed.id !== undefined) {
            const replies = onServerRequest?.({ id: parsed.id, method: parsed.method })
            if (replies !== undefined && replies.length > 0) {
              stdin.write(replies.map((r) => `${JSON.stringify(r)}\n`).join(""))
            }
          } else if (typeof parsed.id === "number") {
            byId[parsed.id] = parsed
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {})
      proc.kill()
    }
    return byId
  }

  const init = (capabilities: object) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities,
      clientInfo: { name: "t", version: "1" },
    },
  })
  const READY = { jsonrpc: "2.0", method: "notifications/initialized" }
  // `lintsOnly` keeps the call fast and app-independent - the point here is the guard, not the tool.
  const CALL = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "nifra_check", arguments: { lintsOnly: true } },
  }

  test("no project, no roots: initialize warns and project tools fail closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-root-e2e-plain-"))
    const res = await rpc(dir, [init({}), READY, CALL], [1, 2])

    const initRes = res[1] as { result?: { instructions?: string } }
    expect(initRes?.result?.instructions).toContain("WARNING: no nifra project")

    const call = res[2] as {
      result?: { isError?: boolean; content?: { text: string }[] }
    }
    expect(call?.result?.isError).toBe(true)
    expect(call?.result?.content?.[0]?.text).toContain("No nifra project at")
    expect(call?.result?.content?.[0]?.text).toContain("nifra mcp <dir>")

    await rm(dir, { recursive: true, force: true })
  }, 30_000)

  test("no project at cwd, but the client's workspace root is one: it is adopted", async () => {
    const start = await mkdtemp(join(tmpdir(), "nifra-root-e2e-start-"))
    const proj = await mkdtemp(join(tmpdir(), "nifra-root-e2e-proj-"))
    await writeFile(
      join(proj, "package.json"),
      JSON.stringify({ name: "p", type: "module", dependencies: { "@nifrajs/core": "0.0.0" } }),
    )

    let rootsRequested = false
    const res = await rpc(
      start,
      // CALL is deliberately NOT sent up front - it rides behind the roots answer (below), so the
      // server reads it after the adoption it triggers.
      [init({ roots: { listChanged: true } }), READY],
      [1, 2],
      (req) => {
        if (req.method !== "roots/list") return undefined
        rootsRequested = true
        return [
          {
            jsonrpc: "2.0",
            id: req.id,
            result: { roots: [{ uri: Bun.pathToFileURL(proj).href }] },
          },
          CALL,
        ]
      },
    )

    expect(rootsRequested).toBe(true)
    const call = res[2] as { result?: { content?: { text: string }[] } }
    const texts = (call?.result?.content ?? []).map((c) => c.text)
    // Not the fail-closed refusal - and the result is stamped with the ADOPTED root.
    expect(texts.join("\n")).not.toContain("No nifra project at")
    expect(texts.at(-1)).toBe(`[nifra] project root: ${proj}`)

    await rm(start, { recursive: true, force: true })
    await rm(proj, { recursive: true, force: true })
  }, 60_000)
})

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StandardSchemaV1 } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import type { LoadedApp } from "../src/load.ts"
import { detectMonorepo, loadMonorepoApps } from "../src/load.ts"
import {
  createCachedAppLoader,
  extractBackendPrompts,
  extractBackendResources,
  extractBackendTools,
  projectFeatures,
  projectTools,
  resolveProjectDir,
  WarmWorker,
} from "../src/mcp.ts"
import {
  createMcpProtocolState,
  handleRpc,
  type JsonRpcNotification,
  type McpPrompt,
  type McpResource,
  type McpTool,
} from "../src/mcp-protocol.ts"
import { runBackend } from "../src/mcp-run.ts"

const INFO = { name: "nifra", version: "0.0.0-test" }
const tools: McpTool[] = [
  {
    name: "echo",
    description: "echoes its args",
    inputSchema: { type: "object" },
    handler: async (args) => `echo: ${JSON.stringify(args)}`,
  },
  {
    name: "boom",
    description: "throws",
    inputSchema: { type: "object" },
    handler: async () => {
      throw new Error("kaboom")
    },
  },
]
const resources: McpResource[] = [
  {
    uri: "nifra://routes",
    name: "routes",
    mimeType: "application/json",
    read: async () => ({ text: "[]" }),
  },
]
const prompts: McpPrompt[] = [
  {
    name: "nifra_add_endpoint",
    description: "add endpoint",
    arguments: [{ name: "path", required: true }],
    handler: async (args) => [
      { role: "user", content: { type: "text", text: `add ${String(args.path)}` } },
    ],
  },
]

describe("handleRpc (MCP protocol)", () => {
  test("initialize advertises protocol version, tools capability, server info", async () => {
    const res = await handleRpc({ id: 1, method: "initialize" }, tools, INFO)
    expect(res).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: INFO },
    })
  })

  test("initialize advertises optional resources and prompts", async () => {
    const res = await handleRpc({ id: 10, method: "initialize" }, tools, INFO, {
      resources,
      prompts,
    })
    expect(res).toMatchObject({
      result: { capabilities: { tools: {}, resources: {}, prompts: {} } },
    })
  })

  test("notifications get no response", async () => {
    expect(await handleRpc({ method: "notifications/initialized" }, tools, INFO)).toBeNull()
    // A notification (no id) for an unknown method is also silently ignored.
    expect(await handleRpc({ method: "notifications/whatever" }, tools, INFO)).toBeNull()
  })

  test("ping replies empty", async () => {
    expect(await handleRpc({ id: 2, method: "ping" }, tools, INFO)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {},
    })
  })

  test("tools/list returns the tools without leaking the handler", async () => {
    const res = (await handleRpc({ id: 3, method: "tools/list" }, tools, INFO)) as {
      result: { tools: Array<Record<string, unknown>> }
    }
    expect(res.result.tools).toHaveLength(2)
    expect(res.result.tools[0]).toEqual({
      name: "echo",
      description: "echoes its args",
      inputSchema: { type: "object" },
    })
    expect(res.result.tools[0]).not.toHaveProperty("handler")
  })

  test("tools/list compact mode returns only short one-line descriptions", async () => {
    const verbose: McpTool[] = [
      {
        name: "verbose",
        description:
          "Run the detailed operation with a very long explanation. The full description includes schemas, workflows, caveats, and examples that a compact tool list does not need.",
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
        handler: async () => "ok",
      },
    ]
    const res = (await handleRpc(
      { id: 16, method: "tools/list", params: { compact: true } },
      verbose,
      INFO,
    )) as { result: { tools: Array<Record<string, unknown>> } }

    expect(res.result.tools).toEqual([
      {
        name: "verbose",
        description: "Run the detailed operation with a very long explanation.",
      },
    ])
    expect(res.result.tools[0]).not.toHaveProperty("inputSchema")
    expect(res.result.tools[0]).not.toHaveProperty("handler")
  })

  test("tools/describe returns one full tool definition", async () => {
    const res = (await handleRpc(
      { id: 17, method: "tools/describe", params: { name: "echo" } },
      tools,
      INFO,
    )) as { result: { tool: Record<string, unknown> } }

    expect(res.result.tool).toEqual({
      name: "echo",
      description: "echoes its args",
      inputSchema: { type: "object" },
    })
  })

  test("tools/describe rejects unknown tools", async () => {
    expect(
      await handleRpc(
        { id: 18, method: "tools/describe", params: { name: "missing" } },
        tools,
        INFO,
      ),
    ).toMatchObject({ id: 18, error: { code: -32602 } })
  })

  test("tools/call runs the tool and wraps the text result", async () => {
    const res = (await handleRpc(
      { id: 4, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } },
      tools,
      INFO,
    )) as { result: { content: Array<{ type: string; text: string }> } }
    expect(res.result.content[0]).toEqual({ type: "text", text: 'echo: {"a":1}' })
  })

  test("tools/call emits progress notifications when the request has a progress token", async () => {
    const notifications: JsonRpcNotification[] = []
    const res = (await handleRpc(
      {
        id: 15,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { a: 1 },
          _meta: { progressToken: "progress-1" },
        },
      },
      tools,
      INFO,
      {},
      { sendNotification: (n) => notifications.push(n) },
    )) as { result: { content: Array<{ text: string }> } }

    expect(res.result.content[0]?.text).toBe('echo: {"a":1}')
    expect(notifications).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: "progress-1", progress: 0, total: 1 },
      },
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: "progress-1", progress: 1, total: 1 },
      },
    ])
  })

  test("notifications/cancelled aborts an in-flight tool call by request id", async () => {
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const slow: McpTool = {
      name: "slow",
      description: "waits for cancellation",
      inputSchema: { type: "object" },
      handler: async (_args, context) => {
        markStarted()
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve()
          else context.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        return "finished"
      },
    }
    const state = createMcpProtocolState()
    const pending = handleRpc(
      { id: "slow-1", method: "tools/call", params: { name: "slow" } },
      [slow],
      INFO,
      {},
      { state },
    )
    await started
    expect(state.activeRequests.size).toBe(1)

    expect(
      await handleRpc(
        {
          method: "notifications/cancelled",
          params: { requestId: "slow-1", reason: "user stopped it" },
        },
        [slow],
        INFO,
        {},
        { state },
      ),
    ).toBeNull()

    const res = (await pending) as {
      result: { content: Array<{ text: string }>; isError?: boolean }
    }
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0]?.text).toBe("Cancelled: user stopped it")
    expect(state.activeRequests.size).toBe(0)
  })

  test("a throwing tool is reported in-band as isError (not a transport error)", async () => {
    const res = (await handleRpc(
      { id: 5, method: "tools/call", params: { name: "boom" } },
      tools,
      INFO,
    )) as { result: { content: Array<{ text: string }>; isError?: boolean } }
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0]?.text).toContain("kaboom")
  })

  test("an unknown tool is a -32602 error", async () => {
    const res = await handleRpc(
      { id: 6, method: "tools/call", params: { name: "nope" } },
      tools,
      INFO,
    )
    expect(res).toMatchObject({ id: 6, error: { code: -32602 } })
  })

  test("an unknown method with an id is -32601; without an id is ignored", async () => {
    expect(await handleRpc({ id: 7, method: "frobnicate" }, tools, INFO)).toMatchObject({
      id: 7,
      error: { code: -32601 },
    })
    expect(await handleRpc({ method: "frobnicate" }, tools, INFO)).toBeNull()
  })

  test("resources/list and resources/read expose text resources", async () => {
    const listed = (await handleRpc({ id: 11, method: "resources/list" }, tools, INFO, {
      resources,
    })) as { result: { resources: Array<{ uri: string }> } }
    expect(listed.result.resources[0]?.uri).toBe("nifra://routes")

    const read = (await handleRpc(
      { id: 12, method: "resources/read", params: { uri: "nifra://routes" } },
      tools,
      INFO,
      { resources },
    )) as { result: { contents: Array<{ uri: string; text: string; mimeType: string }> } }
    expect(read.result.contents[0]).toEqual({
      uri: "nifra://routes",
      mimeType: "application/json",
      text: "[]",
    })
  })

  test("prompts/list and prompts/get expose reusable agent workflows", async () => {
    const listed = (await handleRpc({ id: 13, method: "prompts/list" }, tools, INFO, {
      prompts,
    })) as { result: { prompts: Array<{ name: string }> } }
    expect(listed.result.prompts[0]?.name).toBe("nifra_add_endpoint")

    const got = (await handleRpc(
      {
        id: 14,
        method: "prompts/get",
        params: { name: "nifra_add_endpoint", arguments: { path: "/users" } },
      },
      tools,
      INFO,
      { prompts },
    )) as { result: { messages: Array<{ content: { text: string } }> } }
    expect(got.result.messages[0]?.content.text).toBe("add /users")
  })
})

describe("createCachedAppLoader", () => {
  test("reuses LoadedApp until the fingerprint or output directory changes", async () => {
    let fingerprint = "one"
    const calls: Array<{ outDirName: string | undefined; importQuery: string | undefined }> = []
    const app = (id: number): LoadedApp => ({
      cwd: "/tmp/app",
      routesDir: "/tmp/app/routes",
      outDir: `/tmp/app/dist-${id}`,
      framework: { adapter: {}, clientModule: "@nifrajs/web-react/client" },
      backend: undefined,
    })
    const loadApp = async (
      _cwd: string,
      outDirName?: string,
      options?: { importQuery?: string },
    ): Promise<LoadedApp> => {
      calls.push({ outDirName, importQuery: options?.importQuery })
      return app(calls.length)
    }
    const cached = createCachedAppLoader("/tmp/app", {
      loadApp,
      fingerprint: async () => fingerprint,
    })

    const first = await cached()
    const second = await cached()
    expect(second).toBe(first)
    expect(calls).toHaveLength(1)

    const otherOut = await cached("custom-dist")
    expect(otherOut).not.toBe(first)
    expect(calls).toHaveLength(2)

    fingerprint = "two"
    const afterChange = await cached("custom-dist")
    expect(afterChange).not.toBe(otherOut)
    expect(calls).toHaveLength(3)
    expect(calls[2]?.importQuery).not.toBe(calls[0]?.importQuery)
  })
})

describe("runBackend (nifra_run engine) — input guards", () => {
  // The import-driven paths (run a real backend, report a no-app / failed-import module) are covered by
  // the end-to-end subprocess smoke in test/mcp-run.smoke.ts and by @nifrajs/runner's own suite — an
  // in-process dynamic import() of a fixture leaks module-loader state that trips Bun's test runner.
  // These guards run before any import, so they're safe + cheap to assert here.
  test("reports when no backend entry exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-run-"))
    const res = (await runBackend(dir, [{ path: "/" }])) as { error?: string }
    expect(res.error).toContain("no backend entry found")
    await rm(dir, { recursive: true, force: true })
  })

  test("non-array requests are rejected", async () => {
    expect(await runBackend("/tmp", "nope" as unknown)).toEqual({
      error: "expected { requests: [...] }",
    })
  })

  test("worker mode reuses the loaded backend between requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-run-worker-"))
    type PipeProc = ReturnType<typeof Bun.spawn> & {
      readonly stdin: { write(input: string): unknown }
      readonly stdout: ReadableStream<Uint8Array>
      readonly exited: Promise<number>
    }
    let proc: PipeProc | undefined
    try {
      await writeFile(
        join(dir, "backend.ts"),
        [
          "let count = 0",
          "export const backend = {",
          "  fetch(req) {",
          "    count++",
          "    return Response.json({ count, path: new URL(req.url).pathname })",
          "  }",
          "}",
          "",
        ].join("\n"),
      )
      proc = Bun.spawn(["bun", join(import.meta.dir, "../src/mcp-run.ts"), dir, "--worker"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }) as PipeProc
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      const readLine = async (): Promise<{
        id: number
        output: { results: Array<{ body: unknown }> }
      }> => {
        for (;;) {
          const nl = buffer.indexOf("\n")
          if (nl !== -1) {
            const line = buffer.slice(0, nl)
            buffer = buffer.slice(nl + 1)
            return JSON.parse(line) as { id: number; output: { results: Array<{ body: unknown }> } }
          }
          const { done, value } = await reader.read()
          if (done) throw new Error("worker exited before response")
          buffer += decoder.decode(value, { stream: true })
        }
      }
      const call = async (id: number, path: string): Promise<{ count: number; path: string }> => {
        proc?.stdin.write(`${JSON.stringify({ id, input: { requests: [{ path }] } })}\n`)
        let timer: ReturnType<typeof setTimeout> | undefined
        const msg = await Promise.race([
          readLine(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timed out waiting for worker")), 5_000)
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer)
        })
        return msg.output.results[0]?.body as { count: number; path: string }
      }

      expect(await call(1, "/one")).toEqual({ count: 1, path: "/one" })
      expect(await call(2, "/two")).toEqual({ count: 2, path: "/two" })
    } finally {
      proc?.kill()
      await proc?.exited.catch(() => 0)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("WarmWorker: cancelling one request leaves concurrent requests + the worker alive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-warm-cancel-"))
    let worker: WarmWorker | undefined
    try {
      // `/slow` parks long enough to be cancelled mid-flight; `count` persists so we can prove the
      // follow-up request hit the SAME loaded process (no cold respawn).
      await writeFile(
        join(dir, "backend.ts"),
        [
          "let count = 0",
          "export const backend = {",
          "  async fetch(req) {",
          "    const url = new URL(req.url)",
          "    if (url.pathname === '/slow') await new Promise((r) => setTimeout(r, 200))",
          "    count++",
          "    return Response.json({ count, path: url.pathname })",
          "  }",
          "}",
          "",
        ].join("\n"),
      )
      worker = new WarmWorker("mcp-run", dir, "test-fingerprint", "run")
      const body = async (raw: string): Promise<{ count: number; path: string }> => {
        const parsed = JSON.parse(raw) as {
          results?: Array<{ body: { count: number; path: string } }>
        }
        const first = parsed.results?.[0]
        if (first === undefined) throw new Error(`no result in worker output: ${raw}`)
        return first.body
      }

      // Two requests outstanding at once, then cancel only the first.
      const aborter = new AbortController()
      const cancelled = worker.request({ requests: [{ path: "/slow" }] }, aborter.signal)
      const survivor = worker.request({ requests: [{ path: "/survivor" }] })
      aborter.abort("user cancelled")

      // The cancelled call returns its cancellation message; the OTHER call still resolves for real
      // (the buggy version killed the shared worker here, rejecting `survivor` with "worker exited").
      expect(await cancelled).toBe("run cancelled: user cancelled.")
      const survivorBody = await body(await survivor)
      expect(survivorBody.path).toBe("/survivor")

      // Worker was never torn down: a follow-up request succeeds and shares the same process, so the
      // persistent counter keeps climbing instead of resetting from a cold respawn.
      const followBody = await body(await worker.request({ requests: [{ path: "/again" }] }))
      expect(followBody.path).toBe("/again")
      expect(followBody.count).toBeGreaterThan(survivorBody.count)
    } finally {
      worker?.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("monorepo detection + tool namespacing", () => {
  test("detectMonorepo returns null for single-app (has routes/)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-mono-"))
    try {
      await mkdir(join(dir, "routes"))
      await writeFile(join(dir, "nifra.config.ts"), `export const apps = { dash: "./apps/dash" }`)
      expect(await detectMonorepo(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("detectMonorepo returns null when no nifra.config.ts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-mono-"))
    try {
      expect(await detectMonorepo(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("detectMonorepo returns null when config has no apps export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-mono-"))
    try {
      await writeFile(join(dir, "nifra.config.ts"), `export const adapter = {}`)
      expect(await detectMonorepo(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("detectMonorepo returns config when root has apps but no routes/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-mono-"))
    try {
      await writeFile(
        join(dir, "nifra.config.ts"),
        `export const apps = { dash: "./apps/dash", portal: "./apps/portal" }`,
      )
      const result = await detectMonorepo(dir)
      expect(result).not.toBeNull()
      expect(result?.apps).toEqual({ dash: "./apps/dash", portal: "./apps/portal" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("loadMonorepoApps resolves absolute cwds for each app", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-mono-"))
    try {
      await writeFile(
        join(dir, "nifra.config.ts"),
        `export const apps = { dash: "./apps/dash", portal: "./apps/portal" }`,
      )
      const config = await detectMonorepo(dir)
      const entries = await loadMonorepoApps(dir, config!)
      expect(entries).toHaveLength(2)
      expect(entries[0]).toEqual({ name: "dash", cwd: join(dir, "apps/dash") })
      expect(entries[1]).toEqual({ name: "portal", cwd: join(dir, "apps/portal") })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("projectTools names are prefixed nifra_<app>_ after namespacing", () => {
    const fakeLoader = async (): Promise<LoadedApp> => {
      throw new Error("should not load")
    }
    const rawTools = projectTools("/fake", fakeLoader)
    const rawNames = rawTools.map((t) => t.name)
    // Simulate what namespaceForApp does (inline, since it's private)
    const prefix = "nifra_dash_"
    const namespaced = rawTools.map((t) => ({ ...t, name: t.name.replace(/^nifra_/, prefix) }))
    for (const t of namespaced) {
      expect(t.name.startsWith("nifra_dash_")).toBe(true)
    }
    // Confirm originals all start with nifra_
    for (const n of rawNames) {
      expect(n.startsWith("nifra_")).toBe(true)
    }
  })

  test("projectTools exposes route assurance as a structured project gate", async () => {
    const assure = projectTools("/fake").find((tool) => tool.name === "nifra_assure")
    expect(assure).toBeDefined()
    expect(assure?.inputSchema).toMatchObject({
      properties: { config: { type: "string" }, dir: { type: "string" } },
    })
    const escaped = JSON.parse(
      (await assure?.handler({ config: "../outside.ts" }, {
        signal: new AbortController().signal,
      } as never)) as string,
    )
    expect(escaped.ok).toBe(false)
    expect(escaped.error).toContain("inside")
  })

  test("projectTools exposes the verification ladder and keeps config inside the project", async () => {
    const levels = projectTools("/fake").find((tool) => tool.name === "nifra_levels")
    expect(levels).toBeDefined()
    expect(levels?.inputSchema).toMatchObject({
      properties: { config: { type: "string" }, seed: { type: "number" }, dir: { type: "string" } },
    })
    const escaped = JSON.parse(
      (await levels?.handler({ config: "../outside.ts" }, {
        signal: new AbortController().signal,
      } as never)) as string,
    )
    expect(escaped.ok).toBe(false)
    expect(escaped.error).toContain("inside")

    const badSeed = JSON.parse(
      (await levels?.handler({ seed: 1.5 }, {
        signal: new AbortController().signal,
      } as never)) as string,
    )
    expect(badSeed.ok).toBe(false)
  })

  test("nifra_levels reports the ladder for a real project, not just its own shape", async () => {
    // No assurance config: the ladder must still answer, stopping at L0 by definition rather than
    // throwing - an agent needs the reasons, not a crash.
    const dir = await mkdtemp(join(tmpdir(), "nifra-mcp-levels-"))
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }))
      const levels = projectTools(dir).find((tool) => tool.name === "nifra_levels")
      const report = JSON.parse(
        (await levels?.handler({}, { signal: new AbortController().signal } as never)) as string,
      )
      expect(typeof report.achieved).toBe("number")
      expect(Array.isArray(report.levels)).toBe(true)
      expect(report.levels.length).toBeGreaterThan(0)
      expect(report.levels[0]).toMatchObject({ level: 0, ok: expect.any(Boolean) })
      // Every failing level explains itself.
      for (const level of report.levels) {
        if (!level.ok) expect(level.reasons.length).toBeGreaterThan(0)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("projectFeatures resource URIs are prefixed after namespacing", () => {
    const fakeLoader = async (): Promise<LoadedApp> => {
      throw new Error("should not load")
    }
    const features = projectFeatures("/fake", fakeLoader)
    const namespaced = (features.resources ?? []).map((r) => ({
      ...r,
      uri: r.uri.replace(/^nifra:\/\//, "nifra://portal/"),
    }))
    for (const r of namespaced) {
      expect(r.uri.startsWith("nifra://portal/")).toBe(true)
    }
  })
})

describe("nifra_check / nifra_test — `dir` scopes to a subdirectory", () => {
  test("resolveProjectDir resolves subdirs and rejects escapes (path-traversal guard)", () => {
    const root = "/proj"
    expect(resolveProjectDir(root, undefined)).toBe(root) // no dir → root
    expect(resolveProjectDir(root, "")).toBe(root)
    expect(resolveProjectDir(root, "app")).toBe("/proj/app")
    expect(resolveProjectDir(root, "packages/api")).toBe("/proj/packages/api")
    expect(resolveProjectDir(root, "./app/")).toBe("/proj/app")
    expect(resolveProjectDir(root, "../escape")).toBeNull() // climbs out → rejected
    expect(resolveProjectDir(root, "/etc/passwd")).toBeNull() // absolute elsewhere → rejected
    expect(resolveProjectDir(root, "app/../../escape")).toBeNull() // normalizes then escapes → rejected
  })

  test("nifra_check with dir checks only that subtree; an escaping dir errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-mcp-dir-"))
    await mkdir(join(dir, "app", "routes"), { recursive: true })
    await mkdir(join(dir, "routes"), { recursive: true })
    await writeFile(join(dir, "app", "routes", "a.tsx"), 'export const f = () => fetch("/a")')
    await writeFile(join(dir, "routes", "root.tsx"), 'export const g = () => fetch("/root")')

    const check = projectTools(dir).find((t) => t.name === "nifra_check")
    expect(check).toBeDefined()
    const ctx = { signal: new AbortController().signal } as never

    const scoped = JSON.parse(
      (await check!.handler({ dir: "app", lintsOnly: true }, ctx)) as string,
    )
    // Findings are relative to the scoped dir (app/), and the root-level file is NOT scanned.
    expect(scoped.diagnostics.length).toBeGreaterThan(0)
    expect(JSON.stringify(scoped)).not.toContain("root.tsx")

    const escaped = JSON.parse((await check!.handler({ dir: "../etc" }, ctx)) as string)
    expect(escaped.ok).toBe(false)
    expect(escaped.error).toContain("escapes")

    await rm(dir, { recursive: true, force: true })
  })
})

describe("extractBackendTools (.tool() → MCP)", () => {
  const weatherSchema: StandardSchemaV1<unknown, { location: string }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) =>
        value &&
        typeof value === "object" &&
        "location" in value &&
        typeof value.location === "string"
          ? { value: value as { location: string } }
          : { issues: [{ message: "location must be a string", path: ["location"] }] },
    },
  }

  const weatherApp = () =>
    server().tool(
      "get_weather",
      { description: "Get weather for a location", input: weatherSchema },
      (input) => ({ temp: 22, location: input.location }),
    )

  test("a .tool() route surfaces as an MCP tool with its name, description, and input schema", () => {
    const backendTools = extractBackendTools(weatherApp())
    const tool = backendTools.find((t) => t.name === "get_weather")
    expect(tool).toBeDefined()
    expect(tool?.description).toBe("Get weather for a location")
    expect(tool?.inputSchema).toBeDefined()
  })

  test("the surfaced tool appears in tools/list without leaking its handler", async () => {
    const backendTools = extractBackendTools(weatherApp())
    const res = (await handleRpc({ id: 1, method: "tools/list" }, backendTools, INFO)) as {
      result: { tools: Array<Record<string, unknown>> }
    }
    const listed = res.result.tools.find((t) => t.name === "get_weather")
    expect(listed).toBeDefined()
    expect(listed).not.toHaveProperty("handler")
  })

  test("tools/call runs the tool through the backend handler", async () => {
    const backendTools = extractBackendTools(weatherApp())
    const res = (await handleRpc(
      {
        id: 2,
        method: "tools/call",
        params: { name: "get_weather", arguments: { location: "Paris" } },
      },
      backendTools,
      INFO,
    )) as {
      result: { content: Array<{ type: string; text: string }>; structuredContent?: unknown }
    }
    const text = res.result.content.map((c) => c.text).join("")
    expect(text).toContain("Paris")
    expect(text).toContain("22")
  })

  test("tools/call surfaces a backend validation failure as an error", async () => {
    const backendTools = extractBackendTools(weatherApp())
    const res = (await handleRpc(
      { id: 3, method: "tools/call", params: { name: "get_weather", arguments: {} } },
      backendTools,
      INFO,
    )) as { result: { isError?: boolean; content: Array<{ text: string }> } }
    expect(res.result.isError).toBe(true)
  })

  test("tool annotations (safety hints) surface in tools/list", async () => {
    const app = server().tool(
      "read_weather",
      {
        description: "Read the weather",
        input: weatherSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      (input) => ({ location: input.location }),
    )
    const backendTools = extractBackendTools(app)
    const res = (await handleRpc({ id: 9, method: "tools/list" }, backendTools, INFO)) as {
      result: { tools: Array<Record<string, unknown>> }
    }
    const listed = res.result.tools.find((t) => t.name === "read_weather")
    expect(listed?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true })
  })

  test("a backend without .tool() routes yields no tools", () => {
    expect(extractBackendTools(server())).toEqual([])
    expect(extractBackendTools(null)).toEqual([])
    expect(extractBackendTools({})).toEqual([])
  })
})

describe("extractBackendResources / extractBackendPrompts (.resource()/.prompt() → MCP)", () => {
  const app = () =>
    server()
      .resource("app://config", { name: "config", mimeType: "application/json" }, () =>
        JSON.stringify({ ok: true }),
      )
      .prompt(
        "greet",
        { description: "Greet", arguments: [{ name: "who", required: true }] },
        (args) => [{ role: "user", content: { type: "text", text: `Hi ${args.who}` } }],
      )

  test("a .resource() surfaces in resources/list and reads via resources/read", async () => {
    const resources = extractBackendResources(app())
    const listed = (await handleRpc({ id: 20, method: "resources/list" }, [], INFO, {
      resources,
    })) as { result: { resources: Array<{ uri: string }> } }
    expect(listed.result.resources.some((r) => r.uri === "app://config")).toBe(true)

    const read = (await handleRpc(
      { id: 21, method: "resources/read", params: { uri: "app://config" } },
      [],
      INFO,
      { resources },
    )) as { result: { contents: Array<{ text: string; mimeType?: string }> } }
    expect(read.result.contents[0]?.text).toContain('"ok":true')
    expect(read.result.contents[0]?.mimeType).toBe("application/json")
  })

  test("a .prompt() surfaces in prompts/list and renders via prompts/get", async () => {
    const prompts = extractBackendPrompts(app())
    const listed = (await handleRpc({ id: 22, method: "prompts/list" }, [], INFO, {
      prompts,
    })) as { result: { prompts: Array<{ name: string }> } }
    expect(listed.result.prompts.some((p) => p.name === "greet")).toBe(true)

    const got = (await handleRpc(
      { id: 23, method: "prompts/get", params: { name: "greet", arguments: { who: "Ada" } } },
      [],
      INFO,
      { prompts },
    )) as { result: { messages: Array<{ content: { text: string } }> } }
    expect(got.result.messages[0]?.content.text).toBe("Hi Ada")
  })

  test("empty for a backend without .resource()/.prompt()", () => {
    expect(extractBackendResources(server())).toEqual([])
    expect(extractBackendResources(null)).toEqual([])
    expect(extractBackendPrompts(server())).toEqual([])
    expect(extractBackendPrompts({})).toEqual([])
  })
})

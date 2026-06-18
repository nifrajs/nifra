import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LoadedApp } from "../src/load.ts"
import { createCachedAppLoader } from "../src/mcp.ts"
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
})

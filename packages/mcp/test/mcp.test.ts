import { describe, expect, test } from "bun:test"
import {
  createMcpServer,
  defineMcpTool,
  defineMcpWidget,
  handleRpc,
  MCP_ERROR,
  type McpTool,
  MODERN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  respondMcpHttp,
  type StandardSchemaV1,
  UI_EXTENSION_KEY,
  UI_MIME,
} from "../src/index.ts"
import { createMcpProtocolState } from "../src/protocol.ts"

const INFO = { name: "test", version: "0.0.0" }

const widget = defineMcpWidget({
  uri: "ui://orders/table",
  name: "Orders table",
  description: "An interactive orders table",
  html: `<div id="root"></div><script>mcpApp.onData(function(d){document.getElementById("root").textContent=JSON.stringify(d);});</script>`,
})

const ordersTool = defineMcpTool({
  name: "list_orders",
  description: "List orders and render them as an interactive table.",
  widget,
  handler: () => ({
    text: "2 orders",
    structuredContent: { orders: [{ id: 1 }, { id: 2 }] },
  }),
})

const progressTool = defineMcpTool({
  name: "progress",
  description: "Report progress",
  handler: async (_args, context) => {
    context.reportProgress(0.5, 1)
    return "complete"
  },
})

describe("defineMcpWidget", () => {
  test("rejects a non-ui:// uri", () => {
    expect(() => defineMcpWidget({ uri: "https://x", name: "x", html: "" })).toThrow(/ui:\/\//)
  })

  test("produces a text/html;profile=mcp-app resource with the bridge inlined", async () => {
    expect(widget.resource.mimeType).toBe(UI_MIME)
    const { text, mimeType } = await widget.resource.read()
    expect(mimeType).toBe(UI_MIME)
    expect(text).toContain("window.mcpApp")
    expect(text).toContain("ui/notifications/tool-result")
    expect(text).toContain('<div id="root">')
  })

  test("meta carries the nested ui link", () => {
    expect(widget.meta).toEqual({ ui: { resourceUri: "ui://orders/table" } })
  })

  test("escapes HTML metacharacters in the document title", async () => {
    const w = defineMcpWidget({ uri: "ui://x/y", name: "n", title: `A & B <script>`, html: "" })
    const { text } = await w.resource.read()
    expect(text).toContain("<title>A &amp; B &lt;script&gt;</title>")
    expect(text).not.toContain("<title>A & B <script></title>")
  })

  test("the bridge handles host theme pushes (shadcn token convention)", async () => {
    const { text } = await widget.resource.read()
    expect(text).toContain("ui/notifications/theme")
    expect(text).toContain("setProperty")
    expect(text).toContain("colorScheme")
  })
})

describe("defineMcpTool - render intent", () => {
  test("intent lands in _meta.ui.intent (builder hosts)", () => {
    const tool = defineMcpTool({
      name: "list_things",
      description: "x",
      intent: "table",
      handler: () => ({ structuredContent: { rows: [] } }),
    })
    expect(tool._meta).toEqual({ ui: { intent: "table" } })
  })

  test("widget + intent coexist under _meta.ui", () => {
    const tool = defineMcpTool({
      name: "list_things",
      description: "x",
      widget,
      intent: "table",
      handler: () => "ok",
    })
    expect(tool._meta).toEqual({
      ui: { resourceUri: "ui://orders/table", intent: "table" },
    })
  })

  test("no widget, no intent → no _meta", () => {
    const tool = defineMcpTool({ name: "plain", description: "x", handler: () => "ok" })
    expect(tool._meta).toBeUndefined()
  })
})

describe("defineMcpTool - standard-schema input", () => {
  interface EchoArgs {
    message: string
  }
  // A hand-rolled Standard Schema that also carries a JSON Schema, like nifra's `t` does.
  const echoInput: StandardSchemaV1<unknown, EchoArgs> & {
    jsonSchema: Record<string, unknown>
  } = {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate: (value: unknown) => {
        if (
          typeof value === "object" &&
          value !== null &&
          "message" in value &&
          typeof (value as { message: unknown }).message === "string"
        ) {
          return { value: { message: (value as { message: string }).message } }
        }
        return { issues: [{ message: "must be a string", path: ["message"] }] }
      },
    },
    jsonSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  }

  const echo = defineMcpTool({
    name: "echo",
    description: "echo the message",
    input: echoInput,
    handler: (args: EchoArgs) => `echoed: ${args.message}`,
  })

  const ctx = { signal: new AbortController().signal, requestId: 1, reportProgress: () => {} }

  test("advertises the schema's own JSON Schema as inputSchema", () => {
    expect(echo.inputSchema).toEqual({
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    })
  })

  test("an explicit inputSchema overrides the derived one", () => {
    const t = defineMcpTool({
      name: "x",
      description: "x",
      input: echoInput,
      inputSchema: { type: "object" },
      handler: () => "ok",
    })
    expect(t.inputSchema).toEqual({ type: "object" })
  })

  test("valid arguments reach the handler validated and typed", async () => {
    const result = await echo.handler({ message: "hi" }, ctx)
    expect(result).toBe("echoed: hi")
  })

  test("invalid arguments return an in-band isError result naming the issue", async () => {
    const result = await echo.handler({ message: 7 }, ctx)
    expect(typeof result).not.toBe("string")
    const rich = result as { isError?: boolean; content: Array<{ type: string; text: string }> }
    expect(rich.isError).toBe(true)
    expect(rich.content[0]?.text).toContain("message: must be a string")
  })

  test("a schema without a JSON Schema still validates, with the empty-object descriptor", () => {
    const bare = defineMcpTool({
      name: "bare",
      description: "x",
      input: {
        "~standard": {
          version: 1 as const,
          vendor: "test",
          validate: (v: unknown) => ({ value: v as Record<string, unknown> }),
        },
      },
      handler: () => "ok",
    })
    expect(bare.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    })
  })
})

describe("handleRpc - MCP Apps extensions", () => {
  const features = { resources: [widget.resource], ui: { mimeTypes: [UI_MIME] } }

  test("initialize advertises the io.modelcontextprotocol/ui extension", async () => {
    const res = await handleRpc({ id: 1, method: "initialize" }, [ordersTool], INFO, features)
    const caps = (res as { result: { capabilities: Record<string, unknown> } }).result.capabilities
    expect(caps.extensions).toEqual({ [UI_EXTENSION_KEY]: { mimeTypes: [UI_MIME] } })
  })

  test("initialize carries features.instructions; omits the field when unset", async () => {
    const withIt = await handleRpc({ id: 1, method: "initialize" }, [ordersTool], INFO, {
      instructions: "serve /w/app",
    })
    expect((withIt as { result: { instructions?: string } }).result.instructions).toBe(
      "serve /w/app",
    )
    const without = await handleRpc({ id: 1, method: "initialize" }, [ordersTool], INFO, {})
    expect("instructions" in (without as { result: object }).result).toBe(false)
  })

  test("tools/list surfaces the tool's _meta ui link", async () => {
    const res = await handleRpc({ id: 2, method: "tools/list" }, [ordersTool], INFO, features)
    const tool = (res as { result: { tools: Array<{ name: string; _meta?: unknown }> } }).result
      .tools[0]
    expect(tool?._meta).toMatchObject({ ui: { resourceUri: "ui://orders/table" } })
  })

  test("tools/call returns structuredContent + the ui _meta, plus text content", async () => {
    const res = await handleRpc(
      { id: 3, method: "tools/call", params: { name: "list_orders", arguments: {} } },
      [ordersTool],
      INFO,
      features,
    )
    const result = (
      res as {
        result: {
          content: Array<{ type: string; text: string }>
          structuredContent: { orders: unknown[] }
          _meta: { ui: { resourceUri: string } }
        }
      }
    ).result
    expect(result.content[0]).toEqual({ type: "text", text: "2 orders" })
    expect(result.structuredContent).toEqual({ orders: [{ id: 1 }, { id: 2 }] })
    expect(result._meta.ui.resourceUri).toBe("ui://orders/table")
  })

  test("resources/read returns the widget HTML with the MCP App mime", async () => {
    const res = await handleRpc(
      { id: 4, method: "resources/read", params: { uri: "ui://orders/table" } },
      [ordersTool],
      INFO,
      features,
    )
    const contents = (res as { result: { contents: Array<{ mimeType: string; text: string }> } })
      .result.contents
    expect(contents[0]?.mimeType).toBe(UI_MIME)
    expect(contents[0]?.text).toContain("window.mcpApp")
  })

  test("a plain string handler returns text content without structuredContent/_meta", async () => {
    const textTool: McpTool = {
      name: "ping",
      description: "ping",
      inputSchema: { type: "object" },
      handler: () => Promise.resolve("pong"),
    }
    const res = await handleRpc(
      { id: 5, method: "tools/call", params: { name: "ping" } },
      [textTool],
      INFO,
    )
    expect((res as { result: Record<string, unknown> }).result).toEqual({
      content: [{ type: "text", text: "pong" }],
    })
  })
})

// On stdio a single peer multiplexes every request over one pipe, so the request id is the only
// thing tying a response to its caller. Two in-flight calls sharing an id make `notifications/
// cancelled` ambiguous - it would abort whichever one happens to hold the slot - and let the second
// response be read as the answer to the first.
describe("handleRpc - duplicate in-flight request ids", () => {
  const slowTool: McpTool = {
    name: "slow",
    description: "blocks until released",
    inputSchema: { type: "object", properties: {} },
    handler: () => release.then(() => "done"),
  }
  let releaseFn: () => void = () => {}
  let release: Promise<void> = new Promise<void>((r) => {
    releaseFn = r
  })

  test("a second call reusing an in-flight id is refused, and the id frees on completion", async () => {
    const state = createMcpProtocolState()
    const call = (): Promise<unknown> =>
      handleRpc(
        { id: 1, method: "tools/call", params: { name: "slow" } },
        [slowTool],
        INFO,
        {},
        { state },
      )

    const first = call()
    const duplicate = (await call()) as { error: { code: number; message: string } }
    expect(duplicate.error.code).toBe(-32600)
    expect(duplicate.error.message).toMatch(/duplicate request id/)

    releaseFn()
    expect((await first) as { result: unknown }).toMatchObject({
      result: { content: [{ type: "text", text: "done" }] },
    })

    // The slot is released in `finally`, so the client can legitimately reuse the id afterwards.
    release = Promise.resolve()
    expect((await call()) as { result: unknown }).toMatchObject({
      result: { content: [{ type: "text", text: "done" }] },
    })
  })
})

describe("createMcpServer.fetch - end to end over HTTP", () => {
  const mcp = createMcpServer({
    name: "orders",
    version: "1.0.0",
    tools: [ordersTool],
    widgets: [widget],
  })

  const post = (body: unknown): Request =>
    new Request("http://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  test("initialize → ui capability; tools/list → linked tool; tools/call → structuredContent", async () => {
    const init = await (
      await mcp.fetch(post({ jsonrpc: "2.0", id: 1, method: "initialize" }))
    ).json()
    const extensions = (
      init as { result: { capabilities: { extensions?: Record<string, unknown> } } }
    ).result.capabilities.extensions
    // NB: the key has dots, so toHaveProperty would mis-parse it as a path - assert directly.
    expect(extensions?.[UI_EXTENSION_KEY]).toEqual({ mimeTypes: [UI_MIME] })

    const call = await (
      await mcp.fetch(
        post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_orders" } }),
      )
    ).json()
    expect(
      (call as { result: { structuredContent: { orders: unknown[] } } }).result.structuredContent
        .orders,
    ).toHaveLength(2)
  })

  test("GET is a health page", async () => {
    const res = await mcp.fetch(new Request("http://x/mcp"))
    expect(res.status).toBe(200)
  })

  test("handle() dispatches a single JSON-RPC message headlessly", async () => {
    const res = await mcp.handle({ id: 9, method: "tools/list" })
    expect((res as { result: { tools: unknown[] } }).result.tools).toHaveLength(1)
  })

  // A route guard sees one opaque POST; only a per-message hook can let a caller list tools while
  // refusing to run them. The refusal must carry no result at all, not an empty one.
  test("authorizeMessage gates individual messages; the per-request override wins", async () => {
    const readOnly = createMcpServer({
      name: "orders",
      version: "1.0.0",
      tools: [ordersTool],
      widgets: [widget],
      authorizeMessage: (message) => message.method !== "tools/call",
    })

    const listed = await readOnly.fetch(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
    expect(listed.status).toBe(200)

    const called = await readOnly.fetch(
      post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_orders" } }),
    )
    expect(called.status).toBe(403)
    const body = (await called.json()) as {
      id: number
      result?: unknown
      error: { code: number; message: string }
    }
    expect(body.id).toBe(2)
    expect(body.result).toBeUndefined()
    expect(body.error.code).toBe(MCP_ERROR.UNAUTHORIZED)

    // The surrounding handler resolved a session that does allow writes.
    const elevated = await readOnly.fetch(
      post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_orders" } }),
      { authorizeMessage: () => true },
    )
    expect(elevated.status).toBe(200)
    expect(
      ((await elevated.json()) as { result: { structuredContent: { orders: unknown[] } } }).result
        .structuredContent.orders,
    ).toHaveLength(2)
  })
})

describe("respondMcpHttp - transport hardening", () => {
  const serve = (request: Request, options = {}): Promise<Response> =>
    respondMcpHttp(request, [ordersTool], INFO, options)
  const post = (body: unknown, headers: Record<string, string> = {}): Request =>
    new Request("http://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })

  test("OPTIONS preflight allows the headers a browser MCP client sends", async () => {
    const res = await serve(new Request("http://x/mcp", { method: "OPTIONS" }))
    expect(res.status).toBe(204)
    const allow = res.headers.get("access-control-allow-headers") ?? ""
    for (const header of ["mcp-protocol-version", "mcp-method", "mcp-name", "authorization"]) {
      expect(allow).toContain(header)
    }
  })

  test("rejects a non-finite body cap before reading the request", async () => {
    await expect(
      serve(post({ jsonrpc: "2.0", id: 1, method: "initialize" }), {
        maxBodyBytes: Number.NaN,
      }),
    ).rejects.toThrow(/maxBodyBytes/)
  })

  test("a notification (no id) is acknowledged with 202 and an empty body", async () => {
    const res = await serve(post({ jsonrpc: "2.0", method: "notifications/initialized" }))
    expect(res.status).toBe(202)
    expect(await res.text()).toBe("")
  })

  test("GET opens a cancellable SSE stream; a plain GET is the health page", async () => {
    const sse = await serve(
      new Request("http://x/mcp", { headers: { accept: "text/event-stream" } }),
    )
    expect(sse.status).toBe(200)
    expect(sse.headers.get("content-type")).toContain("text/event-stream")
    const reader = sse.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader?.read()
    expect(new TextDecoder().decode(first?.value ?? new Uint8Array())).toBe(": connected\n\n")
    await reader?.cancel()
    const health = await serve(new Request("http://x/mcp"))
    expect(health.status).toBe(200)
  })

  test("an already-aborted SSE request closes before running the stream", async () => {
    const controller = new AbortController()
    controller.abort()
    const res = await serve(
      new Request("http://x/mcp", {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      }),
    )
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    expect(await reader?.read()).toMatchObject({ done: true })
  })

  test("aborting an active SSE request closes the stream", async () => {
    const controller = new AbortController()
    const res = await serve(
      new Request("http://x/mcp", {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      }),
    )
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error("SSE response has no body")
    expect(new TextDecoder().decode((await reader.read()).value ?? new Uint8Array())).toBe(
      ": connected\n\n",
    )
    controller.abort()
    expect(await reader.read()).toMatchObject({ done: true })
  })

  test("a non-POST, non-GET method is rejected with Allow", async () => {
    const res = await serve(new Request("http://x/mcp", { method: "PUT" }))
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("POST, GET")
  })

  test("malformed and oversized declared bodies are rejected before dispatch", async () => {
    const malformed = await serve(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "not-a-number" },
        body: "{}",
      }),
    )
    expect(malformed.status).toBe(400)

    const oversized = await serve(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "100" },
        body: "{}",
      }),
      { maxBodyBytes: 2 },
    )
    expect(oversized.status).toBe(413)
  })

  test("POST streams progress notifications before the final JSON-RPC response", async () => {
    const res = await respondMcpHttp(
      new Request("http://x/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 21,
          method: "tools/call",
          params: { name: "progress", _meta: { progressToken: "job-21" } },
        }),
      }),
      [progressTool],
      INFO,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(res.headers.get("cache-control")).toContain("no-cache")
    const text = await res.text()
    const messages = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>)
    expect(
      messages.slice(0, 3).map((message) => (message.params as { progress: number }).progress),
    ).toEqual([0, 0.5, 1])
    expect(messages[3]).toMatchObject({ id: 21, result: { content: [{ text: "complete" }] } })
  })

  test("an unexpected dispatch failure errors the SSE stream", async () => {
    const res = await respondMcpHttp(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 22,
          method: "tools/call",
          params: { name: "missing" },
        }),
      }),
      [undefined as never],
      INFO,
    )
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    await expect(reader?.read()).rejects.toBeInstanceOf(Error)
  })

  test("with an allowlist, a foreign Origin is rejected 403 before the body is read", async () => {
    const options = { allowedOrigins: ["http://localhost:8787"] }
    const bad = await serve(
      post({ jsonrpc: "2.0", id: 1, method: "initialize" }, { origin: "http://evil.test" }),
      options,
    )
    expect(bad.status).toBe(403)
    const ok = await serve(
      post({ jsonrpc: "2.0", id: 1, method: "initialize" }, { origin: "http://localhost:8787" }),
      options,
    )
    expect(ok.status).toBe(200)
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:8787")
  })

  test("initialize echoes a protocol version the server also speaks, else its default", async () => {
    const echoed = await (
      await serve(
        post({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25" },
        }),
      )
    ).json()
    expect((echoed as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      "2025-11-25",
    )
    const fallback = await (
      await serve(
        post({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "1999-01-01" },
        }),
      )
    ).json()
    expect((fallback as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      PROTOCOL_VERSION,
    )
  })
})

describe("2026-07-28 modern transport (dual-era)", () => {
  const MODERN = MODERN_PROTOCOL_VERSION
  const VERSION_KEY = "io.modelcontextprotocol/protocolVersion"
  const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo"
  const meta = (extra: Record<string, unknown> = {}): { _meta: Record<string, unknown> } => ({
    _meta: { [VERSION_KEY]: MODERN, ...extra },
  })
  const features = {
    resources: [widget.resource],
    ui: { mimeTypes: [UI_MIME] },
    instructions: "Use nifra.",
  }
  type ModernResult = {
    resultType?: string
    supportedVersions?: string[]
    capabilities?: { tools?: unknown; resources?: unknown; extensions?: Record<string, unknown> }
    instructions?: string
    tools?: unknown[]
    structuredContent?: { orders: unknown[] }
    _meta?: Record<string, unknown>
    ttlMs?: number
    cacheScope?: string
  }
  type RpcOk = { result: ModernResult }
  type RpcErr = { error: { code: number; data?: { supported?: string[]; requested?: string } } }

  test("server/discover returns versions, capabilities, identity, and a cache envelope", async () => {
    const res = await handleRpc(
      { id: 1, method: "server/discover", params: meta() },
      [ordersTool],
      INFO,
      features,
    )
    const result = (res as RpcOk).result
    expect(result.resultType).toBe("complete")
    expect(result.supportedVersions).toEqual([MODERN])
    expect(result.capabilities?.tools).toEqual({})
    expect(result.capabilities?.resources).toEqual({})
    expect(result.capabilities?.extensions?.[UI_EXTENSION_KEY]).toEqual({ mimeTypes: [UI_MIME] })
    expect(result.instructions).toBe("Use nifra.")
    expect(result._meta?.[SERVER_INFO_KEY]).toEqual(INFO)
    expect(result.ttlMs).toBeGreaterThan(0)
    expect(result.cacheScope).toBe("public")
  })

  test("a modern request declaring an unsupported version is rejected with -32022 + supported list", async () => {
    const res = await handleRpc(
      { id: 2, method: "tools/list", params: { _meta: { [VERSION_KEY]: "1999-01-01" } } },
      [ordersTool],
      INFO,
    )
    const err = (res as RpcErr).error
    expect(err.code).toBe(MCP_ERROR.UNSUPPORTED_VERSION)
    expect(err.data?.supported).toEqual([MODERN])
    expect(err.data?.requested).toBe("1999-01-01")
  })

  test("modern tools/list carries resultType + cache hints + serverInfo; legacy carries none", async () => {
    const modern = (
      (await handleRpc(
        { id: 3, method: "tools/list", params: meta() },
        [ordersTool],
        INFO,
      )) as RpcOk
    ).result
    expect(modern.resultType).toBe("complete")
    expect(modern.ttlMs).toBeGreaterThan(0)
    expect(modern.cacheScope).toBe("public")
    expect(modern._meta?.[SERVER_INFO_KEY]).toEqual(INFO)
    expect(modern.tools).toHaveLength(1)

    const legacy = ((await handleRpc({ id: 4, method: "tools/list" }, [ordersTool], INFO)) as RpcOk)
      .result
    expect(legacy.resultType).toBeUndefined()
    expect(legacy.ttlMs).toBeUndefined()
    expect(legacy._meta).toBeUndefined()
  })

  test("modern tools/call keeps the ui _meta link and adds serverInfo + resultType", async () => {
    const result = (
      (await handleRpc(
        { id: 5, method: "tools/call", params: { name: "list_orders", ...meta() } },
        [ordersTool],
        INFO,
        features,
      )) as RpcOk
    ).result
    expect(result.resultType).toBe("complete")
    expect(result.structuredContent?.orders).toHaveLength(2)
    expect((result._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe(
      "ui://orders/table",
    )
    expect(result._meta?.[SERVER_INFO_KEY]).toEqual(INFO)
  })

  const modernPost = (
    body: { id?: number; method: string; params?: Record<string, unknown> },
    headers: Record<string, string>,
  ): Promise<Response> =>
    respondMcpHttp(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": MODERN, ...headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...body,
          params: { ...body.params, ...meta() },
        }),
      }),
      [ordersTool],
      INFO,
      { features },
    )

  test("a fully-mirrored modern POST succeeds with 200 + enveloped result", async () => {
    const res = await modernPost(
      { id: 10, method: "tools/call", params: { name: "list_orders" } },
      { "mcp-method": "tools/call", "mcp-name": "list_orders" },
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as RpcOk).result.resultType).toBe("complete")
  })

  test("a header/body mismatch is rejected 400 + HeaderMismatch before dispatch", async () => {
    const res = await modernPost(
      { id: 11, method: "tools/call", params: { name: "list_orders" } },
      { "mcp-method": "tools/list", "mcp-name": "list_orders" }, // header method contradicts the body
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as RpcErr).error.code).toBe(MCP_ERROR.HEADER_MISMATCH)
  })

  test("modern requests reject a missing protocol header and malformed name sentinel", async () => {
    const missingVersion = await respondMcpHttp(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-method": "tools/list" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 14,
          method: "tools/list",
          params: { _meta: { [VERSION_KEY]: MODERN } },
        }),
      }),
      [ordersTool],
      INFO,
    )
    expect(missingVersion.status).toBe(400)
    expect(((await missingVersion.json()) as RpcErr).error.code).toBe(MCP_ERROR.HEADER_MISMATCH)

    const malformedName = await modernPost(
      { id: 15, method: "tools/call", params: { name: "list_orders" } },
      { "mcp-method": "tools/call", "mcp-name": "=?base64?not-valid?=" },
    )
    expect(malformedName.status).toBe(400)
    expect(((await malformedName.json()) as RpcErr).error.code).toBe(MCP_ERROR.HEADER_MISMATCH)
  })

  test("a modern unknown method is 404 + -32601", async () => {
    const res = await modernPost(
      { id: 12, method: "does/notexist" },
      { "mcp-method": "does/notexist" },
    )
    expect(res.status).toBe(404)
    expect(((await res.json()) as RpcErr).error.code).toBe(-32601)
  })

  test("a modern unsupported version is 400 + -32022", async () => {
    const res = await respondMcpHttp(
      new Request("http://x/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": "1999-01-01",
          "mcp-method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 13,
          method: "tools/list",
          params: { _meta: { [VERSION_KEY]: "1999-01-01" } },
        }),
      }),
      [ordersTool],
      INFO,
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as RpcErr).error.code).toBe(MCP_ERROR.UNSUPPORTED_VERSION)
  })
})

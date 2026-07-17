import { describe, expect, test } from "bun:test"
import {
  createMcpServer,
  defineMcpTool,
  defineMcpWidget,
  handleRpc,
  type McpTool,
  type StandardSchemaV1,
  UI_EXTENSION_KEY,
  UI_MIME,
} from "../src/index.ts"

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

  test("the bridge handles host theme pushes (shadcn token convention)", async () => {
    const { text } = await widget.resource.read()
    expect(text).toContain("ui/notifications/theme")
    expect(text).toContain("setProperty")
    expect(text).toContain("colorScheme")
  })
})

describe("defineMcpTool — render intent", () => {
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

describe("defineMcpTool — standard-schema input", () => {
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

describe("handleRpc — MCP Apps extensions", () => {
  const features = { resources: [widget.resource], ui: { mimeTypes: [UI_MIME] } }

  test("initialize advertises the io.modelcontextprotocol/ui extension", async () => {
    const res = await handleRpc({ id: 1, method: "initialize" }, [ordersTool], INFO, features)
    const caps = (res as { result: { capabilities: Record<string, unknown> } }).result.capabilities
    expect(caps.extensions).toEqual({ [UI_EXTENSION_KEY]: { mimeTypes: [UI_MIME] } })
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

describe("createMcpServer.fetch — end to end over HTTP", () => {
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
    // NB: the key has dots, so toHaveProperty would mis-parse it as a path — assert directly.
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
})

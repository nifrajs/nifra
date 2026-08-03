import { describe, expect, test } from "bun:test"
import { handleMcpHttp, publicDocsTools, respondMcpHttp } from "../src/mcp-http.ts"

const post = (body: unknown): Request =>
  new Request("http://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("publicDocsTools", () => {
  test("exposes exactly the project-independent tools", () => {
    expect(
      publicDocsTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["nifra_docs", "nifra_example", "nifra_gallery", "nifra_learn", "nifra_types"])
  })
})

describe("handleMcpHttp", () => {
  test("GET → health text, OPTIONS → 204 preflight, both CORS-enabled", async () => {
    const get = await handleMcpHttp(new Request("http://x/mcp"))
    expect(get.status).toBe(200)
    expect(get.headers.get("access-control-allow-origin")).toBe("*")
    expect(await get.text()).toContain("nifra_example")
    const opt = await handleMcpHttp(new Request("http://x/mcp", { method: "OPTIONS" }))
    expect(opt.status).toBe(204)
  })

  test("initialize returns the server info + protocol version", async () => {
    const res = await handleMcpHttp(post({ jsonrpc: "2.0", id: 1, method: "initialize" }))
    const body = (await res.json()) as {
      result: { serverInfo: { name: string }; protocolVersion: string }
    }
    expect(body.result.serverInfo.name).toBe("nifra-docs")
    expect(body.result.protocolVersion).toBeTruthy()
  })

  test("tools/list returns the project-independent tools with schemas", async () => {
    const res = await handleMcpHttp(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }))
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string; inputSchema: unknown }> }
    }
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      "nifra_docs",
      "nifra_example",
      "nifra_gallery",
      "nifra_learn",
      "nifra_types",
    ])
    expect(body.result.tools[0]?.inputSchema).toBeDefined()
  })

  test("tools/call nifra_example returns verified snippet content", async () => {
    const res = await handleMcpHttp(
      post({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "nifra_example", arguments: { query: "typed client" } },
      }),
    )
    const body = (await res.json()) as {
      result: { content: Array<{ type: string; text: string }> }
    }
    expect(body.result.content[0]?.type).toBe("text")
    expect(body.result.content[0]?.text).toContain("@nifrajs/") // a real, framework-importing snippet
  })

  test("nifra_gallery returns structuredContent + serves its ui:// widget resource", async () => {
    const call = await handleMcpHttp(
      post({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "nifra_gallery", arguments: {} },
      }),
    )
    const callBody = (await call.json()) as {
      result: {
        structuredContent?: { examples: unknown[] }
        _meta?: { ui?: { resourceUri?: string } }
      }
    }
    expect(callBody.result.structuredContent?.examples.length).toBeGreaterThan(0)
    // The tool must link its widget so MCP Apps hosts know which resource renders it.
    expect(callBody.result._meta?.ui?.resourceUri).toBe("ui://nifra/examples")

    // ...and that resource must be readable, or the host has nothing to render.
    const read = await handleMcpHttp(
      post({
        jsonrpc: "2.0",
        id: 6,
        method: "resources/read",
        params: { uri: "ui://nifra/examples" },
      }),
    )
    const readBody = (await read.json()) as {
      result: { contents: Array<{ mimeType: string; text: string }> }
    }
    expect(readBody.result.contents[0]?.mimeType).toBe("text/html;profile=mcp-app")
    expect(readBody.result.contents[0]?.text).toContain("nifra examples")
  })

  test("a malformed body → JSON-RPC parse error, not a crash", async () => {
    const res = await handleMcpHttp(
      new Request("http://x/mcp", { method: "POST", body: "{not json" }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32700)
  })

  test("an oversized body is rejected before JSON-RPC dispatch", async () => {
    const res = await respondMcpHttp(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: "a".repeat(128) }),
      }),
      publicDocsTools(),
      { maxBodyBytes: 64 },
    )
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain("payload too large")
  })

  test("a misleading small Content-Length still hits the streaming body cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"x":"'))
        controller.enqueue(new TextEncoder().encode("a".repeat(128)))
        controller.enqueue(new TextEncoder().encode('"}'))
        controller.close()
      },
    })
    const res = await respondMcpHttp(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "8" },
        body: stream,
        // Node's Request requires this when constructing a streamed request body.
        duplex: "half",
      } as RequestInit),
      publicDocsTools(),
      { maxBodyBytes: 64 },
    )
    expect(res.status).toBe(413)
  })

  test("an unknown tool → in-band JSON-RPC error", async () => {
    const res = await handleMcpHttp(
      post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } }),
    )
    const body = (await res.json()) as { error?: { message: string } }
    expect(body.error?.message).toContain("unknown tool")
  })
})

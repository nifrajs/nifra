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
    ).toEqual(["nifra_docs", "nifra_example", "nifra_types"])
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

  test("tools/list returns the two tools with schemas", async () => {
    const res = await handleMcpHttp(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }))
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string; inputSchema: unknown }> }
    }
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      "nifra_docs",
      "nifra_example",
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

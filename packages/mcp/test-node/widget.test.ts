/**
 * A widget bundled ahead of time is served on Node with no `Bun.build`: the body ships as a file, and
 * `defineMcpWidget` from the built package wraps it with the document shell and the bridge.
 */

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { createMcpServer, defineMcpWidget, UI_MIME } from "@nifrajs/mcp"

test("a prebuilt widget body is served over resources/read", async () => {
  const body = await readFile(join(import.meta.dirname, "fixtures/widget-body.html"), "utf8")
  const widget = defineMcpWidget({ uri: "ui://fixture/prebuilt", name: "Prebuilt", html: body })
  const server = createMcpServer({ name: "widget-node", version: "0.0.0", widgets: [widget] })
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { uri: "ui://fixture/prebuilt" },
  })
  assert.ok(response !== null && "result" in response)
  const [content] = response.result.contents
  assert.equal(content.mimeType, UI_MIME)
  assert.ok(content.text.includes(body.trim()))
  assert.ok(content.text.includes("window.mcpApp"))
})

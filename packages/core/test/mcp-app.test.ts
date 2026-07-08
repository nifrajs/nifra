import { describe, expect, test } from "bun:test"
import { server } from "../src/index.ts"

describe("Server.resource() / .prompt()", () => {
  test("resource() registers a readable MCP resource with its metadata", async () => {
    const app = server().resource(
      "app://config",
      { name: "config", description: "App config", mimeType: "application/json" },
      () => JSON.stringify({ version: 1 }),
    )
    const resources = app.mcpResources()
    expect(resources).toHaveLength(1)
    expect(resources[0]).toMatchObject({
      uri: "app://config",
      name: "config",
      description: "App config",
      mimeType: "application/json",
    })
    expect(await resources[0]?.read()).toBe(JSON.stringify({ version: 1 }))
  })

  test("a resource read may return text + mimeType, and can capture app state", async () => {
    let hits = 0
    const app = server().resource("app://doc", { name: "doc" }, () => {
      hits += 1
      return { text: `read #${hits}`, mimeType: "text/plain" }
    })
    expect(await app.mcpResources()[0]?.read()).toEqual({ text: "read #1", mimeType: "text/plain" })
    expect(await app.mcpResources()[0]?.read()).toEqual({ text: "read #2", mimeType: "text/plain" })
  })

  test("prompt() registers a prompt whose handler renders messages from its arguments", async () => {
    const app = server().prompt(
      "greet",
      { description: "Greet someone", arguments: [{ name: "who", required: true }] },
      (args) => [{ role: "user", content: { type: "text", text: `Hello ${args.who}` } }],
    )
    const prompts = app.mcpPrompts()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      name: "greet",
      description: "Greet someone",
      arguments: [{ name: "who", required: true }],
    })
    expect(await prompts[0]?.handler({ who: "Ada" })).toEqual([
      { role: "user", content: { type: "text", text: "Hello Ada" } },
    ])
  })

  test("a fresh server declares no resources or prompts", () => {
    const app = server()
    expect(app.mcpResources()).toEqual([])
    expect(app.mcpPrompts()).toEqual([])
  })
})

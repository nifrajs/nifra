import { describe, expect, test } from "bun:test"
import type { StandardSchemaV1 } from "../src/index.ts"
import { server } from "../src/index.ts"
import { mcp } from "../src/mcp.ts"

interface WeatherInput {
  location: string
}

const inputSchema: StandardSchemaV1<unknown, WeatherInput> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "location" in value &&
        typeof value.location === "string"
      ) {
        return { value: value as WeatherInput }
      }
      return {
        issues: [
          {
            message: "location must be a string",
            path: ["location"],
          },
        ],
      }
    },
  },
}

const outputSchema: StandardSchemaV1 = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
}

describe("Server.tool()", () => {
  test("registers a POST route under /_nifra/tool/:name with correct schemas and metadata", () => {
    const app = server()
      .use(mcp())
      .tool(
        "get_weather",
        {
          description: "Get weather for location",
          input: inputSchema,
          output: outputSchema,
        },
        (input) => {
          return { temp: 22, condition: "Sunny", location: input.location }
        },
      )

    const routes = app.routes()
    const toolRoute = routes.find((r) => r.path === "/_nifra/tool/get_weather")
    expect(toolRoute).toBeDefined()
    expect(toolRoute?.method).toBe("POST")
    expect(toolRoute?.schema?.body).toBe(inputSchema)
    expect(toolRoute?.schema?.response).toBe(outputSchema)
    expect(toolRoute?.tool).toEqual({
      name: "get_weather",
      description: "Get weather for location",
    })
  })

  test("attaches MCP tool annotations (safety hints) to the descriptor", () => {
    const app = server()
      .use(mcp())
      .tool(
        "delete_city",
        {
          description: "Delete a city",
          input: inputSchema,
          annotations: { title: "Delete City", destructiveHint: true, idempotentHint: true },
        },
        (input) => ({ deleted: input.location }),
      )
    const toolRoute = app.routes().find((r) => r.path === "/_nifra/tool/delete_city")
    expect(toolRoute?.tool).toEqual({
      name: "delete_city",
      description: "Delete a city",
      annotations: { title: "Delete City", destructiveHint: true, idempotentHint: true },
    })
  })

  test("runs the route handler and handles body validation at the boundary", async () => {
    const app = server()
      .use(mcp())
      .tool(
        "get_weather",
        {
          description: "Get weather for location",
          input: inputSchema,
        },
        (input) => {
          return { temp: 22, condition: "Sunny", location: input.location }
        },
      )

    // 1. Successful execution
    const reqOk = new Request("http://localhost/_nifra/tool/get_weather", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: "Paris" }),
    })
    const resOk = await app.fetch(reqOk)
    expect(resOk.status).toBe(200)
    const bodyOk = await resOk.json()
    expect(bodyOk).toEqual({ temp: 22, condition: "Sunny", location: "Paris" })

    // 2. Validation failure (missing location)
    const reqFail = new Request("http://localhost/_nifra/tool/get_weather", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    const resFail = await app.fetch(reqFail)
    expect(resFail.status).toBe(422) // 422 Unprocessable Entity
  })

  test("properly forwards the request context to the handler", async () => {
    const app = server<{ API_KEY: string }>()
      .decorate("api_key", "secret-key")
      .use(mcp())
      .tool(
        "auth_test",
        {
          description: "Test context passing",
          input: inputSchema,
        },
        (input, c) => {
          return { key: c.api_key, location: input.location }
        },
      )

    const req = new Request("http://localhost/_nifra/tool/auth_test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: "Tokyo" }),
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ key: "secret-key", location: "Tokyo" })
  })
})

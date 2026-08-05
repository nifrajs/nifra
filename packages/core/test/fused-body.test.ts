import { describe, expect, test } from "bun:test"
import { server, silentLogger } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"

function schema<Output>(
  validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>,
): StandardSchemaV1<unknown, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "nifra-test",
      validate,
      types: undefined as unknown as StandardTypes<unknown, Output>,
    },
  }
}

const userBody = schema<{ name: string }>((value) =>
  typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"
    ? { value: { name: value.name } }
    : { issues: [{ message: "name must be a string" }] },
)

function jsonReq(body: unknown): Request {
  const text = JSON.stringify(body)
  return new Request("http://x/users", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(text.length) },
    body: text,
  })
}

describe("fused body lane", () => {
  test("Web and Node-direct paths share the validated result", async () => {
    const app = server()
      .use(nodeDirect())
      .post("/users", { body: userBody }, (c) => ({ created: c.body.name }))

    const web = await app.fetch(jsonReq({ name: "Ada" }))
    const node = await app.resolveNode(jsonReq({ name: "Ada" }))
    expect(await web.json()).toEqual({ created: "Ada" })
    expect(node.kind).toBe("json")
    if (node.kind !== "json") throw new Error("unreachable")
    expect(node.body).toBe(JSON.stringify({ created: "Ada" }))
  })

  test("invalid input keeps the 422 contract on both output paths", async () => {
    const app = server()
      .use(nodeDirect())
      .post("/users", { body: userBody }, () => ({ ok: true }))
    const web = await app.fetch(jsonReq({ name: 42 }))
    const node = await app.resolveNode(jsonReq({ name: 42 }))
    expect(web.status).toBe(422)
    expect(await web.json()).toMatchObject({ ok: false, error: "validation" })
    expect(node.kind).toBe("response")
    if (node.kind !== "response") throw new Error("unreachable")
    expect(node.response.status).toBe(422)
  })

  test("decorations and response controls survive the compiled continuation", async () => {
    const app = server()
      .decorate("version", "9.9")
      .post("/users", { body: userBody }, (c) => {
        c.set.status = 201
        c.set.headers["x-version"] = (c as unknown as { version: string }).version
        c.set.cookie("sid", "v")
        return { ok: true }
      })
    const res = await app.fetch(jsonReq({ name: "Ada" }))
    expect(res.status).toBe(201)
    expect(res.headers.get("x-version")).toBe("9.9")
    expect(res.headers.getSetCookie().some((cookie) => cookie.startsWith("sid=v"))).toBe(true)
  })

  test("async validators and handlers remain on the correct continuation", async () => {
    const asyncBody = schema<{ name: string }>(async (value) => {
      await Promise.resolve()
      return userBody["~standard"].validate(value)
    })
    const app = server().post("/users", { body: asyncBody }, async (c) => {
      await Promise.resolve()
      return { name: c.body.name }
    })
    expect(await (await app.fetch(jsonReq({ name: "Ada" }))).json()).toEqual({ name: "Ada" })
    expect((await app.fetch(jsonReq({ name: 42 }))).status).toBe(422)
  })

  test("thrown Responses stay control flow and thrown Errors stay flat 500s", async () => {
    const app = server({ logger: silentLogger })
      .post("/redirect", { body: userBody }, () => {
        throw new Response(null, { status: 302, headers: { location: "/login" } })
      })
      .post("/error", { body: userBody }, () => {
        throw new Error("secret detail")
      })
    const validBody = JSON.stringify({ name: "Ada" })
    const init = {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(validBody.length) },
      body: validBody,
    }
    const redirect = await app.fetch(new Request("http://x/redirect", init))
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get("location")).toBe("/login")
    const error = await app.fetch(new Request("http://x/error", init))
    expect(error.status).toBe(500)
    expect(await error.text()).not.toContain("secret detail")
  })

  test("merge rebinds the compiled body runner with validation intact", async () => {
    const feature = server().post("/users", { body: userBody }, (c) => ({ name: c.body.name }))
    const app = server().merge(feature)
    expect(await (await app.fetch(jsonReq({ name: "Ada" }))).json()).toEqual({ name: "Ada" })
    expect((await app.fetch(jsonReq({ name: 42 }))).status).toBe(422)
  })

  test("validation recovery still selects the generic lane", async () => {
    const app = server().post(
      "/users",
      { body: userBody, onValidationError: () => ({ name: "fallback" }) },
      (c) => ({ name: c.body.name }),
    )
    expect(await (await app.fetch(jsonReq({ name: 42 }))).json()).toEqual({ name: "fallback" })
  })

  test("urlencoded forms use the same compiled validator and handler", async () => {
    const formBody = schema<{ name: string }>((value) => userBody["~standard"].validate(value))
    const app = server().post("/users", { body: formBody }, (c) => ({ name: c.body.name }))
    const res = await app.fetch(
      new Request("http://x/users", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "name=Ada",
      }),
    )
    expect(await res.json()).toEqual({ name: "Ada" })
  })
})

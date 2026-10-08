import { describe, expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { authenticated, rejected, server } from "../src/index.ts"
import type { StandardSchemaV1 } from "../src/schema/standard.ts"

// One request-scoped frame from authentication through validation and the handler: `around` opens it,
// `authenticate` resolves the caller once into it and types `c.principal`. No separate frame hook.

interface User {
  readonly id: string
}

interface Frame {
  principal?: User
}

const frames = new AsyncLocalStorage<Frame>()

function scenario() {
  const seenInValidation: (string | null)[] = []
  let opened = 0
  let closed = 0
  const note: StandardSchemaV1<unknown, { text: string }> = {
    "~standard": {
      version: 1,
      vendor: "around-authenticate",
      validate: (value: unknown) => {
        seenInValidation.push(frames.getStore()?.principal?.id ?? null)
        return typeof value === "object" &&
          value !== null &&
          "text" in value &&
          typeof value.text === "string"
          ? { value: { text: value.text } }
          : { issues: [{ message: "text is required" }] }
      },
    },
  }
  const app = server()
    .get("/outside", () => ({ framed: frames.getStore() !== undefined }))
    .group("/api", (api) =>
      api
        .around(async (_c, next) => {
          opened++
          try {
            return await frames.run({}, next)
          } finally {
            closed++
          }
        })
        .authenticate({
          id: "session",
          run: (input) => {
            if (input.headers.get("authorization") !== "Bearer ada") return rejected()
            const user: User = { id: "ada" }
            const frame = frames.getStore()
            if (frame !== undefined) frame.principal = user
            return authenticated(user)
          },
        })
        .post("/notes", { body: note }, (c) => {
          const id: string = c.principal.id
          return { id, framed: frames.getStore()?.principal?.id ?? null, text: c.body.text }
        })
        .get("/teapot", () => {
          throw new Response("short and stout", { status: 418 })
        }),
    )
  return { app, seenInValidation, counts: () => ({ opened, closed }) }
}

const post = (body: unknown) =>
  new Request("http://x/api/notes", {
    method: "POST",
    headers: { authorization: "Bearer ada", "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("around + authenticate", () => {
  test("the frame is open, holding the one resolved principal, during validation and the handler", async () => {
    const { app, seenInValidation, counts } = scenario()
    const res = await app.fetch(post({ text: "hi" }))
    expect(await res.json()).toEqual({ id: "ada", framed: "ada", text: "hi" })
    expect(seenInValidation).toEqual(["ada"])
    expect(counts()).toEqual({ opened: 1, closed: 1 })
  })

  test("an invalid body and a refused caller still close the frame", async () => {
    const { app, counts } = scenario()
    expect((await app.fetch(post({ nope: 1 }))).status).toBe(422)
    expect(
      (await app.fetch(new Request("http://x/api/notes", { method: "POST", body: "{}" }))).status,
    ).toBe(401)
    expect(counts()).toEqual({ opened: 2, closed: 2 })
  })

  test("a Response thrown inside the frame is the answer, and the frame closes", async () => {
    const { app, counts } = scenario()
    const res = await app.fetch(
      new Request("http://x/api/teapot", { headers: { authorization: "Bearer ada" } }),
    )
    expect(res.status).toBe(418)
    expect(await res.text()).toBe("short and stout")
    expect(counts()).toEqual({ opened: 1, closed: 1 })
    expect(frames.getStore()).toBeUndefined()
  })

  test("the frame stays inside its group", async () => {
    const { app, counts } = scenario()
    expect(await (await app.fetch(new Request("http://x/outside"))).json()).toEqual({
      framed: false,
    })
    expect(counts()).toEqual({ opened: 0, closed: 0 })
  })
})

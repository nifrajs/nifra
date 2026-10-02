import { describe, expect, test } from "bun:test"
import type { StandardSchemaV1 } from "@nifrajs/core/server"
import { status } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"
import * as z from "zod"
import { defer } from "../src/deferred.ts"
import {
  buildManifest,
  createWebApp,
  notFound,
  type RenderAdapter,
  type RouteModule,
  redirect,
  revalidate,
} from "../src/index.ts"
import {
  type ChannelContract,
  guardValue,
  isSensitiveFieldName,
  OutputGuardError,
  outputGuard,
} from "../src/internal/output-guard.ts"
import { mergeRouteHalves } from "../src/manifest.ts"
import { DATA_HEADER } from "../src/router.ts"

// Every value a loader, action, boundary loader or server function sends toward the browser passes
// its declared output schema: undeclared keys are dropped, a wrong-typed declared field fails with
// its path and never its value.

const contract = (schema: unknown, extra: Partial<ChannelContract> = {}): ChannelContract => ({
  label: 'the loader of "page.tsx"',
  guard:
    schema === undefined ? undefined : outputGuard(schema, '"page.backend.ts"', "loaderOutput"),
  missing: "export const loaderOutput",
  ...extra,
})

const guard = (schema: unknown, value: unknown): unknown => guardValue(contract(schema), value)

/** A schema that projects by `jsonSchema` and accepts whatever the projection leaves. */
const projectingBy = (jsonSchema: object) => ({
  "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
  jsonSchema,
})

/** The guard's failure, sync or async. */
async function refusal(run: () => unknown): Promise<OutputGuardError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(OutputGuardError)
    return error as OutputGuardError
  }
  throw new Error("the guard passed")
}

describe("projection drops what the schema does not declare", () => {
  test("at every depth, through arrays, records and optional fields", () => {
    const schema = t.object({
      user: t.object({ name: t.string(), nickname: t.optional(t.string()) }),
      posts: t.array(t.object({ title: t.string() })),
      tags: t.record(t.object({ count: t.integer() })),
    })
    expect(
      guard(schema, {
        user: { name: "Ada", passwordHash: "x", email: "ada@example.com" },
        posts: [{ title: "a", draftNotes: "x" }, { title: "b" }],
        tags: { db: { count: 2, internal: true } },
        sessionSecret: "x",
      }),
    ).toEqual({
      user: { name: "Ada" },
      posts: [{ title: "a" }, { title: "b" }],
      tags: { db: { count: 2 } },
    })
  })

  test("a strict t.object drops extra keys instead of failing on them", () => {
    expect(guard(t.object({ id: t.string() }), { id: "1", extra: 1 })).toEqual({ id: "1" })
  })

  test("an object that holds only declared keys is passed through as it is", () => {
    const value = { user: { name: "Ada" }, list: [{ id: 1 }] }
    const out = guard(
      t.object({
        user: t.object({ name: t.string() }),
        list: t.array(t.object({ id: t.number() })),
      }),
      value,
    )
    expect(out).toBe(value)
  })

  test("an explicitly open object keeps its extra keys", () => {
    expect(guard(t.looseObject({ id: t.string() }), { id: "1", extra: 1 })).toEqual({
      id: "1",
      extra: 1,
    })
  })

  test("a raw TypeBox object with no additionalProperties is closed", () => {
    const schema = projectingBy({ type: "object", properties: { a: { type: "string" } } })
    expect(guard(schema, { a: "x", b: "y" })).toEqual({ a: "x" })
  })

  test("a union keeps only keys some branch declares", () => {
    const schema = t.union([
      t.object({ kind: t.literal("user"), name: t.string() }),
      t.object({ kind: t.literal("team"), members: t.integer() }),
    ])
    expect(guard(schema, { kind: "user", name: "Ada", token: "x" })).toEqual({
      kind: "user",
      name: "Ada",
    })
  })

  test("a class instance becomes a plain object of its declared fields", () => {
    class User {
      constructor(
        readonly name: string,
        readonly passwordHash: string,
      ) {}
      toJSON() {
        return { name: this.name, passwordHash: this.passwordHash }
      }
    }
    const out = guard(t.object({ name: t.string() }), new User("Ada", "x"))
    expect(out).toEqual({ name: "Ada" })
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })

  test("a recursive schema projects every level", () => {
    const schema = projectingBy({
      $id: "Node",
      type: "object",
      properties: {
        name: { type: "string" },
        children: { type: "array", items: { $ref: "Node" } },
      },
    })
    const tree = { name: "a", secretNote: 1, children: [{ name: "b", children: [], x: 1 }] }
    expect(guard(schema, tree)).toEqual({ name: "a", children: [{ name: "b", children: [] }] })
  })

  test("an own __proto__ key stays data, never a prototype", () => {
    const value = JSON.parse('{"__proto__": {"polluted": true}, "drop": 1}') as object
    const out = guard(t.looseObject({}), value) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  test("a key inherited from a polluted prototype never becomes data", () => {
    const schema = t.object({ name: t.string(), isAdmin: t.optional(t.boolean()) })
    Object.defineProperty(Object.prototype, "isAdmin", {
      value: true,
      enumerable: true,
      configurable: true,
      writable: true,
    })
    try {
      const out = guard(schema, { name: "Ada", drop: 1 })
      expect(Object.hasOwn(out as object, "isAdmin")).toBe(false)
    } finally {
      delete (Object.prototype as { isAdmin?: unknown }).isAdmin
    }
  })

  test("a Standard JSON Schema projects like a nifra schema", () => {
    // zod's own validate would REJECT the extra key on a strict object; projection drops it first.
    const zod = z.strictObject({ id: z.string() })
    expect(guard(zod, { id: "1", secretField: "x" })).toEqual({ id: "1" })
    // And `.passthrough()` declares the object open, so its JSON Schema keeps extra keys.
    expect(guard(z.object({ id: z.string() }).passthrough(), { id: "1", more: 2 })).toEqual({
      id: "1",
      more: 2,
    })
  })

  test("a schema with no JSON Schema keeps its own validate output", () => {
    const stripping: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => ({ value: { id: (value as { id: string }).id } }),
      },
    }
    expect(guard(stripping, { id: "1", extra: 2 })).toEqual({ id: "1" })
  })
})

describe("a declared field of the wrong shape fails", () => {
  test("naming every failing path and never a value", async () => {
    const schema = t.object({
      user: t.object({ age: t.integer() }),
      items: t.array(t.object({ id: t.string() })),
    })
    const error = await refusal(() =>
      guard(schema, { user: { age: "s3cr3t-value" }, items: [{ id: 7 }] }),
    )
    expect(error.paths).toEqual(["/user/age", "/items/0/id"])
    expect(error.message).toContain('the loader of "page.tsx" does not match its output schema')
    expect(error.message).not.toContain("s3cr3t-value")
  })

  test("an async validator's failure rejects", async () => {
    const asyncFail: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async () => ({ issues: [{ message: "no", path: ["a"] }] }),
      },
    }
    expect((await refusal(() => guard(asyncFail, { a: 1 }))).paths).toEqual(["/a"])
  })
})

describe("what passes without a schema, and what never does", () => {
  test("nothing, a redirect and an error status pass; data needs a schema", async () => {
    const none = contract(undefined)
    expect(guardValue(none, undefined)).toBeUndefined()
    expect(guardValue(none, null)).toBeNull()
    const to = redirect("/login")
    expect(guardValue(none, to)).toBe(to)
    const gone = new Response(null, { status: 410 })
    expect(guardValue(none, gone)).toBe(gone)
    const missing = await refusal(() => guardValue(none, { id: 1 }))
    expect(missing.message).toContain("returned data, but declares no output schema")
  })

  test("a status signal passes", () => {
    let signal: unknown
    try {
      notFound()
    } catch (thrown) {
      signal = thrown
    }
    expect(guardValue(contract(undefined), signal)).toBe(signal)
  })

  test("a 2xx Response is refused: its body would bypass the schema", async () => {
    const schema = t.object({ id: t.string() })
    const json = await refusal(() => guard(schema, Response.json({ id: "1", secret: "x" })))
    expect(json.message).toContain("returned a 200 Response")
    const result = await refusal(() => guard(schema, status(201, { id: "1" })))
    expect(result.message).toContain("returned a 201 Response")
  })

  test("an action's revalidate() wrapper is opened and its data guarded", async () => {
    const action = contract(t.object({ saved: t.boolean() }), { revalidate: true })
    expect(guardValue(action, revalidate(["/"], { saved: true, token: "x" }))).toEqual({
      __nifraRevalidate: ["/"],
      data: { saved: true },
    })
  })
})

describe("deferred values", () => {
  test("t.deferred projects and validates the resolved value before it streams", async () => {
    const schema = t.object({
      user: t.string(),
      feed: t.deferred(t.array(t.object({ title: t.string() }))),
    })
    const out = guard(schema, {
      user: "ada",
      feed: defer(Promise.resolve([{ title: "a", authorEmail: "x" }])),
    }) as { feed: { __nifra_deferred: true; promise: Promise<unknown> } }
    expect(out.feed.__nifra_deferred).toBe(true)
    expect(await out.feed.promise).toEqual([{ title: "a" }])
  })

  test("a deferred value that resolves to the wrong shape rejects with its path", async () => {
    const schema = t.object({ count: t.deferred(t.integer()) })
    const out = guard(schema, { count: defer(Promise.resolve("many")) }) as {
      count: { promise: Promise<unknown> }
    }
    const error = await refusal(() => out.count.promise)
    expect(error.message).toContain("deferred value /count")
    expect(error.message).not.toContain("many")
  })

  test("a deferred value the schema does not declare as one is refused", async () => {
    const error = await refusal(() =>
      guard(t.looseObject({}), { feed: defer(Promise.resolve([1])) }),
    )
    expect(error.paths).toEqual(["/feed"])
    expect(error.message).toContain("Declare it with t.deferred(schema)")
    const opaque: StandardSchemaV1 = {
      "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
    }
    expect((await refusal(() => guard(opaque, { a: [defer(Promise.resolve(1))] }))).paths).toEqual([
      "/a/0",
    ])
  })
})

describe("sensitive field names", () => {
  test("an output schema declaring one fails at route load, not per request", () => {
    expect(() =>
      outputGuard(
        t.object({
          user: t.object({ name: t.string(), passwordHash: t.string() }),
          apiKey: t.string(),
        }),
        '"page.backend.ts"',
        "loaderOutput",
      ),
    ).toThrow(
      "declares sensitive field(s) /user/passwordHash, /apiKey in loaderOutput. Remove them, or mark a field that must reach the browser with t.declassified",
    )
  })

  test("t.declassified lets one through, with its reason", () => {
    const schema = t.object({
      csrf: t.string(),
      uploadToken: t.declassified("a signed one-time upload URL token", t.string()),
    })
    expect(guard(schema, { csrf: "a", uploadToken: "b" })).toEqual({ csrf: "a", uploadToken: "b" })
    expect(() => t.declassified(" ", t.string())).toThrow("give the reason")
  })

  test("the name list", () => {
    for (const name of [
      "password",
      "password_hash",
      "clientSecret",
      "API_KEY",
      "accessToken",
      "token",
      "ssn",
    ]) {
      expect(isSensitiveFieldName(name)).toBe(true)
    }
    for (const name of ["csrfToken", "name", "tokens_used", "secretary", "hashtag"]) {
      expect(isSensitiveFieldName(name)).toBe(false)
    }
  })
})

describe("a route's backend half", () => {
  const front = { default: null } as unknown as RouteModule

  test("an output schema with nothing to describe is refused", () => {
    expect(() =>
      mergeRouteHalves("page.tsx", front, "page.backend.ts", {
        loaderOutput: t.object({}),
      }),
    ).toThrow('"page.backend.ts" exports loaderOutput but no loader for it to describe')
  })

  test("an output that is not a Standard Schema is refused", () => {
    expect(() =>
      mergeRouteHalves("page.tsx", front, "page.backend.ts", {
        loader: () => ({}),
        loaderOutput: { id: "string" },
      }),
    ).toThrow('"page.backend.ts" exports loaderOutput that is not a Standard Schema')
  })

  // Serves `data` and the rendered props as JSON, so a test reads back what reached the component.
  const adapter: RenderAdapter = {
    renderToStream: (_chain, props) =>
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`<main>${JSON.stringify(props.data)}</main>`))
          c.close()
        },
      }),
    hydrationHead: () => "",
  }
  const appOf = (backend: Record<string, unknown>) =>
    createWebApp({
      adapter,
      clientEntry: "/c.js",
      manifest: buildManifest(
        ["_error.tsx", "page.tsx", "page.backend.ts"],
        (file) => async () =>
          (file === "page.backend.ts" ? backend : { default: file }) as unknown as RouteModule,
      ),
    })

  test("the component and the data request see the same projected value", async () => {
    const app = appOf({
      loader: () => ({ name: "Ada", passwordHash: "never-sent" }),
      loaderOutput: t.object({ name: t.string() }),
    })
    const page = await (await app.fetch(new Request("http://x/page"))).text()
    expect(page).toContain('<main>{"name":"Ada"}</main>')
    expect(page).not.toContain("never-sent")
    const data = await app.fetch(new Request("http://x/page", { headers: { [DATA_HEADER]: "1" } }))
    expect(await data.text()).not.toContain("never-sent")
  })

  test("a loader returning data without a schema fails the request", async () => {
    const app = appOf({ loader: () => ({ name: "Ada" }) })
    const res = await app.fetch(new Request("http://x/page"))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('"name":"Ada"')
  })

  test("a loader that only redirects needs no schema", async () => {
    const app = appOf({ loader: () => redirect("/elsewhere") })
    const res = await app.fetch(new Request("http://x/page"))
    expect(res.status).toBe(303)
  })

  test("an action's data is projected before it is answered", async () => {
    const app = appOf({
      action: () => ({ saved: true, internalId: 42 }),
      actionOutput: t.object({ saved: t.boolean() }),
    })
    const res = await app.fetch(
      new Request("http://x/page", { method: "POST", headers: { [DATA_HEADER]: "1" } }),
    )
    expect(await res.json()).toEqual({ saved: true })
  })
})

import { describe, expect, test } from "bun:test"
import {
  NAMESPACED_KEYS,
  RESERVED_EXACT_KEYS,
  RESERVED_VERB_KEYS,
} from "../../client/src/reserved.ts"
import { clientCall, tsTypeOf, typedClientKey } from "../src/internal/client-call.ts"

// The token-efficiency contract: JSON Schema in, compact TS-shaped contract out - faithful, and a
// fraction of the raw schema's tokens (the MCP nifra_context payload is built from these).

describe("tsTypeOf", () => {
  test("object with optionals", () => {
    expect(
      tsTypeOf({
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" }, age: { type: "number" } },
        required: ["id"],
      }),
    ).toBe("{ id: string, name?: string, age?: number }")
  })

  test("arrays, nested objects, integer → number", () => {
    expect(
      tsTypeOf({
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
          profile: {
            type: "object",
            properties: { score: { type: "integer" } },
            required: ["score"],
          },
        },
        required: ["tags", "profile"],
      }),
    ).toBe("{ tags: string[], profile: { score: number } }")
  })

  test("unions, enums, consts, union arrays parenthesized", () => {
    expect(tsTypeOf({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe("string | null")
    expect(tsTypeOf({ enum: ["a", "b"] })).toBe('"a" | "b"')
    expect(tsTypeOf({ const: 42 })).toBe("42")
    expect(
      tsTypeOf({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }),
    ).toBe("(string | number)[]")
  })

  test("record shapes and empty objects", () => {
    expect(tsTypeOf({ type: "object" })).toBe("{}")
    expect(tsTypeOf({ type: "object", additionalProperties: true })).toBe("Record<string, unknown>")
    expect(tsTypeOf({ type: "object", additionalProperties: { type: "number" } })).toBe(
      "Record<string, number>",
    )
  })

  test("unmodeled shapes fall back to raw JSON (faithful, never lossy)", () => {
    expect(tsTypeOf({ type: "weird-custom" })).toBe('{"type":"weird-custom"}')
  })

  test("compactness: dramatically smaller than the raw schema", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id", "name"],
    }
    const compact = tsTypeOf(schema)
    expect(compact.length).toBeLessThan(JSON.stringify(schema).length * 0.45)
  })
})

// The call signature must match @nifrajs/client's proxy convention exactly - it's what an agent copies
// instead of reading client.test.ts (user feedback 2026-06).
describe("clientCall - typed-client call form per route", () => {
  test("static path + verb (no schema)", () => {
    expect(clientCall("GET", "/users", undefined)).toBe("await api.users.get()")
  })

  test("root path uses .index", () => {
    expect(clientCall("GET", "/", undefined)).toBe("await api.index.get()")
  })

  test("path param becomes a call that appends the value", () => {
    expect(clientCall("GET", "/users/:id", undefined)).toBe("await api.users({ id }).get()")
  })

  test("a constrained param is called by its bare name", () => {
    expect(clientCall("GET", "/users/:id{[0-9]+}", undefined)).toBe("await api.users({ id }).get()")
    expect(clientCall("GET", "/img/:kind{thumb|full}/meta", undefined)).toBe(
      "await api.img({ kind }).meta.get()",
    )
    expect(clientCall("GET", "/c/:code{[A-Z]{2}}", undefined)).toBe("await api.c({ code }).get()")
  })

  test("a segment that is part literal, part parameter is a call with the segment text", () => {
    // `#{` stands for the placeholder opener, so the expected calls read as they print.
    const printed = (text: string): string => text.replaceAll("#{", "$" + "{")
    expect(clientCall("GET", "/files/:name.json", undefined)).toBe(
      printed("await api.files(`#{name}.json`).get()"),
    )
    expect(clientCall("GET", "/post-:id/comments", undefined)).toBe(
      printed("await api(`post-#{id}`).comments.get()"),
    )
    expect(clientCall("GET", "/v:major.:minor", undefined)).toBe(
      printed("await api(`v#{major}.#{minor}`).get()"),
    )
    expect(clientCall("GET", "/img/:id{[0-9]+}.png", undefined)).toBe(
      printed("await api.img(`#{id}.png`).get()"),
    )
    // Text that would end the template or start an expression is escaped.
    expect(clientCall("GET", "/a`b-:id", undefined)).toBe(printed("await api(`a\\`b-#{id}`).get()"))
    expect(clientCall("GET", printed("/#{x}-:id"), undefined)).toBe(
      printed("await api(`\\#{x}-#{id}`).get()"),
    )
    // A colon that is literal text is a static segment.
    expect(clientCall("GET", "/things:batchGet", undefined)).toBe(
      'await api["things:batchGet"].get()',
    )
  })

  test("a wildcard is called by its name, and an unnamed one by `*`", () => {
    expect(clientCall("GET", "/docs/*rest", undefined)).toBe("await api.docs({ rest }).get()")
    expect(clientCall("GET", "/assets/*", undefined)).toBe('await api.assets({ "*": rest }).get()')
  })

  test("nested static segments chain as properties", () => {
    expect(clientCall("POST", "/v1/session", { body: { type: "object" } })).toBe(
      "await api.v1.session.post(body)",
    )
  })

  test("non-body verb puts query in the first (call-options) slot", () => {
    expect(clientCall("GET", "/search", { query: { type: "object" } })).toBe(
      "await api.search.get({ query })",
    )
  })

  test("body verb with body AND query: body first, then call-options", () => {
    expect(clientCall("PUT", "/users/:id", { body: {}, query: {} })).toBe(
      "await api.users({ id }).put(body, { query })",
    )
  })

  test("body verb with query but no body still fills the body slot", () => {
    expect(clientCall("POST", "/items", { query: {} })).toBe(
      "await api.items.post(undefined, { query })",
    )
  })

  test("non-identifier segment uses bracket access", () => {
    expect(clientCall("GET", "/well-known/info", undefined)).toBe(
      'await api["well-known"].info.get()',
    )
  })

  test("a reserved-named segment is emitted as a call, never as a property", () => {
    // `.delete` would resolve the DELETE verb and request `/api` instead - a chain that compiles
    // nowhere and, through an untyped client, silently hits the wrong path.
    expect(clientCall("POST", "/api/delete", undefined)).toBe('await api.api("delete").post()')
    expect(clientCall("GET", "/jobs/subscribe", undefined)).toBe(
      'await api.jobs("subscribe").get()',
    )
  })

  test("a reserved-named segment is not spelled as bracket access either", () => {
    // Bracket access does not dodge the proxy: the get trap intercepts the key however it is written.
    expect(clientCall("GET", "/promise/then", undefined)).not.toContain('["then"]')
  })

  test("casing is preserved, because verbs are intercepted case-insensitively", () => {
    expect(clientCall("POST", "/api/Delete", undefined)).toBe('await api.api("Delete").post()')
  })

  test("a method the typed client has no call for is sent with fetch", () => {
    expect(clientCall("PROPFIND", "/dav/*path", undefined)).toBe(
      'await fetch(url, { method: "PROPFIND" })',
    )
    // Never a proxy chain: `.purge()` is not a verb, so it would be read as a path segment.
    expect(clientCall("PURGE", "/cache/:key", { body: {} })).not.toContain("api.")
  })
})

describe("clientCall - verbs and reserved keys agree with @nifrajs/client", () => {
  test("every reserved proxy key in a path is a call on its parent node", () => {
    const segments = [
      ...RESERVED_VERB_KEYS,
      ...RESERVED_VERB_KEYS.map((key) => key.toUpperCase()),
      ...RESERVED_EXACT_KEYS,
      ...NAMESPACED_KEYS,
    ]
    for (const segment of segments) {
      expect(clientCall("GET", `/api/${segment}`, undefined)).toBe(
        `await api.api(${JSON.stringify(segment)}).get()`,
      )
    }
  })

  test("each verb key is the terminal call for its method, and QUERY is `$query`", () => {
    for (const key of RESERVED_VERB_KEYS) expect(typedClientKey(key.toUpperCase())).toBe(key)
    expect(typedClientKey("QUERY")).toBe("$query")
    expect(typedClientKey("PURGE")).toBeUndefined()
  })

  test("QUERY takes the body first, like POST", () => {
    expect(clientCall("QUERY", "/search", { body: {}, query: {} })).toBe(
      "await api.search.$query(body, { query })",
    )
    expect(clientCall("QUERY", "/search", { query: {} })).toBe(
      "await api.search.$query(undefined, { query })",
    )
    expect(clientCall("QUERY", "/search", undefined)).toBe("await api.search.$query()")
  })

  test("DELETE keeps a declared body in the options alongside query", () => {
    expect(clientCall("DELETE", "/items", { body: {} })).toBe("await api.items.delete({ body })")
    expect(clientCall("DELETE", "/items", { body: {}, query: {} })).toBe(
      "await api.items.delete({ body, query })",
    )
    expect(clientCall("DELETE", "/items", { query: {} })).toBe("await api.items.delete({ query })")
    expect(clientCall("DELETE", "/items", undefined)).toBe("await api.items.delete()")
  })
})

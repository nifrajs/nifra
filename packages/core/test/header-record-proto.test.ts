/**
 * The response-header records behind `c.set.headers` and the portable header view are plain literal
 * objects (V8 fast-mode - a null-prototype record costs ~2% of a realistic route's throughput on
 * both V8 and JSC). That is safe ONLY under two invariants, pinned here:
 *
 * 1. assigning a STRING through the inherited `__proto__` setter is a spec-level no-op, so header
 *    writes can never mutate `Object.prototype` (values in these records are always strings or
 *    string arrays);
 * 2. the sinks that accept attacker-influenceable NAMES (the portable view's `set`/`append`) store
 *    the one name that setter would otherwise swallow via `defineProperty`, so even a header
 *    literally named `__proto__` round-trips instead of vanishing.
 */
import { expect, test } from "bun:test"
import { server, silentLogger } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"

function req(path: string): Request {
  return new Request(`http://localhost${path}`)
}

test("__proto__ through the portable header view: stored as data, never pollutes", async () => {
  const app = server({ logger: silentLogger })
    .use(nodeDirect())
    .onResponseHeaders((headers) => {
      headers.set("__proto__", "boom")
      headers.set("x-ok", "1")
    })
    .get("/", () => ({ ok: true }))

  // Native Node lane: the record sink with the defineProperty guard.
  const outcome = await app.resolveNode(req("/"))
  expect(outcome.kind).toBe("json")
  if (outcome.kind !== "json") throw new Error("unreachable")
  expect(outcome.headers?.["x-ok"]).toBe("1")
  expect(Object.hasOwn(outcome.headers ?? {}, "__proto__")).toBe(true)

  // Web walk: the response's own Headers handles the name natively.
  const viaFetch = await app.fetch(req("/"))
  expect(viaFetch.headers.get("x-ok")).toBe("1")

  expect(({} as Record<string, unknown>).boom).toBeUndefined()
  expect(Object.prototype).not.toHaveProperty("boom")
})

test("__proto__ assigned into c.set.headers cannot pollute Object.prototype", async () => {
  const app = server({ logger: silentLogger }).get("/", (c) => {
    ;(c.set.headers as Record<string, string>)["__proto__"] = "polluted"
    c.set.headers["x-after"] = "yes"
    return { ok: true }
  })
  const res = await app.fetch(req("/"))
  expect(res.status).toBe(200)
  expect(res.headers.get("x-after")).toBe("yes")
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  expect(Object.prototype).not.toHaveProperty("polluted")
})

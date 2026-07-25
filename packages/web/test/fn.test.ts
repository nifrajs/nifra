import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import * as z from "zod"
import { SERVER_FN_PREFIX, serverFn, serverFunctions } from "../src/fn.ts"

/**
 * A server function is a public POST endpoint that reads like a local call, which is exactly why the
 * cases below are the ones that matter. Each attack here was measured against a plain nifra route
 * FIRST and succeeded there - a body schema alone accepts a cross-origin urlencoded form, and
 * `c.boundedJson` alone accepts a `text/plain` body crafted to parse as JSON. Removing either guard in
 * `fn.ts` turns the matching test red.
 */

let received: unknown

const fns = {
  echo: serverFn({ input: t.object({ text: t.string({ minLength: 1 }) }) }, (input) => {
    received = input
    return { echoed: input.text }
  }),
  ping: serverFn({}, () => ({ pong: true })),
  writes: serverFn({ input: t.object({ v: t.string() }), capabilities: ["db.write"] }, () => ({
    ok: true,
  })),
  // Not a server function: mounting must ignore it rather than expose it.
  helper: (x: number): number => x + 1,
}

const app = server().use(serverFunctions("todos", fns))
const url = (name: string): string => `http://t${SERVER_FN_PREFIX}/todos/${name}`

const post = (
  name: string,
  body: string,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<Response> =>
  Promise.resolve(app.fetch(new Request(url(name), { method: "POST", headers, body })))

describe("mounting", () => {
  test("each server function becomes a POST route under its namespace", async () => {
    const res = await post("echo", JSON.stringify({ text: "hi" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ echoed: "hi" })
  })

  test("the declared input reaches the function validated", async () => {
    received = undefined
    await post("echo", JSON.stringify({ text: "parsed" }))
    expect(received).toEqual({ text: "parsed" })
  })

  test("a function with no input schema takes no argument", async () => {
    const res = await post("ping", JSON.stringify({}))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pong: true })
  })

  test("exports that are not server functions are not mounted", async () => {
    const res = await app.fetch(new Request(url("helper"), { method: "POST" }))
    expect(res.status).toBe(404)
  })

  test("capabilities reach the route, so assurance and the ledger can see them", () => {
    const route = app.routes().find((r) => r.path === `${SERVER_FN_PREFIX}/todos/writes`)
    expect(route?.capabilities).toEqual(["db.write"])
  })

  test("an export name that is not a safe path segment is refused", () => {
    // Reachable: a module can export an arbitrary string name (`export { x as "odd/name" }`), and an
    // object literal can carry one directly. Refusing at mount keeps the URL a plain identifier.
    const mount = serverFunctions("todos", { "odd/name": serverFn({}, () => ({ ok: true })) })
    expect(() => mount(server())).toThrow(/not a valid identifier/)
  })

  test("a namespace that is not a safe path segment is refused at mount", () => {
    expect(() => serverFunctions("../evil", fns)).toThrow(/namespace/)
    expect(() => serverFunctions("Has Spaces", fns)).toThrow(/namespace/)
  })
})

describe("input is never trusted", () => {
  test("input failing its schema is rejected before the function runs", async () => {
    received = undefined
    const res = await post("echo", JSON.stringify({ text: "" })) // minLength 1
    expect(res.status).toBe(422)
    expect(received).toBeUndefined()
  })

  test("an undeclared field never reaches the function, by either validator's route", async () => {
    // The mechanism differs and both are fine: a strict schema (`t.object`) rejects the request
    // outright, a stripping one (zod) removes the field. What must hold in both is that the function
    // never sees it - so this asserts the guarantee, not one validator's way of reaching it.
    received = undefined
    const strict = await post("echo", JSON.stringify({ text: "ok", isAdmin: true }))
    expect(strict.status).toBe(422)
    expect(received).toBeUndefined()

    let stripped: unknown
    const zodApp = server().use(
      serverFunctions("ns", {
        f: serverFn({ input: z.object({ text: z.string() }) }, (input) => {
          stripped = input
          return { ok: true }
        }),
      }),
    )
    const res = await zodApp.fetch(
      new Request(`http://t${SERVER_FN_PREFIX}/ns/f`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "ok", isAdmin: true }),
      }),
    )
    expect(res.status).toBe(200)
    expect(stripped).toEqual({ text: "ok" })
  })
})

/**
 * The CSRF surface. A cross-origin HTML form sends cookies, needs no preflight, and can choose only
 * three content types - none of them `application/json`. Requiring JSON is what makes the attack
 * impossible rather than unlikely, so these two are the load-bearing tests in this file.
 */
describe("cross-origin form posts cannot reach a server function", () => {
  test("a urlencoded form is refused (this succeeds against a plain schema route)", async () => {
    received = undefined
    const res = await post("echo", "text=attacker", {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://evil.test",
    })
    expect(res.status).toBe(415)
    expect(received).toBeUndefined()
  })

  test("a text/plain body crafted to parse as JSON is refused", async () => {
    // A form sends `name=value`, so the field name carries the JSON and `=` lands inside a string.
    received = undefined
    const res = await post("echo", '{"text":"attacker","x":"="}', {
      "content-type": "text/plain",
      origin: "https://evil.test",
    })
    expect(res.status).toBe(415)
    expect(received).toBeUndefined()
  })

  test("a function with NO input schema is guarded too - nothing else checks it", async () => {
    // With an input schema the framework's own body reader rejects text/plain and multipart, so the
    // JSON requirement is only load-bearing for urlencoded. With no input schema there is no body
    // reader at all, and this guard is the only thing standing between a cross-origin form and the
    // function. That asymmetry is why the check lives in the wrapper and not in the schema.
    const res = await post("ping", "anything=goes", {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://evil.test",
    })
    expect(res.status).toBe(415)
  })

  test("multipart is refused too", async () => {
    const res = await post("echo", "--x--", {
      "content-type": "multipart/form-data; boundary=x",
      origin: "https://evil.test",
    })
    expect(res.status).toBe(415)
  })
})

describe("origin", () => {
  test("a cross-origin JSON call is refused even though JSON needs a preflight", async () => {
    received = undefined
    const res = await post("echo", JSON.stringify({ text: "hi" }), {
      "content-type": "application/json",
      origin: "https://evil.test",
    })
    expect(res.status).toBe(403)
    expect(received).toBeUndefined()
  })

  test("a same-origin call is allowed", async () => {
    const res = await post("echo", JSON.stringify({ text: "hi" }), {
      "content-type": "application/json",
      origin: "http://t",
    })
    expect(res.status).toBe(200)
  })

  test("an unparseable Origin counts as cross-origin", async () => {
    const res = await post("echo", JSON.stringify({ text: "hi" }), {
      "content-type": "application/json",
      origin: "not a url",
    })
    expect(res.status).toBe(403)
  })

  test("no Origin header at all is allowed - a server-to-server caller sends none", async () => {
    const res = await post("echo", JSON.stringify({ text: "hi" }))
    expect(res.status).toBe(200)
  })
})

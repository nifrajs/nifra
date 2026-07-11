import { describe, expect, test } from "bun:test"
import { type Middleware, server, silentLogger } from "../src/index.ts"

/** Return a copy of `res` with an `x-app` header — onResponse can't mutate in place. */
function tagged(res: Response, value: string): Response {
  const headers = new Headers(res.headers)
  headers.set("x-app", value)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

describe("onResponse", () => {
  test("runs on a successful response", async () => {
    const app = server()
      .onResponse((res) => tagged(res, "ok"))
      .get("/", () => "hi")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(200)
    expect(res.headers.get("x-app")).toBe("ok")
    expect(await res.json()).toBe("hi")
  })

  test("runs on a 404", async () => {
    const app = server().onResponse((res) => tagged(res, "v"))
    const res = await app.fetch(new Request("http://x/missing"))
    expect(res.status).toBe(404)
    expect(res.headers.get("x-app")).toBe("v")
  })

  test("runs on a 500 error response", async () => {
    const app = server({ logger: silentLogger })
      .onResponse((res) => tagged(res, "v"))
      .get("/boom", () => {
        throw new Error("x")
      })
    const res = await app.fetch(new Request("http://x/boom"))
    expect(res.status).toBe(500)
    expect(res.headers.get("x-app")).toBe("v")
  })

  test("runs on an onRequest short-circuit", async () => {
    const app = server()
      .onRequest(() => new Response("blocked", { status: 403 }))
      .onResponse((res) => tagged(res, "v"))
    const res = await app.fetch(new Request("http://x/anything"))
    expect(res.status).toBe(403)
    expect(res.headers.get("x-app")).toBe("v")
  })

  test("async + sync hooks run in registration order", async () => {
    const app = server()
      .onResponse(async (res) => tagged(res, `${res.headers.get("x-app") ?? ""}1`))
      .onResponse((res) => tagged(res, `${res.headers.get("x-app") ?? ""}2`))
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("x-app")).toBe("12")
  })

  test("onResponseFinalized observes the response after every transformation", async () => {
    let observedStatus: number | undefined
    const app = server()
      .onResponse(() => new Response("changed", { status: 202 }))
      .onResponseFinalized(({ response }) => {
        observedStatus = response.status
      })
      .get("/", () => "ok")

    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(202)
    expect(observedStatus).toBe(202)
  })

  test("onResponseFinalized observers are ordered and fail-open", async () => {
    const order: string[] = []
    const app = server()
      .onResponseFinalized(async () => {
        order.push("first")
        throw new Error("observer failure")
      })
      .onResponseFinalized(() => {
        order.push("second")
      })
      .get("/", () => "ok")

    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(200)
    expect(order).toEqual(["first", "second"])
  })
})

describe("use(middleware)", () => {
  test("wires every provided hook in lifecycle order", async () => {
    const order: string[] = []
    const mw: Middleware = {
      onRequest: () => {
        order.push("onRequest")
        return undefined
      },
      beforeHandle: () => {
        order.push("beforeHandle")
        return undefined
      },
      afterHandle: (result) => {
        order.push("afterHandle")
        return result
      },
      onResponse: (res) => {
        order.push("onResponse")
        return res
      },
      onError: () => {
        order.push("onError")
        return undefined
      },
    }
    const app = server()
      .use(mw)
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(200)
    // onError is not invoked on the happy path.
    expect(order).toEqual(["onRequest", "beforeHandle", "afterHandle", "onResponse"])
  })

  test("a middleware's onError is wired (handles a thrown error)", async () => {
    const mw: Middleware = { onError: () => new Response("caught", { status: 418 }) }
    const app = server({ logger: silentLogger })
      .use(mw)
      .get("/boom", () => {
        throw new Error("x")
      })
    const res = await app.fetch(new Request("http://x/boom"))
    expect(res.status).toBe(418)
    expect(await res.text()).toBe("caught")
  })

  test("a partial middleware wires only what it provides", async () => {
    const app = server()
      .use({ onResponse: (res) => tagged(res, "partial") })
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("x-app")).toBe("partial")
  })
})

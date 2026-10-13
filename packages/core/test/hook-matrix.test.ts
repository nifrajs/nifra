import { describe, expect, test } from "bun:test"
import { t } from "../../schema/src/index.ts"
import { effectLedger } from "../src/effect-ledger.ts"
import { idempotency } from "../src/idempotency-plugin.ts"
import { authenticated, definePlugin, server } from "../src/index.ts"
import { type ReflectedHook, reflectHooks } from "../src/reflection.ts"
import { responseContract } from "../src/server/response-contract-lane.ts"
import { websocket } from "../src/ws.ts"
import { HOOK_MATRIX_REQUESTS, hookMatrixApp } from "./fixtures/hook-matrix-app.ts"

/**
 * Which hooks run where. Each row is one request to one registration site's area: the status and
 * every hook that ran, in order, then the static headers the response carried. A change to any row is
 * a change to hook scope that apps observe - update this matrix, add a changeset that names the
 * behavior change, and add a note to the next major's upgrade recipe.
 */
const MATRIX: Record<string, readonly [number, string]> = {
  "app matched": [
    200,
    "app:onRequest app:around app:derive app:beforeHandle app:onResponse merged:onResponse app:onResponseFinalized merged:onResponseFinalized app:responseHeaders merged:responseHeaders",
  ],
  "app 404": [
    404,
    "app:onRequest app:onResponse merged:onResponse app:onResponseFinalized merged:onResponseFinalized app:responseHeaders merged:responseHeaders",
  ],
  "app 405": [
    405,
    "app:onRequest app:onResponse merged:onResponse app:onResponseFinalized merged:onResponseFinalized app:responseHeaders merged:responseHeaders",
  ],
  "app invalid input": [
    422,
    "app:onRequest app:around app:onResponse merged:onResponse app:onResponseFinalized merged:onResponseFinalized app:responseHeaders merged:responseHeaders",
  ],
  "route matched": [
    200,
    "app:onRequest app:around route:around app:derive route:derive app:beforeHandle route:beforeHandle app:onResponse merged:onResponse app:onResponseFinalized merged:onResponseFinalized app:responseHeaders merged:responseHeaders",
  ],
  "group matched": [
    200,
    "app:onRequest group:onRequest app:around group:around app:derive group:derive app:beforeHandle group:beforeHandle app:onResponse group:onResponse merged:onResponse app:onResponseFinalized group:onResponseFinalized merged:onResponseFinalized app:responseHeaders group:responseHeaders merged:responseHeaders",
  ],
  "group 404": [
    404,
    "app:onRequest group:onRequest app:onResponse group:onResponse merged:onResponse app:onResponseFinalized group:onResponseFinalized merged:onResponseFinalized app:responseHeaders group:responseHeaders merged:responseHeaders",
  ],
  "group 405": [
    405,
    "app:onRequest group:onRequest app:onResponse group:onResponse merged:onResponse app:onResponseFinalized group:onResponseFinalized merged:onResponseFinalized app:responseHeaders group:responseHeaders merged:responseHeaders",
  ],
  "group invalid input": [
    422,
    "app:onRequest group:onRequest app:around group:around app:onResponse group:onResponse merged:onResponse app:onResponseFinalized group:onResponseFinalized merged:onResponseFinalized app:responseHeaders group:responseHeaders merged:responseHeaders",
  ],
  "merged matched": [
    200,
    "app:onRequest merged:onRequest merged:around merged:derive merged:beforeHandle app:onResponse merged:onResponse app:onResponseFinalized merged:onResponseFinalized app:responseHeaders merged:responseHeaders",
  ],
  "merged 404": [
    404,
    "app:onRequest app:onResponse merged:onResponse app:onResponseFinalized merged:onResponseFinalized app:responseHeaders merged:responseHeaders",
  ],
  "merged 405": [
    405,
    "app:onRequest app:onResponse merged:onResponse app:onResponseFinalized merged:onResponseFinalized app:responseHeaders merged:responseHeaders",
  ],
  "merged invalid input": [
    422,
    "app:onRequest merged:onRequest merged:around app:onResponse merged:onResponse app:onResponseFinalized merged:onResponseFinalized app:responseHeaders merged:responseHeaders",
  ],
  "mount matched": [
    200,
    "app:onRequest mount:onRequest mount:around mount:derive mount:beforeHandle mount:onResponse mount:onResponseFinalized app:onResponse merged:onResponse app:onResponseFinalized merged:onResponseFinalized app:responseHeaders merged:responseHeaders mount:responseHeaders",
  ],
  "mount 404": [
    404,
    "app:onRequest mount:onRequest mount:onResponse mount:onResponseFinalized app:onResponse merged:onResponse app:onResponseFinalized merged:onResponseFinalized app:responseHeaders merged:responseHeaders mount:responseHeaders",
  ],
  "mount 405": [
    405,
    "app:onRequest mount:onRequest mount:onResponse mount:onResponseFinalized app:onResponse merged:onResponse app:onResponseFinalized merged:onResponseFinalized app:responseHeaders merged:responseHeaders mount:responseHeaders",
  ],
  "mount invalid input": [
    422,
    "app:onRequest mount:onRequest mount:around mount:onResponse mount:onResponseFinalized app:onResponse merged:onResponse app:onResponseFinalized merged:onResponseFinalized app:responseHeaders merged:responseHeaders mount:responseHeaders",
  ],
  "outside every site 404": [
    404,
    "app:onRequest app:onResponse merged:onResponse app:onResponseFinalized merged:onResponseFinalized app:responseHeaders merged:responseHeaders",
  ],
}

async function observe(): Promise<Record<string, readonly [number, string]>> {
  const fired: string[] = []
  const app = hookMatrixApp(fired)
  const observed: Record<string, readonly [number, string]> = {}
  for (const [label, method, path] of HOOK_MATRIX_REQUESTS) {
    fired.length = 0
    const init: RequestInit =
      method === "POST"
        ? {
            method,
            body: JSON.stringify({ nope: 1 }),
            headers: { "content-type": "application/json" },
          }
        : { method }
    const response = await app.fetch(new Request(`http://matrix${path}`, init))
    await response.arrayBuffer()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const statics = ["app", "group", "merged", "mount"]
      .filter((site) => response.headers.get(`x-hook-${site}`) === "1")
      .map((site) => `${site}:responseHeaders`)
    observed[label] = [response.status, [...fired, ...statics].join(" ")]
  }
  return observed
}

const SITE_OF: Record<string, string> = {
  app: "app",
  route: "app",
  group: "group /g",
  merged: "merge #1",
  mount: "mount /m",
}

const asKeys = (observed: string): string[] =>
  observed
    .split(" ")
    .map((entry) => {
      const [site = "", kind = ""] = entry.split(":")
      return `${SITE_OF[site]}:${kind}`
    })
    .sort()

const reportKeys = (hooks: readonly ReflectedHook[]): string[] =>
  hooks.map((hook) => `${hook.site}:${hook.kind}`).sort()

describe("hook scope matrix", () => {
  test("every registration site, hook kind and request type runs exactly the pinned hooks", async () => {
    expect(await observe()).toEqual(MATRIX)
  })

  test("reflectHooks reports exactly the hooks a request runs", async () => {
    const report = reflectHooks(hookMatrixApp([]))
    expect(report.complete).toBe(true)
    const observed = await observe()
    const route = (method: string, path: string) =>
      report.routes.find((entry) => entry.method === method && entry.path === path)?.hooks ?? []
    const unmatched = (prefix: string) =>
      report.unmatched.find((entry) => entry.prefix === prefix)?.hooks ?? []
    const prefixOf = (path: string) =>
      path.startsWith("/g/") ? "/g" : path.startsWith("/m/") ? "/m" : "/"
    for (const [label, method, path] of HOOK_MATRIX_REQUESTS) {
      const hooks = observed[label]?.[1] ?? ""
      // An invalid input stops after validation, so the route's full chain is not what it runs.
      if (label.endsWith("invalid input")) continue
      const reported = label.endsWith("matched") ? route(method, path) : unmatched(prefixOf(path))
      expect([label, reportKeys(reported)]).toEqual([label, asKeys(hooks)])
    }
  })

  test("a server mounted on its own path is reported once, not followed", () => {
    const app = server()
      .onRequest(function requestLog() {})
      .get("/a", () => "a")
    app.mount({ path: "/self", app, stripPrefix: true })
    const report = reflectHooks(app)
    expect(report.routes.map((route) => `${route.method} ${route.path}`)).toEqual(["GET /a"])
    expect(
      report.unmatched.map(({ prefix, hooks }) => [prefix, hooks.map((hook) => hook.name)]),
    ).toEqual([
      ["/", ["requestLog"]],
      ["/self", ["requestLog"]],
    ])

    const a = server().get("/a", () => "a")
    const b = server().get("/b", () => "b")
    a.mount({ path: "/to-b", app: b, stripPrefix: true })
    b.mount({ path: "/to-a", app: a, stripPrefix: true })
    const cycle = reflectHooks(a)
    expect(cycle.routes.map((route) => route.path)).toEqual(["/a", "/to-b/b"])
    expect(cycle.unmatched.map((entry) => entry.prefix)).toEqual(["/", "/to-b", "/to-b/to-a"])
  })

  test("the report for an app with a group, a merge and a mount", () => {
    const report = reflectHooks(hookMatrixApp([]))
    const render = (hooks: readonly ReflectedHook[]) =>
      hooks
        .map(
          (hook) => `${hook.site} ${hook.kind}${hook.headers ? `[${hook.headers.join(",")}]` : ""}`,
        )
        .join(" | ")
    const rendered: Record<string, string> = {}
    for (const entry of report.routes)
      rendered[`${entry.method} ${entry.path}`] = render(entry.hooks)
    for (const entry of report.unmatched)
      rendered[`unmatched ${entry.prefix}`] = render(entry.hooks)
    expect(rendered).toEqual({
      "POST /app/body":
        "app onRequest | app around | app derive | app beforeHandle | app responseHeaders[x-hook-app] | app onResponse | merge #1 responseHeaders[x-hook-merged] | merge #1 onResponse | app onResponseFinalized | merge #1 onResponseFinalized",
      "GET /app/item":
        "app onRequest | app around | app derive | app beforeHandle | app responseHeaders[x-hook-app] | app onResponse | merge #1 responseHeaders[x-hook-merged] | merge #1 onResponse | app onResponseFinalized | merge #1 onResponseFinalized",
      "GET /app/late":
        "app onRequest | app around | app around | app derive | app derive | app beforeHandle | app beforeHandle | app responseHeaders[x-hook-app] | app onResponse | merge #1 responseHeaders[x-hook-merged] | merge #1 onResponse | app onResponseFinalized | merge #1 onResponseFinalized",
      "POST /g/body":
        "app onRequest | group /g onRequest | app around | group /g around | app derive | group /g derive | app beforeHandle | group /g beforeHandle | app responseHeaders[x-hook-app] | app onResponse | group /g responseHeaders[x-hook-group] | group /g onResponse | merge #1 responseHeaders[x-hook-merged] | merge #1 onResponse | app onResponseFinalized | group /g onResponseFinalized | merge #1 onResponseFinalized",
      "GET /g/item":
        "app onRequest | group /g onRequest | app around | group /g around | app derive | group /g derive | app beforeHandle | group /g beforeHandle | app responseHeaders[x-hook-app] | app onResponse | group /g responseHeaders[x-hook-group] | group /g onResponse | merge #1 responseHeaders[x-hook-merged] | merge #1 onResponse | app onResponseFinalized | group /g onResponseFinalized | merge #1 onResponseFinalized",
      "POST /m/body":
        "app onRequest | mount /m onRequest | mount /m around | mount /m derive | mount /m beforeHandle | mount /m responseHeaders[x-hook-mount] | mount /m onResponse | mount /m onResponseFinalized | app responseHeaders[x-hook-app] | app onResponse | merge #1 responseHeaders[x-hook-merged] | merge #1 onResponse | app onResponseFinalized | merge #1 onResponseFinalized",
      "GET /m/item":
        "app onRequest | mount /m onRequest | mount /m around | mount /m derive | mount /m beforeHandle | mount /m responseHeaders[x-hook-mount] | mount /m onResponse | mount /m onResponseFinalized | app responseHeaders[x-hook-app] | app onResponse | merge #1 responseHeaders[x-hook-merged] | merge #1 onResponse | app onResponseFinalized | merge #1 onResponseFinalized",
      "POST /merged/body":
        "app onRequest | merge #1 onRequest | merge #1 around | merge #1 derive | merge #1 beforeHandle | app responseHeaders[x-hook-app] | app onResponse | merge #1 responseHeaders[x-hook-merged] | merge #1 onResponse | app onResponseFinalized | merge #1 onResponseFinalized",
      "GET /merged/item":
        "app onRequest | merge #1 onRequest | merge #1 around | merge #1 derive | merge #1 beforeHandle | app responseHeaders[x-hook-app] | app onResponse | merge #1 responseHeaders[x-hook-merged] | merge #1 onResponse | app onResponseFinalized | merge #1 onResponseFinalized",
      "unmatched /":
        "app onRequest | app responseHeaders[x-hook-app] | app onResponse | merge #1 responseHeaders[x-hook-merged] | merge #1 onResponse | app onResponseFinalized | merge #1 onResponseFinalized",
      "unmatched /g":
        "app onRequest | group /g onRequest | app responseHeaders[x-hook-app] | app onResponse | group /g responseHeaders[x-hook-group] | group /g onResponse | merge #1 responseHeaders[x-hook-merged] | merge #1 onResponse | app onResponseFinalized | group /g onResponseFinalized | merge #1 onResponseFinalized",
      "unmatched /m":
        "app onRequest | mount /m onRequest | mount /m responseHeaders[x-hook-mount] | mount /m onResponse | mount /m onResponseFinalized | app responseHeaders[x-hook-app] | app onResponse | merge #1 responseHeaders[x-hook-merged] | merge #1 onResponse | app onResponseFinalized | merge #1 onResponseFinalized",
    })
  })
})

describe("reflectHooks names", () => {
  test("a hook is named by the plugin that registered it, else by its function", () => {
    const base = server()
    const audit = definePlugin("audit", (app: typeof base) => app.derive(() => ({ audited: true })))
    function requireUser() {
      return undefined
    }
    const app = base
      .use({ name: "request-log", onRequest: () => undefined })
      .use(audit)
      .use({ name: "frame", responseHeaders: { "x-frame-options": "DENY" } })
      .authenticate({ id: "session", run: () => authenticated({ id: "u1" }) })
      .beforeHandle(requireUser)
      .onResponse((response) => response)
      .get("/me", () => "me")
    const hooks = reflectHooks(app).routes[0]?.hooks ?? []
    expect(hooks.map((hook) => [hook.kind, hook.name, hook.site])).toEqual([
      ["onRequest", "request-log", "app"],
      ["authenticate", "session", "app"],
      ["derive", "audit", "app"],
      ["beforeHandle", "requireUser", "app"],
      ["responseHeaders", "frame", "app"],
      ["onResponse", "(anonymous)", "app"],
    ])
    expect(hooks.find((hook) => hook.kind === "responseHeaders")?.headers).toEqual([
      "x-frame-options",
    ])
  })

  test("hooks registered without recorded origins make the report incomplete", () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    const app = server()
    try {
      app.onRequest(() => undefined).get("/", () => "ok")
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
    }
    const report = reflectHooks(app)
    expect(report.complete).toBe(false)
    expect(report.routes[0]?.hooks).toEqual([
      { kind: "onRequest", name: "(anonymous)", site: "unknown" },
    ])
  })

  test("anything that is not a nifra server yields an empty report", () => {
    expect(reflectHooks({})).toEqual({ complete: true, routes: [], unmatched: [] })
    expect(reflectHooks(undefined)).toEqual({ complete: true, routes: [], unmatched: [] })
  })
})

describe("reflectHooks for a WebSocket route", () => {
  test("lists the hooks its handshake runs, which have no response phase", async () => {
    const fired: string[] = []
    const app = server()
      .use(websocket())
      .onRequest(function requestLog() {
        fired.push("requestLog")
      })
      .around(async function timing(_c, next) {
        fired.push("timing")
        return next()
      })
      .derive(function session() {
        fired.push("session")
        return {}
      })
      .beforeHandle(function requireUser() {
        fired.push("requireUser")
      })
      .afterHandle(function stamp(_c, response) {
        fired.push("stamp")
        return response
      })
      .onError(function report() {
        fired.push("report")
      })
      .onResponse(function finish(response) {
        fired.push("finish")
        return response
      })
      .ws("/chat", { upgrade: () => ({}) })
      .mount({
        path: "/m",
        app: server()
          .use(websocket())
          .onRequest(function childLog() {
            fired.push("childLog")
          })
          .ws("/live", { upgrade: () => ({}) }),
        stripPrefix: true,
      })
    const report = reflectHooks(app)
    const hooksOf = (path: string) =>
      (
        report.routes.find((route) => route.method === "WS" && route.path === path)?.hooks ?? []
      ).map((hook) => [hook.kind, hook.name, hook.site])
    expect(hooksOf("/chat")).toEqual([
      ["onRequest", "requestLog", "app"],
      ["derive", "session", "app"],
      ["beforeHandle", "requireUser", "app"],
      ["onError", "report", "app"],
    ])
    expect(hooksOf("/m/live")).toEqual([
      ["onRequest", "requestLog", "app"],
      ["onRequest", "childLog", "mount /m"],
    ])
    const handshake = (path: string) =>
      app.resolveWebSocketUpgrade(
        new Request(`http://x${path}`, {
          headers: {
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
        }),
      )
    expect((await handshake("/chat")).kind).toBe("upgrade")
    expect((await handshake("/m/live")).kind).toBe("upgrade")
    expect(fired).toEqual(["requestLog", "session", "requireUser", "requestLog", "childLog"])
  })
})

describe("reflectHooks lists the runtimes a route resolved at registration", () => {
  const typed = { response: t.object({ id: t.string() }) }
  const pinned = (hooks: readonly ReflectedHook[]) => hooks.filter((hook) => hook.site === "route")

  test("a merged route recompiled under the parent's contract shows it, named by mode", () => {
    const before = server().merge(server().get("/users", typed, () => ({ id: "1" })))
    const after = server()
      .use(responseContract("enforce"))
      .merge(server().get("/users", typed, () => ({ id: "1" })))
    expect(pinned(reflectHooks(before).routes[0]?.hooks ?? [])).toEqual([])
    expect(pinned(reflectHooks(after).routes[0]?.hooks ?? [])).toEqual([
      { kind: "responseContract", name: "enforce", site: "route" },
    ])
  })

  test("the ledger and idempotency show where the route runs them", () => {
    const app = server()
      .use(effectLedger({ sink() {} }))
      .use(idempotency())
      .beforeHandle(function guard() {})
      .post(
        "/pay",
        {
          capabilities: ["payments.charge"],
          idempotency: { scope: "request", namespace: "public:pay" },
        },
        () => "ok",
      )
    const kinds = (reflectHooks(app).routes[0]?.hooks ?? []).map((hook) => hook.kind)
    expect(kinds).toEqual(["effectLedger", "beforeHandle", "idempotency"])
  })
})

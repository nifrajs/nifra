/**
 * One app with hooks at every registration site, for the hook-scope matrix: the app itself, a
 * group, a merged server, a mounted server, and order-scoped hooks declared just before one route.
 * Each hook records `<site>:<kind>` when it runs; a static header records `responseHeaders`.
 */
import { server } from "../../src/index.ts"
import type { StandardSchemaV1 } from "../../src/schema/standard.ts"

export type HookSite = "app" | "route" | "group" | "merged" | "mount"

const hasName = (value: unknown): value is { name: string } =>
  typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"

const named: StandardSchemaV1<unknown, { name: string }> = {
  "~standard": {
    version: 1,
    vendor: "hook-matrix",
    validate: (value: unknown) =>
      hasName(value) ? { value } : { issues: [{ message: "name is required" }] },
  },
}

type HookTarget = ReturnType<typeof server>

export function hookMatrixApp(fired: string[]) {
  const mark = (site: HookSite, kind: string) => fired.push(`${site}:${kind}`)
  // Request and response hooks, then the order-scoped chain, in the order every site declares them.
  // Builder methods register on the instance itself, so the narrowed chain types are not needed here.
  const withHooks = (app: HookTarget, site: HookSite): HookTarget => {
    app
      .responseHeaders({ [`x-hook-${site}`]: "1" })
      .onRequest(() => void mark(site, "onRequest"))
      .onResponse((response) => {
        mark(site, "onResponse")
        return response
      })
      .onResponseFinalized(() => void mark(site, "onResponseFinalized"))
      .around((_c, next) => {
        mark(site, "around")
        return next()
      })
      .derive(() => {
        mark(site, "derive")
        return {}
      })
      .beforeHandle(() => void mark(site, "beforeHandle"))
    return app
  }
  const routes = (app: HookTarget, base: string): HookTarget => {
    app
      .get(`${base}/item`, () => ({ ok: true }))
      .post(`${base}/body`, { body: named }, (c) => c.body)
    return app
  }

  const merged = routes(withHooks(server(), "merged"), "/merged")
  const mounted = routes(withHooks(server(), "mount"), "")
  const app = routes(withHooks(server(), "app"), "/app")
    .group("/g", (g) => routes(withHooks(g, "group"), ""))
    .merge(merged)
    .mount({ path: "/m", app: mounted, stripPrefix: true })
  return app
    .around((_c, next) => {
      mark("route", "around")
      return next()
    })
    .derive(() => {
      mark("route", "derive")
      return {}
    })
    .beforeHandle(() => void mark("route", "beforeHandle"))
    .get("/app/late", () => ({ ok: true }))
}

/** One request per row of the matrix: a site's area and the kind of request sent to it. */
export const HOOK_MATRIX_REQUESTS = [
  ["app matched", "GET", "/app/item"],
  ["app 404", "GET", "/app/nope"],
  ["app 405", "DELETE", "/app/item"],
  ["app invalid input", "POST", "/app/body"],
  ["route matched", "GET", "/app/late"],
  ["group matched", "GET", "/g/item"],
  ["group 404", "GET", "/g/nope"],
  ["group 405", "DELETE", "/g/item"],
  ["group invalid input", "POST", "/g/body"],
  ["merged matched", "GET", "/merged/item"],
  ["merged 404", "GET", "/merged/nope"],
  ["merged 405", "DELETE", "/merged/item"],
  ["merged invalid input", "POST", "/merged/body"],
  ["mount matched", "GET", "/m/item"],
  ["mount 404", "GET", "/m/nope"],
  ["mount 405", "DELETE", "/m/item"],
  ["mount invalid input", "POST", "/m/body"],
  ["outside every site 404", "GET", "/nowhere"],
] as const

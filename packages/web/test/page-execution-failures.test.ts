import { describe, expect, test } from "bun:test"
import {
  buildManifest,
  createWebApp,
  type Manifest,
  type RenderAdapter,
  type RouteModule,
  rawHref,
  redirect,
} from "../src/index.ts"
import { DATA_HEADER, NAV_FROM_HEADER, RETAIN_HEADER } from "../src/router.ts"
import { isBackendHalf, splitRouteHalves } from "./_route-halves.ts"
import { streamOf } from "./streams.ts"

const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    streamOf(`<main>${JSON.stringify({ chain, layoutData: props.layoutData ?? null })}</main>`),
  hydrationHead: () => "",
}

const chainOf = (html: string): readonly string[] => {
  const match = /<main>(.*?)<\/main>/s.exec(html)
  if (match === null) throw new Error(`no render in: ${html}`)
  const rendered: { chain: readonly string[] } = JSON.parse(match[1] ?? "null")
  return rendered.chain
}

const appOf = (
  modules: Record<string, Partial<RouteModule> & { gate?: boolean }>,
  edit: (manifest: Manifest) => Manifest = (manifest) => manifest,
) => {
  const halves = splitRouteHalves(modules)
  return createWebApp({
    adapter: stub,
    manifest: edit(
      buildManifest(
        Object.keys(halves),
        (file) => () =>
          Promise.resolve(
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a backend half has no `default` by contract, which RouteModule types as required; the stub prints the file name for a frontend half.
            (isBackendHalf(file)
              ? { ...halves[file] }
              : { default: file, ...halves[file] }) as RouteModule,
          ),
      ),
    ),
    clientEntry: "/c.js",
  })
}

const get = (app: { fetch(r: Request): Response | Promise<Response> }, path: string) =>
  app.fetch(new Request(`http://x${path}`))

describe("a layout kept through a navigation", () => {
  // A hand-built manifest that lists no `layoutParams`.
  const withoutScopes = (manifest: Manifest): Manifest => ({
    ...manifest,
    routes: manifest.routes.map(({ layoutParams: _scopes, ...route }) => route),
  })
  const handBuilt = (runs: { n: number }) =>
    appOf(
      { "_layout.tsx": { loader: () => ({ run: ++runs.n }) }, "users/[id].tsx": {} },
      withoutScopes,
    )

  test("is not kept when the params changed and the manifest does not say which the layout owns", async () => {
    const runs = { n: 0 }
    const app = handBuilt(runs)
    const navigate = async (
      to: string,
      from: string,
    ): Promise<{ retained?: number[]; layoutData?: unknown[] }> => {
      const res = await app.fetch(
        new Request(`http://x${to}`, {
          headers: { [DATA_HEADER]: "1", [RETAIN_HEADER]: "0", [NAV_FROM_HEADER]: from },
        }),
      )
      return res.json()
    }
    const same = await navigate("/users/1", "/users/1")
    expect(same.retained).toEqual([0])
    expect(runs.n).toBe(0)
    const changed = await navigate("/users/2", "/users/1")
    expect(changed.retained ?? []).toEqual([])
    expect(changed.layoutData).toEqual([{ run: 1 }])
  })
})

describe("a gate that refuses the request", () => {
  test("leaves the loaders it did not wait for observed, so a late failure is not unhandled", async () => {
    const seen: unknown[] = []
    const listener = (reason: unknown) => seen.push(reason)
    process.on("unhandledRejection", listener)
    try {
      const app = appOf({
        "_layout.tsx": {
          loader: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10))
            throw new Error("outer loader failed late")
          },
        },
        "inner/_layout.tsx": {
          gate: true,
          loader: () => {
            throw redirect(rawHref("/login"))
          },
        },
        "inner/page.tsx": {},
      })
      const res = await get(app, "/inner/page")
      expect(res.status).toBe(303)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(seen).toEqual([])
    } finally {
      process.off("unhandledRejection", listener)
    }
  })
})

describe("a layout whose meta throws", () => {
  const broken = {
    "_layout.tsx": {
      meta: () => {
        throw new Error("meta blew up")
      },
    },
    "_404.tsx": {},
    "_error.tsx": {},
    "page.tsx": {},
    "boom.tsx": {
      loader: () => {
        throw new Error("page store down")
      },
    },
  }

  test("still lets an error page render, alone", async () => {
    const res = await get(appOf(broken), "/boom")
    expect(res.status).toBe(500)
    expect(chainOf(await res.text())).toEqual(["_error.tsx"])
  })

  test("still lets a status page render, alone", async () => {
    const res = await get(appOf(broken), "/nope")
    expect(res.status).toBe(404)
    expect(chainOf(await res.text())).toEqual(["_404.tsx"])
  })
})

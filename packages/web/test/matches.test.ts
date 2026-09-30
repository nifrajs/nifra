import { describe, expect, test } from "bun:test"
import {
  buildManifest,
  createClientRouter,
  createWebApp,
  type MatchChain,
  notFound,
  type RenderAdapter,
  type RenderProps,
  type RouteModule,
} from "../src/index.ts"
import { withLoading } from "../src/internal/loading-runtime.ts"
import { chainMatches } from "../src/internal/matches-runtime.ts"

// `useMatches` reports the rendered chain - each layout, then the page - with the URL prefix, params
// and data each one owns, plus its `handle` export. Every adapter computes it from `RenderProps` with
// `chainMatches`, so these tests pin the one implementation and the props both sides feed it.

const propsOf = (
  ids: readonly string[],
  path: string,
  params: Record<string, string>,
  over: Partial<RenderProps> = {},
): RenderProps => ({
  data: { page: true },
  params,
  path,
  matchChain: { ids, handles: ids.map((id) => ({ of: id })) },
  ...over,
})

describe("chainMatches", () => {
  test("no chain, no matches", () => {
    expect(chainMatches({ data: null })).toEqual([])
  })

  test("each layout wraps the URL prefix of its directory and sees only its own params", () => {
    const matches = chainMatches(
      propsOf(
        ["_layout", "orgs/[org]/_layout", "orgs/[org]/projects/[id]"],
        "/orgs/acme/projects/7?tab=files",
        { org: "acme", id: "7" },
        { layoutData: [{ user: "u" }, { org: "acme" }] },
      ),
    )
    expect(matches).toEqual([
      { id: "_layout", pathname: "/", params: {}, data: { user: "u" }, handle: { of: "_layout" } },
      {
        id: "orgs/[org]/_layout",
        pathname: "/orgs/acme",
        params: { org: "acme" },
        data: { org: "acme" },
        handle: { of: "orgs/[org]/_layout" },
      },
      {
        id: "orgs/[org]/projects/[id]",
        pathname: "/orgs/acme/projects/7",
        params: { org: "acme", id: "7" },
        data: { page: true },
        handle: { of: "orgs/[org]/projects/[id]" },
      },
    ])
  })

  test("a layout without a loader reports null data, and a missing handle is undefined", () => {
    const [layout, page] = chainMatches({
      data: 1,
      path: "/a",
      matchChain: { ids: ["_layout", "a"], handles: [] },
    })
    expect(layout).toEqual({
      id: "_layout",
      pathname: "/",
      params: {},
      data: null,
      handle: undefined,
    })
    expect(page?.handle).toBeUndefined()
  })

  test("groups and index folders add no segment; an optional one counts only when present", () => {
    const params = { lang: "en", slug: "intro" }
    const [marketing, localized, docs] = chainMatches(
      propsOf(
        ["(marketing)/_layout", "[[lang]]/_layout", "[[lang]]/docs/index/_layout", "page"],
        "/en/docs/intro",
        params,
      ),
    )
    expect(marketing?.pathname).toBe("/")
    expect(localized).toMatchObject({ pathname: "/en", params: { lang: "en" } })
    expect(docs).toMatchObject({ pathname: "/en/docs", params: { lang: "en" } })

    const [, bare, bareDocs] = chainMatches(
      propsOf(
        ["(marketing)/_layout", "[[lang]]/_layout", "[[lang]]/docs/_layout", "page"],
        "/docs/intro",
        { slug: "intro" },
      ),
    )
    expect(bare).toMatchObject({ pathname: "/", params: {} })
    expect(bareDocs).toMatchObject({ pathname: "/docs", params: {} })
  })

  test("a catch-all folder wraps the rest of the path; a part-param folder one segment", () => {
    const [files, post] = chainMatches(
      propsOf(["files/[...path]/_layout", "page"], "/files/a/b/c", { path: "a/b/c" }),
    )
    expect(files).toMatchObject({ pathname: "/files/a/b/c", params: { path: "a/b/c" } })
    expect(post?.pathname).toBe("/files/a/b/c")

    const [mixed] = chainMatches(
      propsOf(["post-[id]/_layout", "page"], "/post-7/comments", { id: "7" }),
    )
    expect(mixed).toMatchObject({ pathname: "/post-7", params: { id: "7" } })
  })

  test("a trailing slash and the query do not change a layout's prefix", () => {
    const [, org] = chainMatches(
      propsOf(["_layout", "orgs/[org]/_layout", "page"], "/orgs/acme/?x=1", { org: "acme" }),
    )
    expect(org?.pathname).toBe("/orgs/acme")
  })
})

// ── the server hands the adapter the chain it rendered ────────────────────────────────────────────

const renderMatches: RenderAdapter = {
  renderToStream: (_chain, props) =>
    new Response(`<p id="m">${JSON.stringify(chainMatches(props))}</p>`)
      .body as ReadableStream<Uint8Array>,
  hydrationHead: () => "",
}

const matchesIn = async (res: Response): Promise<unknown> => {
  const html = await res.text()
  const found = /<p id="m">(.*?)<\/p>/.exec(html)
  if (found === null) throw new Error(`no matches in ${html}`)
  return JSON.parse(found[1] as string)
}

const appOf = (modules: Record<string, RouteModule>) =>
  createWebApp({
    adapter: renderMatches,
    manifest: buildManifest(Object.keys(modules), (file) => async () => {
      const mod = modules[file]
      if (mod === undefined) throw new Error(`no module ${file}`)
      return mod
    }),
    clientEntry: "/c.js",
  })

describe("server render", () => {
  const modules: Record<string, RouteModule> = {
    "_layout.tsx": { default: "root", handle: "Home", loader: () => ({ user: "ada" }) },
    "_404.tsx": { default: "nf", handle: "Missing" },
    "admin/_layout.tsx": { default: "admin", handle: "Admin" },
    "admin/_404.tsx": { default: "admin-nf", handle: "Admin missing" },
    "admin/users/[id].tsx": {
      default: "user",
      handle: { crumb: "User" },
      loader: ({ params }) => {
        if (params.id === "0") return notFound()
        return { id: params.id }
      },
    },
  }

  test("a page reports its layouts and itself", async () => {
    const res = await appOf(modules).fetch(new Request("http://x/admin/users/7"))
    expect(await matchesIn(res)).toEqual([
      { id: "_layout", pathname: "/", params: {}, data: { user: "ada" }, handle: "Home" },
      { id: "admin/_layout", pathname: "/admin", params: {}, data: null, handle: "Admin" },
      {
        id: "admin/users/[id]",
        pathname: "/admin/users/7",
        params: { id: "7" },
        data: { id: "7" },
        handle: { crumb: "User" },
      },
    ])
  })

  test("a nested _404 reports the layouts it renders inside", async () => {
    const res = await appOf(modules).fetch(new Request("http://x/admin/users/0"))
    expect(res.status).toBe(404)
    expect(await matchesIn(res)).toEqual([
      { id: "_layout", pathname: "/", params: {}, data: { user: "ada" }, handle: "Home" },
      { id: "admin/_layout", pathname: "/admin", params: {}, data: null, handle: "Admin" },
      {
        id: "admin/_404",
        pathname: "/admin/users/0",
        params: { id: "0" },
        data: null,
        handle: "Admin missing",
      },
    ])
  })

  test("the root status page reports itself alone", async () => {
    const res = await appOf(modules).fetch(new Request("http://x/nowhere"))
    expect(res.status).toBe(404)
    expect(await matchesIn(res)).toEqual([
      { id: "_404", pathname: "/nowhere", params: {}, data: null, handle: "Missing" },
    ])
  })
})

// ── a `_loading` view reports the layouts it keeps, then the loading page ──────────────────────────

test("a loading view's match chain is the shared layouts plus the loading page", async () => {
  const chains: Record<string, readonly unknown[]> = {
    index: ["Root", "IndexPage"],
    about: ["Root", "AboutPage"],
  }
  const matchChains: Record<string, MatchChain> = {
    index: { ids: ["_layout", "index"], handles: ["Home", "Index"] },
  }
  const inner = createClientRouter({
    patterns: [
      { routeId: "index", pattern: "/" },
      { routeId: "about", pattern: "/about" },
    ],
    initial: {
      routeId: "index",
      params: {},
      path: "/",
      data: null,
      layoutData: [null],
      pending: false,
    },
    fetchData: () => new Promise(() => {}),
  })
  const router = withLoading(inner, {
    routes: { index: [["_layout"], [["_loading", 1]]], about: [["_layout"], [["_loading", 1]]] },
    modules: { _loading: async () => ({ default: "Loading", handle: "Loading…" }) },
    chains,
    searchSchemas: {},
    matchChains,
    delayMs: 1,
  })
  await router.navigate("/about")
  const view = router.snapshot().routeId
  expect(chains[view]).toEqual(["Root", "Loading"])
  expect(matchChains[view]).toEqual({ ids: ["_layout", "_loading"], handles: ["Home", "Loading…"] })
})

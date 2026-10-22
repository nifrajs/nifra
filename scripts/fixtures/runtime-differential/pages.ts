/**
 * The differential app's server-rendered pages, mounted under `/pages`. Built on
 * `@nifrajs/web-vanilla` from a hand-written manifest, so no bundler runs and the same module serves
 * on every runtime, workerd included. Like the API routes, every page is a pure function of the
 * request.
 */
import { isSameOriginPath, silentLogger } from "@nifrajs/core"
import { createWebApp, defer, type Manifest, notFound, redirect } from "@nifrajs/web"
import { html, type VanillaComponent, vanillaAdapter } from "@nifrajs/web-vanilla"

const Layout: VanillaComponent = ({ children }) =>
  html`<main class="differential">${children}</main>`

const text = (value: unknown): string => (typeof value === "string" ? value : "")

const searchOf = (request: Request, key: string): string =>
  new URL(request.url).searchParams.get(key) ?? ""

/** The fields a page reads off loader data, so a missing key renders empty rather than throwing. */
const field = (data: unknown, key: string): unknown =>
  typeof data === "object" && data !== null ? Reflect.get(data, key) : undefined

const manifest = (sentinel: string): Manifest => ({
  routes: [
    {
      id: "home",
      pattern: "/pages",
      layoutIds: ["_layout"],
      file: "home.ts",
      load: async () => ({
        default: ({ data }: { data: unknown }) =>
          html`<h1>home</h1><p class="q">${text(field(data, "q"))}</p>`,
        hydrate: false,
        meta: { title: "Home", meta: [{ name: "description", content: "differential home" }] },
        loader: (ctx) => ({ q: searchOf(ctx.request, "q") }),
      }),
    },
    {
      id: "meta",
      pattern: "/pages/meta/:slug",
      layoutIds: ["_layout"],
      file: "meta.ts",
      load: async () => ({
        default: ({ params }: { params: Record<string, string> }) =>
          html`<h1>${params.slug ?? ""}</h1>`,
        hydrate: false,
        meta: ({ params, origin }) => ({
          title: `Post ${params.slug ?? ""}`,
          meta: [{ property: "og:url", content: `${origin}/pages/meta/${params.slug ?? ""}` }],
          link: [{ rel: "canonical", href: `${origin}/pages/meta/${params.slug ?? ""}` }],
        }),
      }),
    },
    {
      id: "stream",
      pattern: "/pages/stream",
      layoutIds: ["_layout"],
      file: "stream.ts",
      load: async () => ({
        default: ({ data }: { data: unknown }) =>
          html`<h1>stream</h1><p>${text(field(data, "fast"))}</p>`,
        hydrate: false,
        loader: () => ({
          fast: "shell",
          slow: defer(Promise.resolve(["a", "b"])),
          broken: defer(Promise.reject(new Error(sentinel))),
        }),
      }),
    },
    {
      id: "throw",
      pattern: "/pages/throw",
      layoutIds: ["_layout"],
      errorIds: ["_error"],
      file: "throw.ts",
      load: async () => ({
        default: () => html`<h1>unreachable</h1>`,
        hydrate: false,
        loader: () => {
          throw new Error(sentinel)
        },
      }),
    },
    {
      id: "throwBare",
      pattern: "/pages/throw-bare",
      layoutIds: ["_layout"],
      file: "throw-bare.ts",
      load: async () => ({
        default: () => html`<h1>unreachable</h1>`,
        hydrate: false,
        loader: () => {
          throw new Error(sentinel)
        },
      }),
    },
    {
      id: "go",
      pattern: "/pages/go",
      layoutIds: ["_layout"],
      file: "go.ts",
      load: async () => ({
        default: () => html`<h1>unreachable</h1>`,
        hydrate: false,
        loader: (ctx) => {
          const to = searchOf(ctx.request, "to")
          if (!isSameOriginPath(to)) notFound()
          throw redirect(to)
        },
      }),
    },
    {
      id: "missing",
      pattern: "/pages/missing/:id",
      layoutIds: ["_layout"],
      file: "missing.ts",
      load: async () => ({
        default: ({ params }: { params: Record<string, string> }) =>
          html`<h1>found ${params.id ?? ""}</h1>`,
        hydrate: false,
        loader: (ctx) => {
          if (ctx.params.id !== "1") notFound()
          return null
        },
      }),
    },
    {
      id: "form",
      pattern: "/pages/form",
      layoutIds: ["_layout"],
      file: "form.ts",
      load: async () => ({
        default: ({ actionData }: { actionData?: unknown }) =>
          html`<form method="post"><input name="name"></form><p class="saved">${
            actionData === undefined ? "" : JSON.stringify(actionData)
          }</p>`,
        hydrate: false,
        action: async (ctx) => {
          const form = await ctx.request.formData()
          if (form.get("go") === "1") return redirect("/pages/form?saved=1")
          // Every entry as read, so a runtime parsing the body differently shows in the page.
          return [...form].map(([key, value]) =>
            typeof value === "string"
              ? [key, value]
              : [key, { file: value.name, type: value.type, size: value.size }],
          )
        },
      }),
    },
  ],
  layouts: {
    _layout: { file: "_layout.ts", load: async () => ({ default: Layout }) },
  },
  errors: {
    _error: {
      file: "_error.ts",
      load: async () => ({ default: () => html`<h1>something broke</h1>`, hydrate: false }),
    },
  },
  notFound: {
    file: "_404.ts",
    load: async () => ({ default: () => html`<h1>no such page</h1>` }),
  },
})

/** The pages as their own nifra app; the differential app mounts it at `/pages`. */
export function createDifferentialPages(sentinel: string) {
  return createWebApp({
    adapter: vanillaAdapter,
    manifest: manifest(sentinel),
    clientEntry: "/c.js",
    title: "differential",
    server: { logger: silentLogger },
  })
}

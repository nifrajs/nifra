import { expect, test } from "bun:test"
import {
  createWebApp,
  type Manifest,
  type MetaArgs,
  notFound,
  type RenderAdapter,
  type RouteModule,
} from "../src/index.ts"
import { DATA_HEADER } from "../src/router.ts"
import { streamOf } from "./streams.ts"

const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    streamOf(
      `<p>C=${String(chain.at(-1))} L=${JSON.stringify(props.layoutData ?? null)} A=${JSON.stringify(props.actionData ?? null)}</p>`,
    ),
  hydrationHead: () => "",
}

/** A string field of loader data, read without asserting the data's type. */
const field = (data: unknown, key: string): string => String(Reflect.get(Object(data), key))

type Counts = { action: number; gate: number; layout: number }

type Overrides = { layoutLoader?: () => unknown; pageLoader?: () => unknown }

const appWith = (counts: Counts, { layoutLoader, pageLoader }: Overrides = {}) => {
  const gate: RouteModule = {
    default: "root",
    gate: true,
    loader: () => {
      counts.gate += 1
      return { user: "ada" }
    },
  }
  const layout: RouteModule = {
    default: "lang",
    loader:
      layoutLoader ??
      (({ params }) => {
        counts.layout += 1
        // Read after the action, so the render shows the mutation.
        return { locale: params.lang, sent: counts.action }
      }),
    meta: ({ data }: MetaArgs) => ({
      lang: field(data, "locale"),
      meta: [{ name: "x-sent", content: field(data, "sent") }],
    }),
  }
  const page: RouteModule = {
    default: "page",
    loader: pageLoader ?? (() => ({ title: "Contact" })),
    meta: ({ data }: MetaArgs) => ({ title: field(data, "title") }),
    action: () => {
      counts.action += 1
      return { ok: true }
    },
  }
  const manifest: Manifest = {
    routes: [
      {
        id: "[lang]/contact",
        pattern: "/:lang/contact",
        layoutIds: ["_layout", "[lang]/_layout"],
        layoutParams: [[], ["lang"]],
        errorIds: ["_error"],
        file: "[lang]/contact.tsx",
        load: async () => page,
      },
    ],
    layouts: {
      _layout: { file: "_layout.tsx", load: async () => gate },
      "[lang]/_layout": { file: "[lang]/_layout.tsx", load: async () => layout },
    },
    errors: { _error: { file: "_error.tsx", load: async () => ({ default: "boundary" }) } },
    notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
  }
  return createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
}

const submit = (headers: Record<string, string> = {}) =>
  new Request("http://x/hi/contact", {
    method: "POST",
    headers,
    body: new URLSearchParams({ message: "hello" }),
  })

test("a no-script action answer renders its layouts with their loader data and meta", async () => {
  const counts: Counts = { action: 0, gate: 0, layout: 0 }
  const res = await appWith(counts).fetch(submit())
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).toContain('L=[{"user":"ada"},{"locale":"hi","sent":1}] A={"ok":true}')
  expect(html).toContain('<html lang="hi"')
  expect(html).toContain('name="x-sent" content="1"')
  expect(html).toContain("<title>Contact</title>")
  // Hydration reads the same layout data the server rendered with.
  expect(html).toContain('"__NIFRA_LAYOUT_DATA__":[{"user":"ada"},{"locale":"hi","sent":1}]')
  expect(html).toContain('"__NIFRA_ACTION__":{"ok":true}')
  // The page shows what a layout loaded for this visitor.
  expect(res.headers.get("cache-control")).toBe("private, no-store")
  // The gate guarded the action and is not asked twice.
  expect(counts).toEqual({ action: 1, gate: 1, layout: 1 })
})

test("a data-mode action still runs no ordinary layout loader", async () => {
  const counts: Counts = { action: 0, gate: 0, layout: 0 }
  const res = await appWith(counts).fetch(submit({ [DATA_HEADER]: "1" }))
  expect(await res.json()).toEqual({ ok: true })
  expect(counts).toEqual({ action: 1, gate: 1, layout: 0 })
})

test("a layout's notFound() after a no-script action answers with the status page", async () => {
  const counts: Counts = { action: 0, gate: 0, layout: 0 }
  const res = await appWith(counts, { layoutLoader: () => notFound() }).fetch(submit())
  expect(res.status).toBe(404)
  expect(counts.action).toBe(1)
})

test("a page loader that throws after a no-script action renders the error boundary", async () => {
  const counts: Counts = { action: 0, gate: 0, layout: 0 }
  const app = appWith(counts, {
    pageLoader: () => {
      throw new Error("store down")
    },
  })
  const res = await app.fetch(submit())
  expect(res.status).toBe(500)
  expect(await res.text()).toContain("C=boundary")
  expect(counts.action).toBe(1)
})

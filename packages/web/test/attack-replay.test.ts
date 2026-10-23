import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import { serverFn, serverFunctions } from "../src/fn.ts"
import {
  buildManifest,
  createWebApp,
  type LoaderContext,
  type MetaArgs,
  type RenderAdapter,
  type RouteModule,
} from "../src/index.ts"
import { outputGuard } from "../src/internal/output-guard.ts"
import { MemoryCacheStore, withISR } from "../src/isr.ts"
import { DATA_HEADER, NAV_FROM_HEADER, RETAIN_HEADER } from "../src/router.ts"

/**
 * Hostile requests from attack classes that have broken other full-stack frameworks: a page reached
 * by a spelling, a data request or a client hint its guard never sees, a cached page served to
 * another visitor or poisoned by a data response, a server function called cross-site, a head tag
 * or loader value that closes its element, and a schema key that runs as generated code.
 */

const streamOf = (s: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(s)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

// Renders the chain and the loader data, so a test can see which page answered and what it got.
const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    streamOf(`<main>${JSON.stringify({ chain, data: props.data })}</main>`),
  hydrationHead: () => "",
}

type Module = Partial<RouteModule> & { readonly gate?: boolean; readonly middleware?: unknown }

const appOf = (modules: Record<string, Module>, adapter: RenderAdapter = stub) =>
  createWebApp({
    adapter,
    clientEntry: "/c.js",
    manifest: buildManifest(
      Object.keys(modules),
      (file) => () =>
        Promise.resolve(
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a test module holds only the exports its route reads, and the manifest reads each by name.
          (file.includes(".backend.")
            ? { ...modules[file] }
            : { default: file, ...modules[file] }) as RouteModule,
        ),
    ),
  })

const authorized = (ctx: LoaderContext): boolean =>
  ctx.request.headers.get("authorization") === "Bearer ok"

const guardedApp = () =>
  appOf({
    "index.tsx": {},
    "[...slug].tsx": {},
    "[...slug].backend.ts": {
      loaderOutput: t.object({ slug: t.string() }),
      loader: (ctx) => ({ slug: String(ctx.params.slug) }),
    },
    "admin/_layout.backend.ts": {
      middleware: (ctx: LoaderContext) =>
        authorized(ctx) ? undefined : new Response("denied", { status: 403 }),
    },
    "admin/secret.tsx": {},
    "admin/secret.backend.ts": {
      loaderOutput: t.object({ note: t.string() }),
      loader: () => ({ note: "admin-only" }),
      actionOutput: t.object({ wrote: t.boolean() }),
      action: () => ({ wrote: true }),
    },
    "gated/_layout.tsx": {},
    "gated/_layout.backend.ts": {
      gate: true,
      loaderOutput: t.object({}),
      loader: (ctx) => {
        if (!authorized(ctx)) throw new Response("denied", { status: 403 })
        return {}
      },
    },
    "gated/page.tsx": {},
    "gated/page.backend.ts": {
      loaderOutput: t.object({ note: t.string() }),
      loader: () => ({ note: "gated-only" }),
    },
  })

const send = (
  app: { fetch(request: Request): Response | Promise<Response> },
  path: string,
  init: RequestInit = {},
): Promise<Response> => Promise.resolve(app.fetch(new Request(`http://app.example${path}`, init)))

describe("guards on every way to reach a page", () => {
  test("no spelling of a guarded path renders the guarded page", async () => {
    const app = guardedApp()
    for (const path of [
      "/admin/secret",
      "/ADMIN/secret",
      "/%61dmin/secret",
      "/admin%2Fsecret",
      "//admin/secret",
      "/admin/secret/",
      "/admin//secret",
      "/admin/./secret",
      "/x/../admin/secret",
      "/admin/secret/_data.json",
      "/admin/secret;x",
      "/gated/page",
      "/GATED/page",
      "/gated/page/_data.json",
    ]) {
      const body = await (await send(app, path)).text()
      expect([path, /admin-only|gated-only/.test(body)]).toEqual([path, false])
    }
  })

  test("a data request, a client's retain hint, an action and a HEAD all meet the guard", async () => {
    const app = guardedApp()
    const hint = { [DATA_HEADER]: "1", [RETAIN_HEADER]: "0,1,2" }
    for (const [path, init] of [
      ["/admin/secret", { headers: { [DATA_HEADER]: "1" } }],
      ["/admin/secret", { headers: { ...hint, [NAV_FROM_HEADER]: "/admin/other" } }],
      ["/gated/page", { headers: { [DATA_HEADER]: "1" } }],
      ["/gated/page", { headers: { ...hint, [NAV_FROM_HEADER]: "/gated/other" } }],
      [
        "/admin/secret",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "a=1",
        },
      ],
      ["/admin/secret", { method: "HEAD" }],
    ] as const) {
      const res = await send(app, path, init)
      expect([path, res.status]).toEqual([path, 403])
    }
  })
})

describe("page cache", () => {
  const counted = () => {
    let renders = 0
    const app = appOf({
      "index.tsx": {},
      "me.tsx": {},
      "me.backend.ts": {
        loaderOutput: t.object({ render: t.number(), who: t.string() }),
        loader: (ctx) => ({
          render: ++renders,
          who:
            ctx.request.headers.get("authorization") ??
            ctx.request.headers.get("cookie") ??
            "anonymous",
        }),
      },
    })
    return withISR(app, { store: new MemoryCacheStore(), revalidate: 60, now: () => 0 })
  }
  const page = async (res: Response): Promise<string> => {
    const match = /<main>(.*?)<\/main>/s.exec(await res.text())
    return match?.[1] ?? "no page"
  }

  test("a navigation data response is never stored as the page", async () => {
    const isr = counted()
    const data = await isr(new Request("http://app.example/", { headers: { [DATA_HEADER]: "1" } }))
    expect(data.headers.get("vary")).toContain(DATA_HEADER)
    expect(await page(await isr(new Request("http://app.example/")))).toBe(
      '{"chain":["index.tsx"],"data":null}',
    )
  })

  test("a request carrying credentials neither stores nor reads the shared page", async () => {
    const isr = counted()
    const get = (headers: Record<string, string> = {}) =>
      isr(new Request("http://app.example/me", { headers }))
    expect(await page(await get({ cookie: "session=alice" }))).toContain('"who":"session=alice"')
    expect(await page(await get())).toContain('"render":2,"who":"anonymous"')
    expect(await page(await get({ authorization: "Bearer bob" }))).toContain('"who":"Bearer bob"')
    expect(await page(await get())).toContain('"render":2,"who":"anonymous"')
  })
})

describe("server functions", () => {
  let calls = 0
  const app = server().use(
    serverFunctions("notes", {
      save: serverFn(
        { input: t.object({ text: t.string() }), output: t.object({ saved: t.string() }) },
        (input) => {
          calls++
          return { saved: input.text }
        },
      ),
    }),
  )
  const call = (url: string, init: RequestInit) =>
    Promise.resolve(app.fetch(new Request(url, { method: "POST", ...init })))
  const json = { "content-type": "application/json" }

  test("a same-origin JSON call is the control", async () => {
    const res = await call("http://app.example/_nifra/fn/notes/save", {
      headers: { ...json, origin: "http://app.example" },
      body: '{"text":"x"}',
    })
    expect(await res.json()).toEqual({ saved: "x" })
  })

  test("a call from another origin, a null origin or a downgraded scheme is refused", async () => {
    for (const [url, origin] of [
      ["http://app.example/_nifra/fn/notes/save", "null"],
      ["http://app.example/_nifra/fn/notes/save", "http://evil.example"],
      ["http://app.example/_nifra/fn/notes/save", "http://app.example.evil.example"],
      ["https://app.example/_nifra/fn/notes/save", "http://app.example"],
    ] as const) {
      const res = await call(url, { headers: { ...json, origin }, body: '{"text":"x"}' })
      expect([origin, res.status]).toEqual([origin, 403])
    }
  })

  test("a body a cross-site form can send is refused before the function runs", async () => {
    const form = new FormData()
    form.set("text", "x")
    const before = calls
    for (const [label, init] of [
      ["text/plain", { headers: { "content-type": "text/plain" }, body: '{"text":"x"}' }],
      [
        "text/plain naming json",
        { headers: { "content-type": "text/plain; x=application/json" }, body: '{"text":"x"}' },
      ],
      [
        "urlencoded",
        { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "text=x" },
      ],
      ["multipart", { body: form }],
    ] as const) {
      const res = await call("http://app.example/_nifra/fn/notes/save", init)
      expect([label, res.status]).toEqual([label, 415])
    }
    expect(calls).toBe(before)
  })

  test("a body carrying __proto__, another method or an unknown function is refused", async () => {
    const proto = await call("http://app.example/_nifra/fn/notes/save", {
      headers: json,
      body: '{"text":"x","__proto__":{"admin":true}}',
    })
    expect(proto.status).toBe(400)
    const get = await app.fetch(new Request("http://app.example/_nifra/fn/notes/save"))
    expect(get.status).toBe(405)
    const unknown = await call("http://app.example/_nifra/fn/notes/drop", {
      headers: json,
      body: "{}",
    })
    expect(unknown.status).toBe(404)
  })
})

describe("document head and loader data", () => {
  const plain: RenderAdapter = {
    renderToStream: () => streamOf("<main>page</main>"),
    hydrationHead: () => "",
  }
  const payload = `</title></script><!--<script>alert(1)</script>"'><img src=x onerror=alert(1)>\u2028]]>`
  const app = appOf(
    {
      "x.tsx": {
        meta: ({ data }: MetaArgs) => {
          const v = String(Reflect.get(Object(data), "v"))
          return {
            title: v,
            lang: v,
            meta: [
              { name: "description", content: v },
              { property: v, content: "c" },
            ],
            link: [
              { rel: "canonical", href: v },
              { rel: "alternate", href: String(Reflect.get(Object(data), "u")) },
            ],
            script: [{ content: JSON.stringify({ v }) }],
          }
        },
      },
      "x.backend.ts": {
        loaderOutput: t.object({ v: t.string(), u: t.string() }),
        loader: (ctx) => {
          const query = new URL(ctx.request.url).searchParams
          return { v: query.get("v") ?? "", u: query.get("u") ?? "" }
        },
      },
    },
    plain,
  )

  test("a value in the title, a meta or link tag, JSON-LD or the page data cannot close its element", async () => {
    const res = await send(
      app,
      `/x?v=${encodeURIComponent(payload)}&u=${encodeURIComponent("javascript:alert(1)")}`,
    )
    const document = await res.text()
    expect(res.status).toBe(200)
    expect(document).not.toContain("<script>alert")
    expect(document).not.toMatch(/<img[^>]*onerror/)
    expect(document).not.toMatch(/href="javascript:/)
    expect(document).toContain(`<title>&lt;/title&gt;&lt;/script&gt;`)
    expect(document).toContain('"v":"\\u003c/title\\u003e')
  })
})

describe("generated code", () => {
  test("a declared key cannot run as code in the generated projector", () => {
    const flag = "__nifraProjectorInjected"
    const keys = [
      `"]; globalThis.${flag} = 1; //`,
      `\\"; globalThis.${flag} = 1; //`,
      `\u2028globalThis.${flag} = 1`,
      `\`\${globalThis.${flag} = 1}\``,
      `*/ globalThis.${flag} = 1 /*`,
    ]
    const project = outputGuard(
      {
        "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
        jsonSchema: {
          type: "object",
          properties: Object.fromEntries(keys.map((key) => [key, { type: "string" }])),
        },
      },
      '"page.backend.ts"',
      "loaderOutput",
    ).project
    try {
      expect(String(project).includes("switch (key)")).toBe(true)
      const value = Object.fromEntries(keys.map((key) => [key, "v"]))
      expect(project?.(value, { label: "x", issues: [] })).toEqual(value)
      expect(Reflect.get(globalThis, flag)).toBeUndefined()
    } finally {
      Reflect.deleteProperty(globalThis, flag)
    }
  })
})

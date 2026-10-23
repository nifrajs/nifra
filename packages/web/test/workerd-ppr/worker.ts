/**
 * Partially prerendered pages on a real workerd, driven by scripts/check-workerd-ppr.ts. Three apps
 * share one KV namespace as three isolates would: `a` and `b` are one deployment, `c` another. They
 * are created inside the first request, the shape in which a shell build could once see a visitor.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { toFetchHandler } from "@nifrajs/core/server"
import { compression } from "@nifrajs/middleware"
import type { BoundaryStates, Manifest, RenderAdapter, RouteModule } from "../../src/index.ts"
import { createWebApp } from "../../src/index.ts"
import { KVCacheStore, type KVNamespaceLike } from "../../src/isr.ts"
import { partialPrerendering, pprShells } from "../../src/ppr.ts"

const SECRET = "workerd-ppr-fixture-secret-0123456789"
const PROSE = "Loose leaf tea, packed by hand and shipped the same day it is weighed. ".repeat(4)

interface Env {
  readonly SHELLS: KVNamespaceLike
}

/** What the check reads through `/__probe`. One local isolate serves every request. */
interface Probe {
  readonly builds: Record<string, number>
  readonly shellContexts: unknown[]
  holeStarts: number
  holeAborts: number
  waitedUntil: number
}

const probe: Probe = {
  builds: { a: 0, b: 0, c: 0 },
  shellContexts: [],
  holeStarts: 0,
  holeAborts: 0,
  waitedUntil: 0,
}

let holds: Array<() => void> = []
const visitor = new AsyncLocalStorage<string>()

// The check moves this clock to make a shell stale; every app reads it through Date.now.
let offsetMs = 0
const realNow = Date.now.bind(Date)
Date.now = () => realNow() + offsetMs

const html = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })

const hosts = (states: BoundaryStates | undefined): string =>
  Object.values(states ?? {})
    .map((state) => `<div data-nifra-hole="${state.name}"></div>`)
    .join("")

const adapter: RenderAdapter = {
  renderToStream: (_chain, props) =>
    html(
      `<main><p>${PROSE}</p><h1>${JSON.stringify(props.data)}</h1>${hosts(props.boundaries)}</main>`,
    ),
  hydrationHead: () => "",
  renderFragment: (ui) => `<p>${String(ui())}</p>`,
}

/** A hole that waits for `/__release` when the request asks it to, and notes its abort. */
const heldHole = (ctx: { readonly signal: AbortSignal; readonly request: Request }) =>
  new Promise((resolve, reject) => {
    probe.holeStarts++
    ctx.signal.addEventListener(
      "abort",
      () => {
        probe.holeAborts++
        reject(ctx.signal.reason)
      },
      { once: true },
    )
    if (!new URL(ctx.request.url).searchParams.has("hold")) resolve("3 items")
    else holds.push(() => resolve("3 items"))
  })

function page(app: string, timeout: number | undefined): RouteModule {
  // biome-ignore lint/plugin/noChainedTypeAssertions: a route module with only the fields the partially prerendered path reads.
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a route module with only the fields the partially prerendered path reads.
  return {
    default: "page",
    revalidate: 60,
    revalidateTags: ({ params }: { readonly params: Record<string, string> }) => [
      `product:${params.id}`,
    ],
    shellLoader: async () => {
      probe.builds[app] = (probe.builds[app] ?? 0) + 1
      probe.shellContexts.push(visitor.getStore())
      return { title: `${app} build ${probe.builds[app]}` }
    },
    boundaries: [
      {
        name: "cart",
        mode: "dynamic",
        timeout: timeout ?? 5000,
        render: (data: unknown) => `cart ${String(data)}`,
        fallback: "loading",
        load: heldHole,
      },
    ],
  } as unknown as RouteModule
}

function manifestFor(app: string): Manifest {
  return {
    routes: [
      {
        id: "p/[id]",
        pattern: "/p/:id",
        layoutIds: [],
        layoutParams: [],
        file: "p/[id].tsx",
        load: async () => page(app, undefined),
      },
      {
        id: "d/[id]",
        pattern: "/d/:id",
        layoutIds: [],
        layoutParams: [],
        file: "d/[id].tsx",
        load: async () => page(app, 50),
      },
    ],
    layouts: {},
    notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
  }
}

function deploy(env: Env) {
  const store = new KVCacheStore(env.SHELLS)
  const make = (app: string, deployment: string) => {
    const created = createWebApp({
      adapter,
      manifest: manifestFor(app),
      clientEntry: "/c.js",
      experimental: {
        ppr: partialPrerendering({
          shellChecks: { v: 1, deployment: "/c.js", routes: { "p/[id]": "p1", "d/[id]": "d1" } },
          store,
          storeSecret: SECRET,
          deployment,
        }),
      },
    })
    created.use(compression())
    return { app: created, handler: toFetchHandler(created) }
  }
  return { a: make("a", "v1"), b: make("b", "v1"), c: make("c", "v2") }
}

let deployed: ReturnType<typeof deploy> | undefined

type ExecutionContextOf = Parameters<ReturnType<typeof toFetchHandler>["fetch"]>[2]

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContextOf): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === "/__nifra_ready__") return new Response("ready")
    if (url.pathname === "/__probe") return Response.json(probe)
    if (url.pathname === "/__release") {
      const released = holds.length
      for (const release of holds) release()
      holds = []
      return Response.json(released)
    }
    if (url.pathname === "/__advance") {
      offsetMs += Number(url.searchParams.get("ms") ?? "0")
      return Response.json(offsetMs)
    }
    // Inside the first visitor's context, as an app created on its first request is.
    return visitor.run(`visitor ${url.search}`, async () => {
      deployed ??= deploy(env)
      if (url.pathname === "/__purge") {
        await pprShells(deployed.a.app).invalidateTag(url.searchParams.get("tag") ?? "")
        return new Response("purged")
      }
      const name = url.searchParams.get("app") ?? "a"
      const target = name === "b" ? deployed.b : name === "c" ? deployed.c : deployed.a
      const platform: ExecutionContextOf = {
        waitUntil: (promise: Promise<unknown>) =>
          ctx.waitUntil(promise.finally(() => probe.waitedUntil++)),
      }
      return target.handler.fetch(req, env, platform)
    })
  },
}

import { expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import {
  createWebApp,
  type ISRApp,
  MemoryCacheStore,
  revalidateEndpoint,
  withISR,
} from "../src/index.ts"
import type { Manifest } from "../src/manifest.ts"
import { componentRequestHeader } from "../src/server-components/protocol.ts"
import {
  createServerComponents,
  defineServerComponent,
  serverComponentInstance,
} from "../src/server-components.ts"

type Counts = { page: number; component: number; render: number }

function ownerApp(build: string, deployment: string, counts: Counts) {
  const component = defineServerComponent(
    {
      input: t.object({}),
      props: t.object({ value: t.string() }),
      authorize() {},
      load() {
        counts.component += 1
        return { value: "public" }
      },
      view: ({ props }) => props.value,
    },
    "cache_owner_component",
  )
  const serverComponents = createServerComponents({
    build,
    deployment,
    adapter: {
      name: "vue",
      version: 1,
      render() {
        counts.render += 1
        return { html: "<p>public</p>" }
      },
    },
    owners: {
      owner: {
        cache: {
          scope: "public",
          requestIndependent: true,
          revalidate: 60,
          tags: ["owner-public"],
        },
        components: [component],
        scope: "anonymous",
        instances: () => [serverComponentInstance(component, "stable", {})],
      },
    },
  })
  const manifest: Manifest = {
    routes: [
      {
        id: "owner",
        pattern: "/owner",
        file: "owner.ts",
        layoutIds: [],
        errorIds: [],
        middlewareIds: [],
        load: async () => ({
          default: () => null,
          loader() {
            counts.page += 1
            return { label: "public" }
          },
        }),
      },
      {
        id: "plain",
        pattern: "/plain",
        file: "plain.ts",
        layoutIds: [],
        errorIds: [],
        middlewareIds: [],
        load: async () => ({
          default: () => null,
          loader() {
            counts.page += 1
            return { label: "public" }
          },
        }),
      },
    ],
    layouts: {},
    middlewares: {},
    errors: {},
  }
  const app = createWebApp({
    manifest,
    clientEntry: "/entry.js",
    llmsTxt: false,
    serverComponents,
    adapter: {
      renderToString: () => "<main>owner</main>",
      renderToStream: () =>
        new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
      hydrationHead: () => "",
    },
  })
  return { app, build }
}

test("public owner ISR caches the complete page only inside a deployment/build/route partition", async () => {
  const store = new MemoryCacheStore()
  const a: Counts = { page: 0, component: 0, render: 0 }
  const b: Counts = { page: 0, component: 0, render: 0 }
  const c: Counts = { page: 0, component: 0, render: 0 }
  const appA = ownerApp("build_a", "deploy_a", a).app
  const appB = ownerApp("build_a", "deploy_b", b).app
  const appC = ownerApp("build_b", "deploy_a", c).app
  const isrA = withISR(appA, { store, revalidate: 60, now: () => 0 })
  const isrB = withISR(appB, { store, revalidate: 60, now: () => 0 })
  const isrC = withISR(appC, { store, revalidate: 60, now: () => 0 })
  const request = () => new Request("https://fixture.test/owner")

  const first = await isrA(request())
  expect(first.headers.get("x-nifra-isr")).toBe("miss")
  expect(first.headers.get("cache-control")).toBe("private, no-store")
  await first.arrayBuffer()
  const warm = await isrA(request())
  expect(warm.headers.get("x-nifra-isr")).toBe("hit")
  await warm.arrayBuffer()
  expect(a).toEqual({ page: 1, component: 1, render: 1 })

  const otherDeployment = await isrB(request())
  expect(otherDeployment.headers.get("x-nifra-isr")).toBe("miss")
  await otherDeployment.arrayBuffer()
  const otherBuild = await isrC(request())
  expect(otherBuild.headers.get("x-nifra-isr")).toBe("miss")
  await otherBuild.arrayBuffer()
  expect(b).toEqual({ page: 1, component: 1, render: 1 })
  expect(c).toEqual({ page: 1, component: 1, render: 1 })

  await store.invalidateTag("owner-public")
  const revalidated = await isrA(request())
  expect(revalidated.headers.get("x-nifra-isr")).toBe("miss")
  await revalidated.arrayBuffer()
  expect(a).toEqual({ page: 2, component: 2, render: 2 })

  const otherDeploymentAfterTagPurge = await isrB(request())
  expect(otherDeploymentAfterTagPurge.headers.get("x-nifra-isr")).toBe("miss")
  await otherDeploymentAfterTagPurge.arrayBuffer()

  const revalidateA = revalidateEndpoint({
    store,
    app: appA,
    secret: "owner-cache-revalidation-secret-32-bytes",
  })
  const purged = await revalidateA(
    new Request("https://fixture.test/__nifra/revalidate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nifra-revalidate-token": "owner-cache-revalidation-secret-32-bytes",
      },
      body: JSON.stringify({ path: "/owner" }),
    }),
  )
  expect(purged.status).toBe(200)
  await purged.arrayBuffer()

  const afterPathPurgeA = await isrA(request())
  expect(afterPathPurgeA.headers.get("x-nifra-isr")).toBe("miss")
  await afterPathPurgeA.arrayBuffer()
  const otherDeploymentStillWarm = await isrB(request())
  expect(otherDeploymentStillWarm.headers.get("x-nifra-isr")).toBe("hit")
  await otherDeploymentStillWarm.arrayBuffer()
  expect(a).toEqual({ page: 3, component: 3, render: 3 })
  expect(b).toEqual({ page: 2, component: 2, render: 2 })
})

test("owner cache rejects credentialed and component-refresh requests and direct app fetch stays private", async () => {
  const counts: Counts = { page: 0, component: 0, render: 0 }
  const { app, build } = ownerApp("build_private", "deploy_private", counts)
  const directApp = ownerApp("build_direct", "deploy_direct", {
    page: 0,
    component: 0,
    render: 0,
  }).app
  const store = new MemoryCacheStore()
  const isr = withISR(app, { store, revalidate: 60, now: () => 0 })
  const url = "https://fixture.test/owner"

  const cached = await isr(new Request(url))
  expect(cached.headers.get("x-nifra-isr")).toBe("miss")
  await cached.arrayBuffer()

  for (const headers of [{ authorization: "Bearer private" }, { cookie: "session=private" }]) {
    const response = await isr(new Request(url, { headers }))
    expect(response.headers.get("x-nifra-isr")).toBeNull()
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    await response.arrayBuffer()
  }
  expect(counts.page).toBe(3)

  const component = await isr(
    new Request(url, {
      headers: {
        "x-nifra-component": componentRequestHeader({
          v: 1,
          build,
          reference: "cache_owner_component",
          key: "stable",
          parent: null,
          generation: 1,
          routeEpoch: 0,
          authEpoch: 0,
          input: {},
        }),
        "sec-fetch-site": "same-origin",
      },
    }),
  )
  expect(component.headers.get("x-nifra-isr")).toBeNull()
  expect(component.headers.get("cache-control")).toBe("private, no-store")
  expect(component.headers.get("x-nifra-owner-cacheable")).toBeNull()
  await component.arrayBuffer()

  const direct = await directApp.fetch(new Request(url))
  expect(direct.headers.get("cache-control")).toBe("private, no-store")
  expect(direct.headers.get("x-nifra-owner-cacheable")).toBeNull()
  expect(direct.headers.get("x-nifra-isr-revalidate")).toBeNull()
  await direct.arrayBuffer()
})

test("public owner caching requires deployment identity and a static anonymous scope", () => {
  const component = defineServerComponent(
    {
      input: t.object({}),
      props: t.object({ value: t.string() }),
      authorize() {},
      load: () => ({ value: "public" }),
      view: ({ props }) => props.value,
    },
    "cache_owner_component",
  )
  const base = {
    build: "build_policy",
    adapter: { name: "vue" as const, version: 1 as const, render: () => ({ html: "" }) },
    owners: {
      owner: {
        cache: {
          scope: "public" as const,
          requestIndependent: true as const,
          revalidate: 60,
          tags: ["owner-public"],
        },
        components: [component],
        scope: "anonymous" as const,
        instances: () => [serverComponentInstance(component, "stable", {})],
      },
    },
  }
  expect(() => createServerComponents(base)).toThrow()
  expect(() =>
    createServerComponents({
      ...base,
      deployment: "deploy_policy",
      owners: { owner: { ...base.owners.owner, scope: () => "anonymous" } },
    }),
  ).toThrow()
})

test("ISR bypasses storage when a configured owner cache partition cannot be resolved", async () => {
  const store = new MemoryCacheStore()
  let renders = 0
  const app: ISRApp = {
    async fetch() {
      renders += 1
      return new Response("<main>public</main>", {
        headers: {
          "cache-control": "public, max-age=60",
          "content-type": "text/html; charset=utf-8",
        },
      })
    },
  }
  Object.defineProperty(app, Symbol.for("nifra.web.serverComponentCachePartition"), {
    value: () => null,
  })
  const isr = withISR(app, { store, revalidate: 60, now: () => 0 })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await isr(new Request("https://fixture.test/owner"))
    expect(response.headers.get("x-nifra-isr")).toBeNull()
    await response.arrayBuffer()
  }
  expect(renders).toBe(2)
})

test("ISR never stores error, cookie-setting, or cancelled owner documents", async () => {
  const store = new MemoryCacheStore()
  let requests = 0
  let cancelNext = true
  let cancelStarted!: () => void
  const cancelStartedPromise = new Promise<void>((resolve) => {
    cancelStarted = resolve
  })
  const publicHeaders = {
    "cache-control": "public, max-age=60",
    "content-type": "text/html; charset=utf-8",
  }
  const app: ISRApp = {
    async fetch(request) {
      requests += 1
      const path = new URL(request.url).pathname
      if (path === "/error") return new Response("error", { status: 500, headers: publicHeaders })
      if (path === "/cookie")
        return new Response("<main>private</main>", {
          headers: { ...publicHeaders, "set-cookie": "session=private" },
        })
      if (path === "/cancel" && cancelNext) {
        cancelNext = false
        cancelStarted()
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<main>"))
              const cancel = () => controller.error(new Error("request_aborted"))
              if (request.signal.aborted) cancel()
              else request.signal.addEventListener("abort", cancel, { once: true })
            },
          }),
          { headers: publicHeaders },
        )
      }
      return new Response("<main>public</main>", { headers: publicHeaders })
    },
  }
  Object.defineProperty(app, Symbol.for("nifra.web.serverComponentCachePartition"), {
    value: () => "deployment_build_route",
  })
  const isr = withISR(app, { store, revalidate: 60, now: () => 0 })

  for (const path of ["/error", "/cookie"]) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await isr(new Request(`https://fixture.test${path}`))
      expect(response.headers.get("x-nifra-isr")).toBeNull()
      await response.arrayBuffer()
    }
  }

  const abort = new AbortController()
  const cancelled = isr(new Request("https://fixture.test/cancel", { signal: abort.signal }))
  await cancelStartedPromise
  abort.abort()
  let rejected = false
  try {
    await cancelled
  } catch {
    rejected = true
  }
  expect(rejected).toBe(true)

  const retry = await isr(new Request("https://fixture.test/cancel"))
  expect(retry.headers.get("x-nifra-isr")).toBe("miss")
  await retry.arrayBuffer()
  const warm = await isr(new Request("https://fixture.test/cancel"))
  expect(warm.headers.get("x-nifra-isr")).toBe("hit")
  await warm.arrayBuffer()
  expect(requests).toBe(6)
})

test("ordinary routes in a server-component app keep their URL-keyed ISR cache", async () => {
  const store = new MemoryCacheStore()
  const counts: Counts = { page: 0, component: 0, render: 0 }
  const app = ownerApp("build_mixed_routes", "deploy_mixed_routes", counts).app
  const isr = withISR(app, { store, revalidate: 60, now: () => 0 })
  const request = () => new Request("https://fixture.test/plain")

  const first = await isr(request())
  expect(first.headers.get("x-nifra-isr")).toBe("miss")
  await first.arrayBuffer()
  const warm = await isr(request())
  expect(warm.headers.get("x-nifra-isr")).toBe("hit")
  await warm.arrayBuffer()
  expect(counts.page).toBe(1)
})

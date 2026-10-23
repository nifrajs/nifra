/**
 * An action's `revalidate(paths, data, { tags, keys })` through the one invalidation pipeline: run by
 * `withISR` when it wraps the app, by the app itself (publish only) when nothing does.
 */
import { afterEach, expect, jest, spyOn, test } from "bun:test"
import {
  type CacheStore,
  createWebApp,
  type ISROptions,
  type ISRQuery,
  type Manifest,
  MemoryCacheStore,
  type RenderAdapter,
  redirect,
  revalidate,
  revalidateEndpoint,
  withISR,
} from "../src/index.ts"
import type { InvalidationReport } from "../src/internal/invalidation.ts"
import { type Live, type LiveBus, live, memoryBus } from "../src/live.ts"
import type { LoaderContext } from "../src/manifest.ts"
import { DATA_HEADER } from "../src/router.ts"

const SECRET = "invalidation-test-secret-0123456789ab"
const ORIGIN = "https://app.test"

afterEach(() => {
  jest.useRealTimers()
})

const stub: RenderAdapter = {
  renderToStream: (_chain, props) =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`<p>${JSON.stringify(props.data)}</p>`))
        c.close()
      },
    }),
  hydrationHead: () => "",
}

interface Db {
  primary: number
  replica: number
}

type Action = (ctx: LoaderContext) => unknown

function appWith(action: Action, runtime: Live | undefined, db: Db = { primary: 0, replica: 0 }) {
  const manifest: Manifest = {
    routes: [
      {
        id: "posts/[id]",
        pattern: "/posts/:id",
        layoutIds: [],
        layoutParams: [],
        file: "posts/[id].tsx",
        load: async () => ({
          default: "post",
          revalidate: 60,
          loader: (ctx: LoaderContext) => {
            ctx.live(`post:${ctx.params.id}`)
            return { id: ctx.params.id, value: db.replica }
          },
          action,
        }),
      },
    ],
    layouts: {},
    notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
  }
  const base = { adapter: stub, manifest, clientEntry: "/c.js" }
  return createWebApp(runtime === undefined ? base : { ...base, live: runtime })
}

const post = (url = `${ORIGIN}/posts/1`): Request =>
  new Request(url, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      [DATA_HEADER]: "1",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "x=1",
  })

const runtimeOf = (options: { bus?: LiveBus; visible?: () => Promise<void> } = {}): Live =>
  live({ secret: SECRET, subject: () => null, ...options })

const writes = (): Action => async () =>
  revalidate(["/posts/1"], { ok: true }, { tags: ["feed"], keys: ["post:1"] })

/** Settle `promise` while advancing fake timers, for retries the pipeline sleeps between. */
async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false
  void promise.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  for (let i = 0; i < 400 && !done; i++) {
    for (let j = 0; j < 10; j++) await Promise.resolve()
    jest.advanceTimersByTime(50)
  }
  return promise
}

// --- Without a cache wrapper: the app publishes ---------------------------------------------------

test("without withISR, an action's revalidate publishes its keys and tags once, before it answers", async () => {
  const runtime = runtimeOf()
  const publish = spyOn(runtime, "publish")
  const app = appWith(writes(), runtime)
  const res = await app.fetch(post())
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(publish.mock.calls).toEqual([["post:1", "feed"]])
  // Nothing about the operation reaches the wire.
  for (const [, value] of res.headers) {
    expect(value.includes("post:1")).toBe(false)
    expect(value.includes("feed")).toBe(false)
  }
})

test("a publish that keeps failing leaves the action's answer unchanged and is reported once", async () => {
  const runtime = runtimeOf()
  const publish = spyOn(runtime, "publish").mockImplementation(async () => {
    throw new Error("bus down")
  })
  const error = spyOn(console, "error").mockImplementation(() => {})
  try {
    jest.useFakeTimers()
    const app = appWith(writes(), runtime)
    const res = await settled(Promise.resolve(app.fetch(post())))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(publish.mock.calls.length).toBe(3)
    expect(error.mock.calls.length).toBe(1)
    const line = String(error.mock.calls[0]?.[0])
    expect(line).toContain("publish")
    expect(line.includes("post:1")).toBe(false)
  } finally {
    error.mockRestore()
  }
})

test("an action that throws, or returns without revalidate, publishes nothing", async () => {
  const runtime = runtimeOf()
  const publish = spyOn(runtime, "publish")
  const plain = appWith(async () => ({ ok: true }), runtime)
  expect((await plain.fetch(post())).status).toBe(200)
  const throwing = appWith(async () => {
    throw new Error("write failed")
  }, runtime)
  expect((await throwing.fetch(post())).status).toBe(500)
  const pathsOnly = appWith(async () => revalidate(["/posts/1"], { ok: true }), runtime)
  expect((await pathsOnly.fetch(post())).status).toBe(200)
  expect(publish).not.toHaveBeenCalled()
})

test("a redirecting action still invalidates what it wrote", async () => {
  const runtime = runtimeOf()
  const publish = spyOn(runtime, "publish")
  const app = appWith(
    async () => revalidate(["/posts/1"], redirect("/posts/2"), { keys: ["post:1"] }),
    runtime,
  )
  const res = await app.fetch(post())
  expect(res.headers.get("x-nifra-redirect") ?? res.headers.get("location")).toContain("/posts/2")
  expect(publish.mock.calls).toEqual([["post:1"]])
})

test("an app with no live runtime and no cache wrapper runs nothing", async () => {
  const uuid = spyOn(crypto, "randomUUID")
  const app = appWith(writes(), undefined)
  const res = await app.fetch(post())
  expect(await res.json()).toEqual({ ok: true })
  // No operation is even built: nothing would run it.
  expect(uuid).not.toHaveBeenCalled()
  uuid.mockRestore()
})

test("a live app whose action names only paths publishes nothing and builds no operation", async () => {
  const runtime = runtimeOf()
  const publish = spyOn(runtime, "publish")
  const uuid = spyOn(crypto, "randomUUID")
  const app = appWith(async () => revalidate(["/posts/1"], { ok: true }), runtime)
  const res = await app.fetch(post())
  expect(await res.json()).toEqual({ ok: true })
  expect(publish).not.toHaveBeenCalled()
  expect(uuid).not.toHaveBeenCalled()
  uuid.mockRestore()
})

// --- With withISR: the wrapper owns every stage -------------------------------------------------------

interface Recorded {
  readonly calls: string[]
  readonly store: CacheStore
  readonly reports: InvalidationReport[]
}

/** `stallTags`: a tag purge never settles, as a network store that stopped answering. */
function recordingStore(base: MemoryCacheStore, calls: string[], stallTags = false): CacheStore {
  const never = new Promise<void>(() => {})
  return {
    get: (key) => base.get(key),
    set: (key, value) => base.set(key, value),
    delete: async (key) => {
      calls.push(`delete:${key}`)
      await base.delete(key)
    },
    invalidateTag: async (tag) => {
      calls.push(`pageTag:${tag}`)
      if (stallTags) return never
      await base.invalidateTag(tag)
    },
  }
}

function wrapped(
  action: Action,
  options: {
    failData?: boolean
    query?: ISRQuery
    stallTags?: boolean
    isr?: Pick<ISROptions, "storeTimeoutMs">
  } = {},
): { handler: ReturnType<typeof withISR>; runtime: Live } & Recorded {
  const calls: string[] = []
  const reports: InvalidationReport[] = []
  const runtime = runtimeOf()
  spyOn(runtime, "publish").mockImplementation(async (...keys: string[]) => {
    calls.push(`publish:${keys.join(",")}`)
  })
  const store = recordingStore(new MemoryCacheStore(), calls, options.stallTags)
  const handler = withISR(appWith(action, runtime), {
    storeSecret: SECRET,
    store,
    revalidate: 60,
    now: () => Date.now(),
    query: options.query ?? "bypass",
    ...options.isr,
    dataCaches: [
      {
        invalidateTag: async (tag: string) => {
          calls.push(`data:${tag}`)
          if (options.failData === true) throw new Error("data cache down")
        },
      },
    ],
    cdn: {
      purge: async (target) => {
        calls.push(`cdn:${target.paths?.join(",")}|${target.tags?.join(",")}`)
        return { cdn: "accepted", retryable: false }
      },
    },
    onInvalidationError: (report) => reports.push(report),
  })
  return { handler, runtime, calls, store, reports }
}

test("with withISR the wrapper runs every stage in order, and the app does not publish again", async () => {
  const { handler, calls } = wrapped(writes())
  const res = await handler(post())
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(calls).toEqual([
    "data:feed",
    `delete:${ORIGIN}/posts/1`,
    "pageTag:feed",
    "publish:post:1,feed",
    "cdn:/posts/1|feed",
  ])
})

test("key parity: the page an action revalidates is the entry withISR stored", async () => {
  const { handler, calls } = wrapped(async () =>
    revalidate(["/posts/1?page=2"], { ok: true }, { keys: ["post:1"] }),
  )
  const plain = wrapped(writes())
  const first = await plain.handler(new Request(`${ORIGIN}/posts/1`))
  expect(first.headers.get("x-nifra-isr")).toBe("miss")
  expect((await plain.handler(new Request(`${ORIGIN}/posts/1`))).headers.get("x-nifra-isr")).toBe(
    "hit",
  )
  await plain.handler(post())
  expect((await plain.handler(new Request(`${ORIGIN}/posts/1`))).headers.get("x-nifra-isr")).toBe(
    "miss",
  )
  // A query the default key never caches names no entry: nothing to delete.
  await handler(post())
  expect(calls.filter((call) => call.startsWith("delete"))).toEqual([])
  const listed = wrapped(
    async () => revalidate(["/posts/1?page=2"], { ok: true }, { keys: ["post:1"] }),
    { query: ["page"] },
  )
  await listed.handler(new Request(`${ORIGIN}/posts/1?page=2`))
  await listed.handler(post())
  expect(listed.calls.filter((call) => call.startsWith("delete"))).toEqual([
    `delete:${ORIGIN}/posts/1?page=2`,
  ])
  expect(
    (await listed.handler(new Request(`${ORIGIN}/posts/1?page=2`))).headers.get("x-nifra-isr"),
  ).toBe("miss")
})

test("key parity under a custom key: the purge keys each path with the action's own headers", async () => {
  const db: Db = { primary: 0, replica: 0 }
  const calls: string[] = []
  const handler = withISR(
    appWith(
      async () => {
        db.replica = 1
        return revalidate(["/posts/1"], { ok: true })
      },
      runtimeOf(),
      db,
    ),
    {
      storeSecret: SECRET,
      store: recordingStore(new MemoryCacheStore(), calls),
      revalidate: 60,
      now: () => Date.now(),
      key: (req) => `${new URL(req.url).pathname}:${req.headers.get("accept-language") ?? "-"}`,
    },
  )
  const read = (language: string) =>
    handler(new Request(`${ORIGIN}/posts/1`, { headers: { "accept-language": language } }))
  await read("en")
  await read("fr")
  expect((await read("en")).headers.get("x-nifra-isr")).toBe("hit")
  const action = post()
  action.headers.set("accept-language", "en")
  await handler(action)
  expect(calls.filter((call) => call.startsWith("delete"))).toEqual(["delete:/posts/1:en"])
  const fresh = await read("en")
  expect(fresh.headers.get("x-nifra-isr")).toBe("miss")
  expect(await fresh.text()).toContain('"value":1')
  // A path never reaches another language's variant: tags are how every variant goes.
  expect((await read("fr")).headers.get("x-nifra-isr")).toBe("hit")
})

test("a tag purge that outlives storeTimeoutMs fails its stage: nothing is published, the action answers", async () => {
  jest.useFakeTimers()
  const { handler, calls, reports } = wrapped(writes(), {
    stallTags: true,
    isr: { storeTimeoutMs: 50 },
  })
  const res = await settled(handler(post()))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(calls.filter((call) => /^(publish|cdn):/.test(call))).toEqual([])
  expect(reports).toHaveLength(1)
  expect(reports[0]?.stages.at(-1)).toEqual({
    stage: "pages",
    ok: false,
    retryable: true,
    error: "pages_failed",
  })
})

test("a data cache that keeps failing stops the publish and the CDN; the action answers as usual", async () => {
  jest.useFakeTimers()
  const { handler, calls, reports } = wrapped(writes(), { failData: true })
  const res = await settled(handler(post()))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(calls.every((call) => call === "data:feed")).toBe(true)
  expect(reports.length).toBe(1)
  expect(reports[0]?.stages).toEqual([
    { stage: "data", ok: false, retryable: true, error: "data_failed" },
  ])
})

test("with waitUntil the retries run behind the answer", async () => {
  jest.useFakeTimers()
  const { handler, calls } = wrapped(writes(), { failData: true })
  const background: Promise<unknown>[] = []
  const res = await handler(post(), { waitUntil: (promise) => background.push(promise) })
  expect(res.status).toBe(200)
  expect(background.length).toBe(1)
  expect(calls).toEqual(["data:feed"])
  await settled(Promise.all(background))
  expect(calls.length).toBe(4)
})

test("a page purge that hangs is cut off at storeTimeoutMs, retried, and the action still answers", async () => {
  jest.useFakeTimers()
  const reports: InvalidationReport[] = []
  let deletes = 0
  const base = new MemoryCacheStore()
  const handler = withISR(
    appWith(async () => revalidate(["/posts/1"], { ok: true }), undefined),
    {
      storeSecret: SECRET,
      store: {
        get: (key) => base.get(key),
        set: (key, value) => base.set(key, value),
        delete: () => {
          deletes++
          return new Promise<never>(() => {})
        },
      },
      revalidate: 60,
      now: () => Date.now(),
      storeTimeoutMs: 50,
      onInvalidationError: (report) => reports.push(report),
    },
  )
  const res = await settled(handler(post()))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  // The first try and the retries at 200 and 600 ms; the next would pass the inline deadline.
  expect(deletes).toBe(3)
  expect(reports.map((report) => report.stages)).toEqual([
    [{ stage: "pages", ok: false, retryable: true, error: "pages_failed" }],
  ])
})

test("a custom ISR key is handed each revalidated path as a request on the action's origin", async () => {
  const calls: string[] = []
  const seen: string[] = []
  const handler = withISR(
    appWith(async () => revalidate(["/posts/1"], { ok: true }), undefined),
    {
      storeSecret: SECRET,
      store: recordingStore(new MemoryCacheStore(), calls),
      revalidate: 60,
      now: () => Date.now(),
      key: (req) => {
        seen.push(req.url)
        return `custom:${new URL(req.url).pathname}`
      },
    },
  )
  const res = await handler(post())
  expect(res.status).toBe(200)
  expect(seen).toEqual([`${ORIGIN}/posts/1`])
  expect(calls).toEqual(["delete:custom:/posts/1"])
})

// --- Visibility -------------------------------------------------------------------------------------

test("publish waits for visible() before the change reaches the bus", async () => {
  const bus = memoryBus()
  const appended: unknown[] = []
  const recording: LiveBus = {
    append: async (input) => {
      appended.push(input)
      return bus.append(input)
    },
    subscribe: (listener) => bus.subscribe(listener),
  }
  let release: () => void = () => {}
  const caughtUp = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = runtimeOf({ bus: recording, visible: () => caughtUp })
  await runtime.ready
  const publishing = runtime.publish("post:1")
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(appended).toEqual([])
  release()
  await publishing
  expect(appended).toEqual([{ type: "change", keys: ["post:1"] }])
})

test("replica visibility: the publish waits for the replica, so the reload it triggers reads the write", async () => {
  const db: Db = { primary: 0, replica: 0 }
  const waiting: (() => void)[] = []
  let asked: () => void = () => {}
  const visibleAsked = new Promise<void>((resolve) => {
    asked = resolve
  })
  const runtime = runtimeOf({
    visible: () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve)
        asked()
      }),
  })
  const app = appWith(
    async () => {
      db.primary++
      return revalidate(["/posts/1"], { ok: true }, { keys: ["post:1"] })
    },
    runtime,
    db,
  )
  const original = runtime.publish.bind(runtime)
  let seenAtPublish: number | undefined
  spyOn(runtime, "publish").mockImplementation(async (...keys: string[]) => {
    await original(...keys)
    // What a client told to reload now would read.
    seenAtPublish = db.replica
  })
  const answering = Promise.resolve(app.fetch(post()))
  await visibleAsked
  expect(seenAtPublish).toBeUndefined()
  // The replica catches up after the commit; only then does the change go out.
  db.replica = db.primary
  for (const resolve of waiting) resolve()
  expect((await answering).status).toBe(200)
  expect(seenAtPublish).toBe(1)
})

// --- The revalidate endpoint ------------------------------------------------------------------------

test("the revalidate endpoint runs the same pipeline, keeping its answers", async () => {
  const calls: string[] = []
  const runtime = runtimeOf()
  const publish = spyOn(runtime, "publish").mockImplementation(async (...keys: string[]) => {
    calls.push(`publish:${keys.join(",")}`)
  })
  const store = recordingStore(new MemoryCacheStore(), calls)
  const purge = (path: string) =>
    new Request(`${ORIGIN}/__nifra/revalidate?${path}`, {
      method: "POST",
      headers: { "x-nifra-revalidate-token": "t".repeat(32) },
    })
  const endpoint = revalidateEndpoint({
    store,
    secret: "t".repeat(32),
    live: runtime,
    cdn: {
      purge: async () => ({ cdn: "queued", retryable: true }),
    },
  })
  const res = await endpoint(purge("tag=posts"))
  expect(res.status).toBe(202)
  expect(await res.json()).toEqual({ revalidatedTag: "posts", cdn: "queued" })
  expect(calls).toEqual(["pageTag:posts", "publish:posts"])

  publish.mockImplementation(async () => {
    throw new Error("bus down")
  })
  const failed = await revalidateEndpoint({ store, secret: "t".repeat(32), live: runtime })(
    purge("path=/posts/1"),
  )
  expect(failed.status).toBe(200)
  const failedTag = await revalidateEndpoint({ store, secret: "t".repeat(32), live: runtime })(
    purge("tag=posts"),
  )
  expect(failedTag.status).toBe(502)
  expect(await failedTag.json()).toEqual({
    ok: false,
    error: "live_publish_failed",
    origin: "done",
    retryable: true,
  })

  const broken: CacheStore = {
    get: async () => undefined,
    set: async () => {},
    delete: async () => {
      throw new Error("store down")
    },
  }
  const pages = await revalidateEndpoint({ store: broken, secret: "t".repeat(32) })(
    purge("path=/posts/1"),
  )
  expect(pages.status).toBe(500)
  expect(await pages.json()).toEqual({ ok: false, error: "page_store_invalidation_failed" })
})

// --- revalidate() itself ----------------------------------------------------------------------------

test("revalidate() checks and de-duplicates its tags and keys", () => {
  expect(revalidate(["/a"], 1, { tags: ["t", "t"], keys: ["k:1"] })).toEqual({
    __nifraRevalidate: ["/a"],
    data: 1,
    __nifraInvalidate: { tags: ["t"], keys: ["k:1"] },
  })
  expect(revalidate(["/a"], 1)).toEqual({ __nifraRevalidate: ["/a"], data: 1 })
  expect(() => revalidate([], 1, { keys: ["bad key"] })).toThrow(TypeError)
  expect(() => revalidate([], 1, { tags: ["1starts-with-digit"] })).toThrow(TypeError)
  expect(() => revalidate([], 1, { keys: Array.from({ length: 65 }, (_, i) => `k:${i}`) })).toThrow(
    TypeError,
  )
  expect(() => Reflect.apply(revalidate, undefined, [[], 1, { tags: "x" }])).toThrow(TypeError)
})

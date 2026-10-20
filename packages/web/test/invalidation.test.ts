import { expect, spyOn, test } from "bun:test"
import {
  type InvalidationOp,
  type InvalidationTargets,
  logInvalidation,
  runInvalidation,
  settleInvalidation,
} from "../src/internal/invalidation.ts"
import { MemoryCacheStore } from "../src/isr.ts"

const op: InvalidationOp = {
  id: "op-1",
  paths: ["/posts/1"],
  tags: ["posts"],
  keys: ["post:1"],
}
const req = new Request("https://app.test/posts/1", { method: "POST" })

/** Targets that record every call in order; `fail` names the stages that throw. */
function recording(fail: Partial<Record<string, number>> = {}) {
  const calls: string[] = []
  const failures = { ...fail }
  const maybeFail = (stage: string): void => {
    const left = failures[stage] ?? 0
    if (left > 0) {
      failures[stage] = left - 1
      throw new Error(`${stage} down`)
    }
  }
  const store = new MemoryCacheStore()
  const targets: InvalidationTargets = {
    dataCaches: [
      {
        invalidateTag: async (tag: string) => {
          calls.push(`data:${tag}`)
          maybeFail("data")
        },
      },
    ],
    store: {
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
      delete: async (key) => {
        calls.push(`delete:${key}`)
        maybeFail("pages")
      },
      invalidateTag: async (tag) => {
        calls.push(`pageTag:${tag}`)
      },
    },
    keyOf: (path, request) => `${new URL(request.url).origin}${path}`,
    publish: async (keys) => {
      calls.push(`publish:${keys.join(",")}`)
      maybeFail("publish")
    },
    cdn: {
      purge: async (target) => {
        calls.push(`cdn:${target.paths?.join(",")}|${target.tags?.join(",")}`)
        if ((failures.cdn ?? 0) > 0) {
          failures.cdn = (failures.cdn ?? 1) - 1
          return { cdn: "failed", retryable: true, error: "rate_limited" }
        }
        return { cdn: "accepted", retryable: false }
      },
    },
  }
  return { calls, targets }
}

/** A clock that only moves when the pipeline sleeps. */
function virtualClock() {
  let now = 0
  const slept: number[] = []
  return {
    slept,
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        slept.push(ms)
        now += ms
      },
    },
  }
}

test("stages run in order: data caches, page store, publish, CDN", async () => {
  const { calls, targets } = recording()
  const report = await runInvalidation(op, targets, req, undefined)
  expect(calls).toEqual([
    "data:posts",
    "delete:https://app.test/posts/1",
    "pageTag:posts",
    "publish:post:1,posts",
    "cdn:/posts/1|posts",
  ])
  expect(report).toEqual({
    id: "op-1",
    ok: true,
    stages: [
      { stage: "data", ok: true, retryable: false },
      { stage: "pages", ok: true, retryable: false },
      { stage: "publish", ok: true, retryable: false },
      { stage: "cdn", ok: true, retryable: false },
    ],
  })
})

test("a data cache failure stops before the page store and the publish", async () => {
  const { calls, targets } = recording({ data: 1 })
  const report = await runInvalidation(op, targets, req, undefined)
  expect(calls).toEqual(["data:posts"])
  expect(report.stages).toEqual([
    { stage: "data", ok: false, retryable: true, error: "data_failed" },
  ])
})

test("a page store failure stops before the publish", async () => {
  const { calls, targets } = recording({ pages: 1 })
  const report = await runInvalidation(op, targets, req, undefined)
  expect(calls).toEqual(["data:posts", "delete:https://app.test/posts/1"])
  expect(report.stages.at(-1)).toEqual({
    stage: "pages",
    ok: false,
    retryable: true,
    error: "pages_failed",
  })
})

test("a store without tag invalidation fails the page stage for good", async () => {
  const { calls, targets } = recording()
  const report = await runInvalidation(
    op,
    {
      ...targets,
      store: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    },
    req,
    undefined,
  )
  expect(report.stages.at(-1)).toEqual({
    stage: "pages",
    ok: false,
    retryable: false,
    error: "tag_invalidation_not_supported",
  })
  expect(calls.some((call) => call.startsWith("publish"))).toBe(false)
})

test("a publish failure still purges the CDN; the retry repeats from the publish", async () => {
  const { calls, targets } = recording({ publish: 1 })
  const { clock, slept } = virtualClock()
  const report = await settleInvalidation(op, targets, req, undefined, { clock })
  expect(report.ok).toBe(true)
  expect(slept).toEqual([200])
  expect(calls).toEqual([
    "data:posts",
    "delete:https://app.test/posts/1",
    "pageTag:posts",
    "publish:post:1,posts",
    "cdn:/posts/1|posts",
    "publish:post:1,posts",
    "cdn:/posts/1|posts",
  ])
})

test("inline retries stop at the 2 s deadline and report once, naming only the op and stage", async () => {
  const { targets } = recording({ data: 10 })
  const { clock, slept } = virtualClock()
  const reports: unknown[] = []
  const report = await settleInvalidation(op, targets, req, undefined, {
    clock,
    onError: (value) => reports.push(value),
  })
  expect(slept).toEqual([200, 600])
  expect(report.ok).toBe(false)
  expect(reports).toEqual([report])
  const error = spyOn(console, "error").mockImplementation(() => {})
  try {
    logInvalidation(report)
    const line = String(error.mock.calls[0]?.[0])
    expect(line).toContain("op-1")
    expect(line).toContain("data")
    for (const secret of ["post:1", "/posts/1", "posts"]) {
      expect(line.replace("data stage", "").includes(secret)).toBe(false)
    }
  } finally {
    error.mockRestore()
  }
})

test("with waitUntil the retries run behind the response", async () => {
  const { calls, targets } = recording({ cdn: 2 })
  const { clock, slept } = virtualClock()
  const background: Promise<unknown>[] = []
  const first = await settleInvalidation(
    op,
    targets,
    req,
    { waitUntil: (promise) => background.push(promise) },
    { clock },
  )
  expect(first.ok).toBe(false)
  expect(background.length).toBe(1)
  const later = await background[0]
  expect(later).toMatchObject({ ok: true })
  expect(slept).toEqual([200, 600])
  expect(calls.filter((call) => call.startsWith("cdn")).length).toBe(3)
})

test("a non-retryable failure is reported at once, without a retry", async () => {
  const { targets } = recording()
  const { clock, slept } = virtualClock()
  const reports: unknown[] = []
  await settleInvalidation(
    op,
    { ...targets, cdn: { purge: async () => ({ cdn: "failed", retryable: false }) } },
    req,
    undefined,
    { clock, onError: (value) => reports.push(value) },
  )
  expect(slept).toEqual([])
  expect(reports.length).toBe(1)
})

test("a reporter that throws never reaches the caller", async () => {
  const { targets } = recording({ data: 10 })
  const { clock } = virtualClock()
  const report = await settleInvalidation(op, targets, req, undefined, {
    clock,
    onError: () => {
      throw new Error("reporter down")
    },
  })
  expect(report.ok).toBe(false)
})

test("empty stages are skipped", async () => {
  const { calls, targets } = recording()
  const report = await runInvalidation(
    { id: "op-2", paths: [], tags: [], keys: ["post:1"] },
    targets,
    req,
    undefined,
  )
  expect(calls).toEqual(["publish:post:1"])
  expect(report.stages.map((stage) => stage.stage)).toEqual(["publish"])
})

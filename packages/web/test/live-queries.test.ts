/** The live-query registry on its own: who hears a change, what re-tracking does, and sharing across copies. */
import { expect, test } from "bun:test"
import {
  type LiveQuery,
  liveQueries,
  liveTick,
  registeredAt,
  watchLiveQueries,
} from "../src/internal/live-queries.ts"
import { querySeam } from "../src/internal/query-seam.ts"

const liveQuery = (keys: readonly string[] = ["posts"]): LiveQuery => ({
  keys: () => keys,
  tick: () => 0,
  refresh() {},
})

const seam = () => {
  const installed = querySeam()
  if (installed === undefined) throw new Error("importing live-queries installs the seam")
  return installed
}

test("a stopped watcher hears nothing more, and tracking a mounted query twice registers it once", () => {
  let heard = 0
  const stop = watchLiveQueries(() => {
    heard++
  })
  const query = liveQuery()
  const before = liveTick()

  seam().track(query, true)
  expect(heard).toBe(1)
  expect(registeredAt(query)).toBe(before + 1)

  seam().track(query, true)
  expect(heard).toBe(1)
  expect(liveTick()).toBe(before + 1)
  expect(registeredAt(query)).toBe(before + 1)

  stop()
  seam().track(query, false)
  expect(heard).toBe(1)
  expect([...liveQueries()]).not.toContain(query)
  expect(registeredAt(query)).toBeUndefined()
})

test("a query with no live keys is not watched, and leaving unwatched changes nothing", () => {
  let heard = 0
  const stop = watchLiveQueries(() => {
    heard++
  })
  const silent = liveQuery([])
  seam().track(silent, true)
  seam().track(silent, false)
  stop()
  expect(heard).toBe(0)
  expect([...liveQueries()]).not.toContain(silent)
})

test("a second copy of the module reads and writes the first copy's registry", async () => {
  const copy: typeof import("../src/internal/live-queries.ts") = await import(
    `../src/internal/live-queries.ts?copy=${Date.now()}`
  )
  const query = liveQuery(["comments"])
  seam().track(query, true)
  try {
    expect([...copy.liveQueries()]).toContain(query)
    expect(copy.registeredAt(query)).toBe(registeredAt(query))
    expect(copy.advanceLiveTick()).toBe(liveTick())
  } finally {
    seam().track(query, false)
  }
})

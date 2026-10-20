import { describe, expect, test } from "bun:test"
import { owned } from "../src/internal/island-owner.ts"
import { effect, resource, signal } from "../src/islands.ts"

// A fetcher whose calls resolve or reject only when the test says so.
function gated<T>() {
  const calls: Array<{
    key: string
    abort: AbortSignal
    resolve: (value: T) => void
    reject: (error: unknown) => void
  }> = []
  const fetcher = (key: string, abort: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      calls.push({ key, abort, resolve, reject })
    })
  return { calls, fetcher }
}
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe("resource", () => {
  test("fetches the source's key and moves pending -> ready", async () => {
    const q = signal("a")
    const { calls, fetcher } = gated<string>()
    const r = resource(q, fetcher)
    expect(r().status).toBe("pending")
    expect(calls.map((c) => c.key)).toEqual(["a"])
    calls[0]?.resolve("A")
    await settle()
    expect(r()).toEqual({ status: "ready", value: "A", error: undefined })
  })

  test("a newer key aborts the older fetch and the older result never lands", async () => {
    const q = signal("a")
    const { calls, fetcher } = gated<string>()
    const r = resource(q, fetcher)
    q.set("ab")
    expect(calls[0]?.abort.aborted).toBe(true)
    calls[1]?.resolve("AB")
    calls[0]?.resolve("A late")
    await settle()
    expect(r().value).toBe("AB")
  })

  test("a rejection is an error state; an aborted or superseded one is not", async () => {
    const q = signal("a")
    const { calls, fetcher } = gated<string>()
    const r = resource(q, fetcher)
    q.set("b")
    calls[0]?.reject(new Error("aborted"))
    await settle()
    expect(r().status).toBe("pending")
    calls[1]?.reject(new Error("boom"))
    await settle()
    expect(r().status).toBe("error")
    expect(r().error).toEqual(new Error("boom"))
  })

  test("a fetcher that throws synchronously is an error state, not a thrown write", async () => {
    const r = resource(
      () => 1,
      (): Promise<number> => {
        throw new Error("sync")
      },
    )
    await settle()
    expect(r().status).toBe("error")
  })

  test("reads inside the fetcher, before or after an await, are not dependencies", async () => {
    const q = signal("a")
    const other = signal(0)
    let fetches = 0
    resource(q, async (key) => {
      fetches++
      other()
      await settle()
      other()
      return key
    })
    await settle()
    other.set(1)
    expect(fetches).toBe(1)
    q.set("b")
    expect(fetches).toBe(2)
  })

  test("refetch fetches the current key again", () => {
    const { calls, fetcher } = gated<string>()
    const r = resource(() => "k", fetcher)
    r.refetch()
    expect(calls.map((c) => c.key)).toEqual(["k", "k"])
    expect(calls[0]?.abort.aborted).toBe(true)
  })

  test("an effect reading the resource re-runs as its state changes", async () => {
    const { calls, fetcher } = gated<string>()
    const r = resource(() => "k", fetcher)
    const seen: string[] = []
    effect(() => {
      seen.push(r().status)
    })
    calls[0]?.resolve("v")
    await settle()
    expect(seen).toEqual(["pending", "ready"])
  })

  test("dispose aborts the request in flight, drops its result and stops refetching", async () => {
    const q = signal("a")
    const { calls, fetcher } = gated<string>()
    const r = resource(q, fetcher)
    r.dispose()
    expect(calls[0]?.abort.aborted).toBe(true)
    calls[0]?.resolve("late")
    await settle()
    expect(r().status).toBe("pending")
    q.set("b")
    expect(calls).toHaveLength(1)
  })

  test("created inside an island, it is disposed when the island unmounts", async () => {
    const q = signal("a")
    const { calls, fetcher } = gated<string>()
    const island: Array<() => void> = []
    const r = owned(island, () => resource(q, fetcher))
    for (const stop of island) stop()
    expect(calls[0]?.abort.aborted).toBe(true)
    calls[0]?.resolve("late")
    await settle()
    expect(r().status).toBe("pending")
    q.set("b")
    expect(calls).toHaveLength(1)
  })
})

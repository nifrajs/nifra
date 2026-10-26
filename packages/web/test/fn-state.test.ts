import { describe, expect, test } from "bun:test"
import { createServerFnStore, idleServerFnState } from "../src/fn-state.ts"

/**
 * The state machine five adapters share. The two cases worth the most here are the ones that only
 * misbehave under timing: a stale response overwriting a fresh one, and a snapshot whose identity
 * changes when nothing did.
 */

/** A deferred, so a test can decide the order two in-flight calls resolve in. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("snapshot identity", () => {
  test("is stable while nothing changes", () => {
    // A fresh object per call is an infinite render loop under `useSyncExternalStore`, so this is not
    // a micro-optimisation - it is the contract every binding depends on.
    const store = createServerFnStore(async () => 1)
    expect(store.snapshot()).toBe(store.snapshot())
  })

  test("starts idle, and idle is shared by reference across stores", () => {
    // The server render and the first client render must agree, or hydration reports a mismatch.
    const a = createServerFnStore(async () => 1)
    const b = createServerFnStore(async () => 2)
    expect(a.snapshot()).toBe(b.snapshot())
    expect(a.snapshot()).toEqual({ pending: false, data: undefined, error: undefined })
    expect(idleServerFnState()).toBe(a.snapshot())
  })
})

describe("a successful call", () => {
  test("goes pending, then settles with the data", async () => {
    const gate = deferred<string>()
    const store = createServerFnStore(() => gate.promise)
    const seen: boolean[] = []
    store.subscribe(() => seen.push(store.snapshot().pending))

    const call = store.call(undefined)
    expect(store.snapshot().pending).toBe(true)
    gate.resolve("ok")
    await expect(call).resolves.toBe("ok")

    expect(store.snapshot()).toEqual({ pending: false, data: "ok", error: undefined })
    expect(seen).toEqual([true, false])
  })

  test("keeps the previous data while the next call is in flight", async () => {
    // Dropping it would blank a rendered list on every refetch.
    let n = 0
    const gates = [deferred<number>(), deferred<number>()]
    const store = createServerFnStore(() => gates[n++]!.promise)

    const first = store.call(undefined)
    gates[0]!.resolve(1)
    await first
    expect(store.snapshot().data).toBe(1)

    void store.call(undefined).catch(() => {})
    expect(store.snapshot()).toMatchObject({ pending: true, data: 1 })
  })
})

describe("a failing call", () => {
  test("records the error AND rejects, so both styles of caller work", async () => {
    const store = createServerFnStore(async () => {
      throw new Error("boom")
    })
    await expect(store.call(undefined)).rejects.toThrow("boom")
    expect(store.snapshot().error?.message).toBe("boom")
    expect(store.snapshot().pending).toBe(false)
  })

  test("a non-Error rejection is still surfaced as an Error", async () => {
    const store = createServerFnStore(async () => {
      throw "just a string"
    })
    await expect(store.call(undefined)).rejects.toThrow("just a string")
    expect(store.snapshot().error).toBeInstanceOf(Error)
  })

  test("a later success clears the error", async () => {
    let fail = true
    const store = createServerFnStore(async () => {
      if (fail) throw new Error("boom")
      return "fine"
    })
    await store.call(undefined).catch(() => {})
    expect(store.snapshot().error).toBeDefined()
    fail = false
    await store.call(undefined)
    expect(store.snapshot()).toEqual({ pending: false, data: "fine", error: undefined })
  })
})

describe("concurrent calls", () => {
  test("a slow first response cannot overwrite a fast second one", async () => {
    // The out-of-order bug: it only appears when responses race, which is to say in production.
    const gates = [deferred<string>(), deferred<string>()]
    let n = 0
    const store = createServerFnStore(() => gates[n++]!.promise)

    const first = store.call(undefined)
    const second = store.call(undefined)
    gates[1]!.resolve("second")
    await second
    expect(store.snapshot().data).toBe("second")

    gates[0]!.resolve("first") // lands late, and is no longer the newest
    await first
    expect(store.snapshot().data).toBe("second")
    expect(store.snapshot().pending).toBe(false)
  })

  test("a stale failure cannot clobber a newer success", async () => {
    const gates = [deferred<string>(), deferred<string>()]
    let n = 0
    const store = createServerFnStore(() => gates[n++]!.promise)

    const first = store.call(undefined)
    const second = store.call(undefined)
    gates[1]!.resolve("second")
    await second

    gates[0]!.reject(new Error("stale boom"))
    await first.catch(() => {})
    expect(store.snapshot().error).toBeUndefined()
    expect(store.snapshot().data).toBe("second")
  })
})

describe("reset", () => {
  test("returns to idle", async () => {
    const store = createServerFnStore(async () => "x")
    await store.call(undefined)
    store.reset()
    expect(store.snapshot()).toBe(idleServerFnState())
  })

  test("an in-flight call cannot resurrect the state reset discarded", async () => {
    const gate = deferred<string>()
    const store = createServerFnStore(() => gate.promise)
    const call = store.call(undefined)
    store.reset()
    gate.resolve("late")
    await call
    expect(store.snapshot()).toBe(idleServerFnState())
  })
})

describe("subscribe", () => {
  test("unsubscribing stops notifications", async () => {
    const store = createServerFnStore(async () => 1)
    let count = 0
    const off = store.subscribe(() => {
      count += 1
    })
    await store.call(undefined)
    const afterFirst = count
    off()
    await store.call(undefined)
    expect(count).toBe(afterFirst)
  })
})

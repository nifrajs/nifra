/**
 * What a visitor change does to the query layer: another tab's sign-out, a mutation still running, the
 * handles a page keeps, and the cost of reading a cached key on every render.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { IDENTITY_CHANNEL, identityChanged, onIdentityChange } from "../src/identity.ts"
import {
  createMutation,
  createQueryClient,
  MutationCancelledError,
  type MutationHandle,
} from "../src/query.ts"

let hadWindow = false
beforeEach(() => {
  hadWindow = Reflect.has(globalThis, "window")
  if (!hadWindow) Reflect.set(globalThis, "window", globalThis)
})
afterEach(() => {
  if (!hadWindow) Reflect.deleteProperty(globalThis, "window")
})

const listenerCount = (): number => {
  const slot: unknown = Reflect.get(globalThis, Symbol.for("nifra.identity.listeners"))
  return slot instanceof Set ? slot.size : 0
}
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const never = (): Promise<never> => new Promise<never>(() => {})
const gate = () => {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

interface TabReport {
  readonly profile: string | null
  readonly heard: number
}

/** A worker is a second tab: its own globals and identity module, the same channel name. */
async function otherTab(): Promise<{
  readonly report: () => Promise<TabReport>
  readonly change: () => void
  readonly close: () => void
}> {
  const worker = new Worker(new URL("./identity-tab-worker.ts", import.meta.url).href)
  await new Promise<void>((resolve, reject) => {
    worker.onmessage = () => resolve()
    worker.onerror = (event) => reject(new Error(event.message))
  })
  return {
    report: () =>
      new Promise<TabReport>((resolve) => {
        worker.onmessage = (event: MessageEvent<TabReport>) => resolve(event.data)
        worker.postMessage("report")
      }),
    change: () => worker.postMessage("change"),
    close: () => worker.terminate(),
  }
}

async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!(await done())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the other tab")
    await pause(5)
  }
}

describe("a visitor change in another tab", () => {
  test("clears this tab's query data once, and this tab's change clears the other's, with no echo", async () => {
    const tab = await otherTab()
    const client = createQueryClient({ now: () => 0 })
    client.setQueryData(["profile"], "previous visitor")
    let heard = 0
    const probe = new BroadcastChannel(IDENTITY_CHANNEL)
    probe.onmessage = () => {
      heard++
    }
    try {
      identityChanged()
      expect(client.getQueryData(["profile"])).toBeUndefined()
      await until(async () => (await tab.report()).profile === null)

      client.setQueryData(["profile"], "next visitor")
      tab.change()
      await until(() => client.getQueryData(["profile"]) === undefined)

      // One message per change on either side (a tab's other channels hear its own post). A tab that
      // rebroadcast what it heard would keep every tab ringing.
      await pause(100)
      expect(heard).toBe(2)
      expect((await tab.report()).heard).toBe(2)
    } finally {
      probe.close()
      tab.close()
    }
  })

  test("ignores a message that is not the identity signal", async () => {
    const client = createQueryClient({ now: () => 0 })
    client.setQueryData(["profile"], "kept")
    const sender = new BroadcastChannel(IDENTITY_CHANNEL)
    try {
      for (const data of ["change", "changed ", { type: "changed" }, 1, null, ["changed"]])
        sender.postMessage(data)
      sender.postMessage("changed")
      await until(() => client.getQueryData(["profile"]) === undefined)
      client.setQueryData(["profile"], "kept")
      for (const data of ["change", "CHANGED", { type: "changed" }, 1, null, ["changed"]])
        sender.postMessage(data)
      await pause(50)
      expect(client.getQueryData(["profile"])).toBe("kept")
    } finally {
      sender.close()
    }
  })

  test("a listener that throws neither blocks the others nor the broadcast", async () => {
    const reached: string[] = []
    const deferred: Array<() => void> = []
    const queueMicrotaskBefore = globalThis.queueMicrotask
    globalThis.queueMicrotask = (callback) => void deferred.push(callback)
    const offs = [
      onIdentityChange(() => reached.push("first")),
      onIdentityChange(() => {
        throw new Error("broken observer")
      }),
      onIdentityChange(() => reached.push("last")),
    ]
    const probe = new BroadcastChannel(IDENTITY_CHANNEL)
    let heard = 0
    probe.onmessage = () => {
      heard++
    }
    try {
      identityChanged()
      globalThis.queueMicrotask = queueMicrotaskBefore
      expect(reached).toEqual(["first", "last"])
      await until(() => heard === 1)
      const thrown: unknown[] = []
      for (const callback of deferred) {
        try {
          callback()
        } catch (error) {
          thrown.push(error)
        }
      }
      expect(thrown).toHaveLength(1)
      expect(thrown[0]).toBeInstanceOf(AggregateError)
      expect(Reflect.get(thrown[0] ?? {}, "errors")).toHaveLength(1)
    } finally {
      globalThis.queueMicrotask = queueMicrotaskBefore
      probe.close()
      for (const off of offs) off()
    }
  })
})

describe("a mutation across a visitor change", () => {
  test("is cancelled after its component unmounts, and never writes the previous visitor's answer back", async () => {
    const client = createQueryClient({ now: () => 0 })
    client.setQueryData(["profile"], "previous visitor")
    const events: string[] = []
    let answer!: (value: string) => void
    const mutation = createMutation(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve
        }),
      {
        onSuccess: (data) => {
          events.push("success")
          client.setQueryData(["profile"], data)
        },
        onSettled: () => {
          events.push("settled")
        },
      },
    )
    const unmount = mutation.subscribe(() => {})
    const pending = mutation.mutate(undefined)
    unmount()

    identityChanged()
    answer("previous visitor, saved")
    await expect(pending).rejects.toBeInstanceOf(MutationCancelledError)
    await flush()
    expect(events).toEqual([])
    expect(client.getQueryData(["profile"])).toBeUndefined()
    expect(mutation.snapshot().status).toBe("idle")
  })

  test("stops before the write when the change lands inside an async onMutate", async () => {
    const hold = gate()
    let ran = false
    let seen: boolean | undefined
    const mutation = createMutation(
      async () => {
        ran = true
        return 1
      },
      {
        onMutate: async (_variables, context) => {
          await hold.opened
          seen = context.signal.aborted
        },
      },
    )
    const pending = mutation.mutate(undefined)
    void pending.catch(() => {})
    identityChanged()
    hold.open()
    await expect(pending).rejects.toBeInstanceOf(MutationCancelledError)
    await flush()
    expect(seen).toBe(true)
    expect(ran).toBe(false)
  })

  test("rejects at once when an async onSuccess is already running, and tells it to stop", async () => {
    const hold = gate()
    let sawAbort: boolean | undefined
    let wrote = false
    const mutation = createMutation(async () => "saved", {
      onSuccess: async (_data, _variables, context) => {
        await hold.opened
        sawAbort = context.signal.aborted
        if (!context.signal.aborted) wrote = true
      },
    })
    const pending = mutation.mutate(undefined)
    void pending.catch(() => {})
    await flush()
    identityChanged()
    await expect(pending).rejects.toBeInstanceOf(MutationCancelledError)
    hold.open()
    await flush()
    expect(sawAbort).toBe(true)
    expect(wrote).toBe(false)
  })

  test("hands one signal to the function and every callback, and a new one to the next call", async () => {
    const signals: AbortSignal[] = []
    const mutation = createMutation(
      async (_variables: undefined, context) => {
        signals.push(context.signal)
        return 1
      },
      {
        onMutate: (_variables, context) => void signals.push(context.signal),
        onSuccess: (_data, _variables, context) => void signals.push(context.signal),
        onSettled: (_data, _error, _variables, context) => void signals.push(context.signal),
      },
    )
    await mutation.mutate(undefined)
    expect(signals).toHaveLength(4)
    expect(new Set(signals).size).toBe(1)
    await mutation.mutate(undefined)
    expect(new Set(signals).size).toBe(2)
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
  })

  test("cancel() settles every pending call, leaves the handle reusable, and is harmless when idle", async () => {
    const mutation = createMutation(
      (variables: number) => (variables === 0 ? never() : Promise.resolve(variables)),
      {},
    )
    let notified = 0
    mutation.subscribe(() => notified++)
    mutation.cancel()
    expect(mutation.snapshot().status).toBe("idle")

    const calls = [mutation.mutate(0), mutation.mutate(0)]
    mutation.cancel()
    for (const outcome of await Promise.allSettled(calls)) {
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: expect.any(MutationCancelledError),
      })
    }
    expect(mutation.snapshot().status).toBe("idle")

    await expect(mutation.mutate(7)).resolves.toBe(7)
    expect(mutation.snapshot()).toMatchObject({ status: "success", data: 7 })
    expect(notified).toBeGreaterThan(0)
  })

  test("a result that lands after reset() does not bring the state back", async () => {
    const hold = gate()
    const mutation = createMutation(async () => {
      await hold.opened
      return "late"
    }, {})
    const pending = mutation.mutate(undefined)
    mutation.reset()
    hold.open()
    await expect(pending).resolves.toBe("late")
    expect(mutation.snapshot().status).toBe("idle")
  })

  test("holds an identity listener only while a call is in flight, however it ends", async () => {
    const base = listenerCount()

    const ok = createMutation(async () => 1, {})
    const during = ok.mutate(undefined)
    expect(listenerCount()).toBe(base + 1)
    await during
    expect(listenerCount()).toBe(base)

    const rejecting = createMutation(async () => {
      throw new Error("no")
    }, {})
    await expect(rejecting.mutate(undefined)).rejects.toThrow("no")
    expect(listenerCount()).toBe(base)

    const syncThrow = createMutation((): Promise<number> => {
      throw new Error("sync")
    }, {})
    await expect(syncThrow.mutate(undefined)).rejects.toThrow("sync")
    expect(listenerCount()).toBe(base)

    // A request that never answers must not pin the handle or its callbacks to the page.
    const cancelled = Array.from({ length: 25 }, () => createMutation(never, {}))
    const calls = cancelled.map((mutation) => mutation.mutate(undefined))
    for (const call of calls) void call.catch(() => {})
    expect(listenerCount()).toBe(base + 25)
    for (const mutation of cancelled.slice(0, 10)) mutation.cancel()
    expect(listenerCount()).toBe(base + 15)
    identityChanged()
    expect(listenerCount()).toBe(base)
    for (const call of calls) await expect(call).rejects.toBeInstanceOf(MutationCancelledError)

    const overlapping = createMutation(never, {})
    const a = overlapping.mutate(undefined)
    const b = overlapping.mutate(undefined)
    void a.catch(() => {})
    void b.catch(() => {})
    expect(listenerCount()).toBe(base + 1)
    overlapping.cancel()
    expect(listenerCount()).toBe(base)
  })

  test("watches nothing on a server, where no visitor changes under it", async () => {
    Reflect.deleteProperty(globalThis, "window")
    try {
      const base = listenerCount()
      const mutation = createMutation(never, {})
      void mutation.mutate(undefined).catch(() => {})
      expect(listenerCount()).toBe(base)
      mutation.cancel()
    } finally {
      Reflect.set(globalThis, "window", globalThis)
    }
  })
})

describe("reading a cached query on every render", () => {
  test("walks no cache and hashes the key once", () => {
    let clock = 0
    let nowCalls = 0
    const client = createQueryClient({
      now: () => {
        nowCalls++
        return clock
      },
    })
    for (let i = 0; i < 50; i++) client.setQueryData(["other", i], i)
    let hashes = 0
    const key = {
      toJSON() {
        hashes++
        return ["todos", 1]
      },
    }
    const first = client.query(key, async () => 1)
    first.subscribe(() => {})
    nowCalls = 0
    hashes = 0

    // A walk over a cache starts an iterator on its Map: count those.
    let walks = 0
    const iterator = Map.prototype[Symbol.iterator]
    Map.prototype[Symbol.iterator] = function (this: Map<unknown, unknown>) {
      walks++
      return iterator.call(this)
    }
    try {
      for (let i = 0; i < 25; i++) expect(client.query(key, async () => 1)).toBe(first)
    } finally {
      Map.prototype[Symbol.iterator] = iterator
    }
    expect(walks).toBe(0)
    expect(hashes).toBe(25)
    expect(nowCalls).toBeLessThanOrEqual(25)
    clock++
  })

  test("sweeps on the first read after a timer elapses, and when a cache is over its cap", () => {
    let clock = 0
    const client = createQueryClient({ now: () => clock, gcTime: 100, max: 3 })
    const expiring = client.query(["expiring"], async () => 1)
    expiring.subscribe(() => {})()
    client.setQueryData(["expiring"], "old")
    const live = client.query(["live"], async () => 1)
    live.subscribe(() => {})

    clock = 99
    client.query(["live"], async () => 1)
    expect(client.getQueryData(["expiring"])).toBe("old")
    clock = 100
    client.query(["live"], async () => 1)
    expect(client.getQueryData(["expiring"])).toBeUndefined()

    // Entries made by writes are never swept until a read finds the cache over its cap.
    for (const id of ["a", "b", "c", "d", "e"]) client.setQueryData([id], id)
    client.query(["live"], async () => 1)
    const kept = ["a", "b", "c", "d", "e"].filter((id) => client.getQueryData([id]) !== undefined)
    expect(kept.length + 1).toBeLessThanOrEqual(3)
  })

  test("a timer a resubscribe cancelled costs one extra walk, not a missed one", () => {
    let clock = 0
    const client = createQueryClient({ now: () => clock, gcTime: 100 })
    const kept = client.query(["kept"], async () => 1)
    kept.subscribe(() => {})()
    const off = kept.subscribe(() => {})
    clock = 500
    client.query(["kept"], async () => 1)
    expect(client.query(["kept"], async () => 1)).toBe(kept)
    off()
    const other = client.query(["other"], async () => 1)
    other.subscribe(() => {})()
    clock = 700
    expect(client.query(["kept"], async () => 1)).not.toBe(kept)
  })

  test("an expired key read again starts over instead of serving what was evicted", async () => {
    let clock = 0
    let calls = 0
    const client = createQueryClient({ now: () => clock, gcTime: 100 })
    const fn = async () => ++calls
    const first = client.query(["k"], fn)
    await first.fetch()
    first.subscribe(() => {})()
    clock = 500
    const again = client.query(["k"], fn)
    expect(again).not.toBe(first)
    expect(again.snapshot().status).toBe("pending")
    await again.fetch()
    expect(calls).toBe(2)
  })
})

describe("dehydrate with a filter", () => {
  test("offers only successful queries, and a throwing filter leaves the client usable", async () => {
    const client = createQueryClient({ now: () => 5 })
    await client.prefetchQuery(["ok"], async () => "value")
    client.query(["pending"], async () => "never fetched")
    await client
      .prefetchQuery(["failed"], async () => Promise.reject(new Error("no")))
      .catch(() => {})

    const everything = { shouldDehydrateQuery: () => true }
    const offered: unknown[] = []
    const state = client.dehydrate({
      shouldDehydrateQuery: ({ key }) => {
        offered.push(key)
        return true
      },
    })
    expect(offered).toEqual([["ok"]])
    expect(state.queries).toEqual([{ key: ["ok"], data: "value", updatedAt: 5 }])
    expect(client.dehydrate(everything)).toEqual(state)

    expect(() =>
      client.dehydrate({
        shouldDehydrateQuery: () => {
          throw new Error("filter bug")
        },
      }),
    ).toThrow("filter bug")
    expect(client.dehydrate(everything)).toEqual(state)
  })
})

describe("the page's identity channel", () => {
  const SLOT = Symbol.for("nifra.identity.channel")

  /** Run with the page's channel slot empty and a stand-in `BroadcastChannel`, then put both back. */
  async function withChannel(stub: unknown, run: () => void | Promise<void>): Promise<void> {
    const slot: unknown = Reflect.get(globalThis, SLOT)
    const real: unknown = Reflect.get(globalThis, "BroadcastChannel")
    Reflect.deleteProperty(globalThis, SLOT)
    Reflect.set(globalThis, "BroadcastChannel", stub)
    try {
      await run()
    } finally {
      Reflect.deleteProperty(globalThis, SLOT)
      Reflect.set(globalThis, "BroadcastChannel", real)
      if (slot !== undefined) Reflect.set(globalThis, SLOT, slot)
    }
  }

  test("is made once per page and reused by every listener and every change", async () => {
    let made = 0
    class Counting {
      constructor(readonly name: string) {
        made++
      }
      addEventListener(): void {}
      postMessage(): void {}
      close(): void {}
    }
    await withChannel(Counting, () => {
      const offs = [onIdentityChange(() => {}), onIdentityChange(() => {})]
      identityChanged()
      identityChanged()
      for (const off of offs) off()
      expect(made).toBe(1)
    })
  })

  test("does not keep a process alive when the platform can let it go", async () => {
    let unrefs = 0
    class Unrefable {
      addEventListener(): void {}
      postMessage(): void {}
      close(): void {}
      unref(): void {
        unrefs++
      }
    }
    await withChannel(Unrefable, () => {
      const off = onIdentityChange(() => {})
      identityChanged()
      off()
      expect(unrefs).toBe(1)
    })
  })

  test("is not made, and nothing is posted, where there is no window", async () => {
    let made = 0
    class Counting {
      constructor() {
        made++
      }
      addEventListener(): void {}
      postMessage(): void {
        made += 100
      }
      close(): void {}
    }
    await withChannel(Counting, () => {
      Reflect.deleteProperty(globalThis, "window")
      let heard = 0
      const off = onIdentityChange(() => heard++)
      try {
        identityChanged()
        expect(heard).toBe(1)
        expect(made).toBe(0)
      } finally {
        off()
        Reflect.set(globalThis, "window", globalThis)
      }
    })
  })

  test("a browser that refuses it still gets the local change, and closes what it half made", async () => {
    const made: Array<{ closed: boolean }> = []
    class Refusing {
      closed = false
      constructor() {
        made.push(this)
      }
      addEventListener(): void {
        throw new Error("blocked by policy")
      }
      postMessage(): void {
        throw new Error("never reached")
      }
      close(): void {
        this.closed = true
      }
    }
    await withChannel(Refusing, () => {
      let heard = 0
      const off = onIdentityChange(() => heard++)
      try {
        expect(() => identityChanged()).not.toThrow()
        expect(heard).toBe(1)
        expect(made.length).toBeGreaterThan(0)
        expect(made.every((channel) => channel.closed)).toBe(true)
        expect(Reflect.get(globalThis, SLOT)).toBeUndefined()
      } finally {
        off()
      }
    })
  })

  test("a browser that refuses it and cannot close it still gets the local change", async () => {
    class Stuck {
      addEventListener(): void {
        throw new Error("blocked by policy")
      }
      postMessage(): void {}
      close(): void {
        throw new Error("already torn down")
      }
    }
    await withChannel(Stuck, () => {
      let heard = 0
      const off = onIdentityChange(() => heard++)
      try {
        expect(() => identityChanged()).not.toThrow()
        expect(heard).toBe(1)
      } finally {
        off()
      }
    })
  })

  test("is absent where the platform has no BroadcastChannel", async () => {
    await withChannel(undefined, () => {
      let heard = 0
      const off = onIdentityChange(() => heard++)
      try {
        expect(() => identityChanged()).not.toThrow()
        expect(heard).toBe(1)
      } finally {
        off()
      }
    })
  })
})

describe("a mutation that cancels itself", () => {
  const settle = async (call: Promise<unknown>): Promise<unknown> => {
    try {
      await call
      return undefined
    } catch (error) {
      return error
    }
  }

  test("inside onMutate: the function never runs", async () => {
    let ran = false
    const mutation: MutationHandle<number, undefined> = createMutation(
      async () => {
        ran = true
        return 1
      },
      { onMutate: () => mutation.cancel() },
    )
    expect(await settle(mutation.mutate(undefined))).toBeInstanceOf(MutationCancelledError)
    expect(ran).toBe(false)
    expect(mutation.snapshot().status).toBe("idle")
  })

  test("inside the function: no success state, no onSuccess, no onSettled", async () => {
    const events: string[] = []
    const mutation = createMutation(
      async () => {
        mutation.cancel()
        return 1
      },
      {
        onSuccess: () => void events.push("success"),
        onSettled: () => void events.push("settled"),
      },
    )
    expect(await settle(mutation.mutate(undefined))).toBeInstanceOf(MutationCancelledError)
    expect(events).toEqual([])
    expect(mutation.snapshot().status).toBe("idle")
  })

  test("inside onError: the failure is replaced by the cancellation and onSettled stays quiet", async () => {
    const events: string[] = []
    const mutation = createMutation(
      async () => {
        throw new Error("write failed")
      },
      {
        onError: () => {
          events.push("error")
          mutation.cancel()
        },
        onSettled: () => void events.push("settled"),
      },
    )
    expect(await settle(mutation.mutate(undefined))).toBeInstanceOf(MutationCancelledError)
    expect(events).toEqual(["error"])
  })

  test("inside onSuccess: onSettled stays quiet", async () => {
    const events: string[] = []
    const mutation = createMutation(async () => 1, {
      onSuccess: () => {
        events.push("success")
        mutation.cancel()
      },
      onSettled: () => void events.push("settled"),
    })
    expect(await settle(mutation.mutate(undefined))).toBeInstanceOf(MutationCancelledError)
    expect(events).toEqual(["success"])
  })

  test("inside onSettled, after a success or a failure: the call still ends cancelled", async () => {
    const succeeding: MutationHandle<number, undefined> = createMutation(async () => 1, {
      onSettled: () => succeeding.cancel(),
    })
    expect(await settle(succeeding.mutate(undefined))).toBeInstanceOf(MutationCancelledError)

    const failing: MutationHandle<never, undefined> = createMutation(
      async () => {
        throw new Error("write failed")
      },
      { onSettled: () => failing.cancel() },
    )
    expect(await settle(failing.mutate(undefined))).toBeInstanceOf(MutationCancelledError)
  })

  test("a subscriber that cancels on seeing the error or the success state stops the callbacks", async () => {
    const events: string[] = []
    const failing: MutationHandle<never, undefined> = createMutation(
      async () => {
        throw new Error("write failed")
      },
      {
        onError: () => void events.push("error"),
        onSettled: () => void events.push("settled"),
      },
    )
    failing.subscribe(() => {
      if (failing.snapshot().status === "error") failing.cancel()
    })
    expect(await settle(failing.mutate(undefined))).toBeInstanceOf(MutationCancelledError)

    const succeeding: MutationHandle<number, undefined> = createMutation(async () => 1, {
      onSuccess: () => void events.push("success"),
      onSettled: () => void events.push("settled"),
    })
    succeeding.subscribe(() => {
      if (succeeding.snapshot().status === "success") succeeding.cancel()
    })
    expect(await settle(succeeding.mutate(undefined))).toBeInstanceOf(MutationCancelledError)
    expect(events).toEqual([])
  })

  test("a callback that throws after the failure ends the call with its own error and skips onSettled", async () => {
    const events: string[] = []
    const mutation = createMutation(
      async () => {
        throw new Error("write failed")
      },
      {
        onError: () => {
          events.push("error")
          throw new Error("onError broke")
        },
        onSettled: () => void events.push("settled"),
      },
    )
    await expect(mutation.mutate(undefined)).rejects.toThrow("onError broke")
    expect(events).toEqual(["error"])

    const settling = createMutation(
      async () => {
        throw new Error("write failed")
      },
      {
        onSettled: () => {
          throw new Error("onSettled broke")
        },
      },
    )
    await expect(settling.mutate(undefined)).rejects.toThrow("onSettled broke")
  })

  test("a callback that cancels and then throws still ends the call cancelled", async () => {
    const mutation: MutationHandle<never, undefined> = createMutation(
      async () => {
        throw new Error("write failed")
      },
      {
        onError: () => {
          mutation.cancel()
          throw new Error("onError broke after cancelling")
        },
      },
    )
    expect(await settle(mutation.mutate(undefined))).toBeInstanceOf(MutationCancelledError)
  })

  test("a failure that lands after a newer call succeeded does not replace its state", async () => {
    const hold = gate()
    let calls = 0
    const mutation = createMutation(async () => {
      if (++calls === 1) {
        await hold.opened
        throw new Error("slow failure")
      }
      return "fast success"
    }, {})
    const slow = mutation.mutate(undefined)
    void slow.catch(() => {})
    await mutation.mutate(undefined)
    hold.open()
    await expect(slow).rejects.toThrow("slow failure")
    expect(mutation.snapshot()).toMatchObject({ status: "success", data: "fast success" })
  })

  test("a result that lands after reset() and a newer call does not take over its state", async () => {
    const hold = gate()
    let calls = 0
    const mutation = createMutation(async () => {
      if (++calls === 1) {
        await hold.opened
        return "first, late"
      }
      return never()
    }, {})
    const first = mutation.mutate(undefined)
    mutation.reset()
    const second = mutation.mutate(undefined)
    void second.catch(() => {})
    hold.open()
    await first
    expect(mutation.snapshot().status).toBe("pending")
    mutation.cancel()
  })

  test("keeps watching for the visitor until the last call ends, and again for the next call", async () => {
    const holdA = gate()
    let calls = 0
    const mutation = createMutation(async (_variables: undefined, context) => {
      calls++
      if (calls === 1) {
        await holdA.opened
        return "a"
      }
      return new Promise<string>((_, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("aborted")))
      })
    }, {})
    const base = listenerCount()
    const a = mutation.mutate(undefined)
    const b = mutation.mutate(undefined)
    void b.catch(() => {})
    holdA.open()
    await a
    expect(listenerCount()).toBe(base + 1)
    identityChanged()
    expect(await settle(b)).toBeInstanceOf(MutationCancelledError)
    expect(listenerCount()).toBe(base)

    const c = mutation.mutate(undefined)
    expect(listenerCount()).toBe(base + 1)
    identityChanged()
    expect(await settle(c)).toBeInstanceOf(MutationCancelledError)
  })
})

describe("cache collection", () => {
  test("a timer that is not yet due survives a collection another entry's timer caused", () => {
    let clock = 0
    const client = createQueryClient({ now: () => clock, gcTime: 100 })
    const first = client.query(["first"], async () => 1)
    first.subscribe(() => {})()
    client.setQueryData(["first"], "first")
    clock = 50
    const second = client.query(["second"], async () => 1)
    second.subscribe(() => {})()
    client.setQueryData(["second"], "second")

    clock = 120
    client.query(["probe"], async () => 1)
    expect(client.getQueryData(["first"])).toBeUndefined()
    expect(client.getQueryData(["second"])).toBe("second")

    clock = 149
    client.query(["probe"], async () => 1)
    expect(client.getQueryData(["second"])).toBe("second")
    clock = 150
    client.query(["probe"], async () => 1)
    expect(client.getQueryData(["second"])).toBeUndefined()
  })

  test("after a collection the next one is due at the earliest timer left", () => {
    let clock = 0
    const client = createQueryClient({ now: () => clock, gcTime: 100 })
    const leave = (id: string, at: number): void => {
      clock = at
      const handle = client.query([id], async () => 1)
      handle.subscribe(() => {})()
      client.setQueryData([id], id)
    }
    leave("first", 0) // due at 100
    leave("second", 10) // due at 110
    leave("third", 60) // due at 160

    clock = 100
    client.query(["probe"], async () => 1)
    expect(client.getQueryData(["first"])).toBeUndefined()
    expect(client.getQueryData(["second"])).toBe("second")

    clock = 115
    client.query(["probe"], async () => 1)
    expect(client.getQueryData(["second"])).toBeUndefined()
    expect(client.getQueryData(["third"])).toBe("third")
  })

  test("a cache holding exactly its cap, of either kind, is never walked on a read", () => {
    const client = createQueryClient({ now: () => 0, max: 3 })
    for (const id of ["a", "b", "c"]) client.setQueryData([id], id)
    const open = { initialPageParam: 0, getNextPageParam: () => undefined }
    const feed = client.infiniteQuery(["feed"], async (page: number) => page, open)
    client.infiniteQuery(["feed", 2], async (page: number) => page, open)
    client.infiniteQuery(["feed", 3], async (page: number) => page, open)

    let walks = 0
    const iterator = Map.prototype[Symbol.iterator]
    Map.prototype[Symbol.iterator] = function (this: Map<unknown, unknown>) {
      walks++
      return iterator.call(this)
    }
    try {
      for (let i = 0; i < 10; i++) {
        client.query(["a"], async () => 1)
        client.infiniteQuery(["feed"], async (page: number) => page, {
          initialPageParam: 0,
          getNextPageParam: () => undefined,
        })
      }
    } finally {
      Map.prototype[Symbol.iterator] = iterator
    }
    expect(walks).toBe(0)
    expect(feed).toBe(
      client.infiniteQuery(["feed"], async (page: number) => page, {
        initialPageParam: 0,
        getNextPageParam: () => undefined,
      }),
    )
  })

  test("a paged query's expired timer is collected on the first read after it", async () => {
    let clock = 0
    const client = createQueryClient({ now: () => clock, gcTime: 100 })
    const open = {
      initialPageParam: 0,
      getNextPageParam: () => undefined,
    }
    const feed = client.infiniteQuery(["feed"], async (page: number) => page, open)
    await feed.fetch()
    feed.subscribe(() => {})()
    clock = 99
    expect(client.infiniteQuery(["feed"], async (page: number) => page, open)).toBe(feed)
    clock = 100
    expect(client.infiniteQuery(["feed"], async (page: number) => page, open)).not.toBe(feed)
  })
})

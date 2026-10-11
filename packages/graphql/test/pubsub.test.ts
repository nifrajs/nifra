import { describe, expect, test } from "bun:test"
import { createPubSub, GraphqlPubSubOverflowError } from "../src/index.ts"

describe("bounded reference pubsub", () => {
  test("a slow subscriber closes with a stable overflow error without affecting an active subscriber", async () => {
    const pubsub = createPubSub<number>({ maxQueuedEvents: 2 })
    const slow = pubsub.subscribe("count")
    const active = pubsub.subscribe("count")
    for (let value = 0; value < 3; value++) {
      const pull = active.next()
      pubsub.publish("count", value)
      expect(await pull).toEqual({ value, done: false })
    }
    await expect(slow.next()).rejects.toBeInstanceOf(GraphqlPubSubOverflowError)
    expect(await slow.next()).toEqual({ value: undefined, done: true })
    const later = active.next()
    pubsub.publish("count", 3)
    expect(await later).toEqual({ value: 3, done: false })
    await active.return?.()
  })

  test("the default queue is bounded and publishing a burst never throws", async () => {
    const pubsub = createPubSub<number>()
    const source = pubsub.subscribe("count")
    expect(() => {
      for (let value = 0; value < 100_000; value++) pubsub.publish("count", value)
    }).not.toThrow()
    await expect(source.next()).rejects.toMatchObject({ code: "graphql_pubsub_overflow" })
    expect(await source.next()).toEqual({ value: undefined, done: true })
  })

  for (const overflow of ["drop-oldest", "drop-newest"] as const) {
    test(`${overflow} is an explicit lossy policy with a finite queue`, async () => {
      const pubsub = createPubSub<number>({ maxQueuedEvents: 2, overflow })
      const source = pubsub.subscribe("count")
      for (let value = 0; value < 10; value++) pubsub.publish("count", value)
      const results = [await source.next(), await source.next()]
      expect(results).toEqual(
        (overflow === "drop-oldest" ? [8, 9] : [0, 1]).map((value) => ({ value, done: false })),
      )
      await source.return?.()
      expect(await source.next()).toEqual({ value: undefined, done: true })
    })
  }

  test("return clears already-queued events and settles pending pulls", async () => {
    const pubsub = createPubSub<number>()
    const queued = pubsub.subscribe("count")
    pubsub.publish("count", 1)
    pubsub.publish("count", 2)
    await queued.return?.()
    expect(await queued.next()).toEqual({ value: undefined, done: true })
    const source = pubsub.subscribe("count")
    const pulls = [source.next(), source.next()]
    await source.return?.()
    expect(await Promise.all(pulls)).toEqual([
      { value: undefined, done: true },
      { value: undefined, done: true },
    ])
    pubsub.publish("count", 3)
    expect(await source.next()).toEqual({ value: undefined, done: true })
  })

  test("throw clears queued events and return clears an unread overflow failure", async () => {
    const pubsub = createPubSub<number>({ maxQueuedEvents: 1 })
    const source = pubsub.subscribe("count")
    pubsub.publish("count", 1)
    await expect(source.throw?.(new Error("synthetic stop"))).rejects.toThrow("synthetic stop")
    expect(await source.next()).toEqual({ value: undefined, done: true })
    const overflowed = pubsub.subscribe("count")
    pubsub.publish("count", 1)
    pubsub.publish("count", 2)
    await overflowed.return?.()
    expect(await overflowed.next()).toEqual({ value: undefined, done: true })
  })

  test("undefined is a valid payload and topics are isolated", async () => {
    const pubsub = createPubSub<number | undefined>({ maxQueuedEvents: 1 })
    const source = pubsub.subscribe("a")
    pubsub.publish("b", 1)
    pubsub.publish("a", undefined)
    expect(await source.next()).toEqual({ value: undefined, done: false })
    await source.return?.()
  })

  test("invalid limits and overflow policies fail at configuration time", () => {
    for (const maxQueuedEvents of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createPubSub({ maxQueuedEvents })).toThrow(/maxQueuedEvents/)
    }
    // Exercise runtime input from JS callers without weakening the public option type.
    expect(() => Reflect.apply(createPubSub, undefined, [{ overflow: "unbounded" }])).toThrow(
      /overflow/,
    )
  })
})

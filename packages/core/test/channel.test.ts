import { describe, expect, test } from "bun:test"
import {
  ChannelResumeUnavailableError,
  channelReadableStream,
  defineChannel,
  memoryChannelHub,
} from "../src/channel.ts"

describe("typed channel seam", () => {
  test("validates channel and queue bounds", () => {
    expect(() => defineChannel("bad name")).toThrow(/bounded token/)
    expect(() => memoryChannelHub({ maxQueue: 0 })).toThrow(/positive safe integer/)

    const channel = defineChannel<"bounded", string>("bounded")
    const hub = memoryChannelHub()
    expect(() => hub.subscribe(channel, { maxQueue: 0 })).toThrow(/positive safe integer/)
  })

  test("delivers typed lifecycle events through the in-memory reference hub", async () => {
    const orders = defineChannel<"orders", { readonly id: string }>("orders")
    const hub = memoryChannelHub()
    const subscription = hub.subscribe(orders)

    const published = hub.publish(orders, { id: "order-1" })
    const received = await subscription[Symbol.asyncIterator]().next()

    expect(published.data).toEqual({ id: "order-1" })
    expect(received.done).toBe(false)
    expect(received.value?.data).toEqual({ id: "order-1" })
    expect(subscription.resumeToken).toBe(published.resumeToken)
    subscription.close()
    expect(subscription.closed).toBe(true)
  })

  test("resolves a pending iterator when a publish arrives and supports return()", async () => {
    const channel = defineChannel<"pending", string>("pending")
    const hub = memoryChannelHub()
    const subscription = hub.subscribe(channel)
    const pending = subscription.next()

    hub.publish(channel, "ready")
    expect((await pending).value?.data).toBe("ready")

    const returned = await subscription.return!()
    expect(returned.done).toBe(true)
    expect(subscription.closeReason).toBe("closed")
  })

  test("fails a slow subscriber closed at its bounded queue", () => {
    const channel = defineChannel<"events", string>("events")
    const hub = memoryChannelHub({ maxQueue: 1 })
    const subscription = hub.subscribe(channel)

    hub.publish(channel, "one")
    hub.publish(channel, "two")

    expect(subscription.closed).toBe(true)
    expect(subscription.closeReason).toBe("backpressure")
  })

  test("adapts the subscription to a cancellable stream", async () => {
    const channel = defineChannel<"stream", number>("stream")
    const hub = memoryChannelHub()
    const subscription = hub.subscribe(channel)
    const reader = channelReadableStream(subscription).getReader()
    hub.publish(channel, 3)
    expect((await reader.read()).value?.data).toBe(3)
    await reader.cancel()
    expect(subscription.closed).toBe(true)
  })

  test("closes immediately and does not retain an already-aborted subscription", () => {
    const channel = defineChannel<"aborted", string>("aborted")
    const hub = memoryChannelHub()
    const subscription = hub.subscribe(channel, { signal: AbortSignal.abort() })

    expect(subscription.closed).toBe(true)
    expect(subscription.closeReason).toBe("aborted")
  })

  test("resumes a channel from a cursor using bounded replay history", async () => {
    const channel = defineChannel<"orders", string>("orders")
    const hub = memoryChannelHub({ historySize: 4 })
    const first = hub.publish(channel, "one")
    hub.publish(channel, "two")
    hub.publish(channel, "three")

    const resumed = hub.subscribe(channel, { resumeFrom: first.resumeToken })
    expect((await resumed.next()).value?.data).toBe("two")
    expect((await resumed.next()).value?.data).toBe("three")
    expect(resumed.resumeToken).toBeDefined()
  })

  test("keeps sequence numbers and cursors scoped to each channel", () => {
    const orders = defineChannel<"orders", string>("orders")
    const users = defineChannel<"users", string>("users")
    const hub = memoryChannelHub()

    const orderOne = hub.publish(orders, "one")
    const userOne = hub.publish(users, "one")
    const orderTwo = hub.publish(orders, "two")

    expect(orderOne.sequence).toBe(1)
    expect(userOne.sequence).toBe(1)
    expect(orderTwo.sequence).toBe(2)
    expect(orderOne.resumeToken).not.toBe(userOne.resumeToken)
  })

  test("fails closed when a cursor is no longer retained", () => {
    const channel = defineChannel<"events", string>("events")
    const hub = memoryChannelHub({ historySize: 2 })
    const old = hub.publish(channel, "old")
    hub.publish(channel, "two")
    hub.publish(channel, "three")

    expect(() => hub.subscribe(channel, { resumeFrom: old.resumeToken })).toThrow(
      ChannelResumeUnavailableError,
    )
  })
})

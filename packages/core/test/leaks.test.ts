import { describe, expect, test } from "bun:test"
import { heapGrowth, isReleased } from "@nifrajs/test-utils/leak"
import { channelReadableStream, defineChannel, memoryChannelHub } from "../src/channel.ts"
import { sse } from "../src/server/sse.ts"

/**
 * Lifecycle leaks: what a stream, subscription or channel keeps once its client is gone. Each case
 * outlives its subject on purpose - a connection signal and a hub that stay alive across requests -
 * because a leak here is the long-lived owner still holding the finished one.
 */

const CAP_BYTES_PER_ITERATION = 64

function bodyOf(res: Response): ReadableStream<Uint8Array> {
  if (res.body === null) throw new Error("expected a streaming body")
  return res.body
}

/** A producer that stays pending until the stream ends, holding `marker` the whole time. */
const parked =
  (marker: object) =>
  (stream: { readonly signal: AbortSignal }): Promise<void> =>
    new Promise<void>((resolve) => {
      void marker
      stream.signal.addEventListener("abort", () => resolve(), { once: true })
    })

describe("sse streams are released", () => {
  test("after the producer finishes, with the connection signal still alive", async () => {
    const connection = new AbortController()
    const make = async () => {
      const marker = { bytes: new Uint8Array(4096) }
      const res = sse({ req: new Request("http://x/", { signal: connection.signal }) }, (s) => {
        void marker
        s.send({ data: "hello" })
      })
      await res.text()
      return new WeakRef(marker)
    }
    expect(await isReleased(make)).toBe(true)
    expect(connection.signal.aborted).toBe(false)
  })

  test("after the client cancels the body", async () => {
    const connection = new AbortController()
    const make = async () => {
      const marker = { bytes: new Uint8Array(4096) }
      const res = sse(
        { req: new Request("http://x/", { signal: connection.signal }) },
        parked(marker),
      )
      await bodyOf(res).cancel()
      return new WeakRef(marker)
    }
    expect(await isReleased(make)).toBe(true)
  })

  test("after the request signal aborts", async () => {
    const make = async () => {
      const marker = { bytes: new Uint8Array(4096) }
      const connection = new AbortController()
      const res = sse(
        { req: new Request("http://x/", { signal: connection.signal }) },
        parked(marker),
      )
      const reader = bodyOf(res).getReader()
      connection.abort()
      await reader.read()
      return new WeakRef(marker)
    }
    expect(await isReleased(make)).toBe(true)
  })

  test("after a client that falls too far behind is dropped", async () => {
    const connection = new AbortController()
    const make = async () => {
      const marker = { bytes: new Uint8Array(4096) }
      const res = sse(
        { req: new Request("http://x/", { signal: connection.signal }) },
        (s) => {
          void marker
          s.send({ data: "x".repeat(256) })
          return new Promise<void>((resolve) =>
            s.signal.addEventListener("abort", () => resolve(), { once: true }),
          )
        },
        { maxBufferedBytes: 64 },
      )
      await expect(bodyOf(res).getReader().read()).rejects.toThrow("sse_client_too_slow")
      return new WeakRef(marker)
    }
    expect(await isReleased(make)).toBe(true)
  })

  test("heap stays flat across streams opened and cancelled on one connection", async () => {
    const connection = new AbortController()
    const result = await heapGrowth(async () => {
      const marker = { bytes: new Uint8Array(512) }
      const res = sse(
        { req: new Request("http://x/", { signal: connection.signal }) },
        parked(marker),
      )
      await bodyOf(res).cancel()
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })
})

describe("channel subscriptions are released", () => {
  test("a closed subscription is not held by the hub or the connection signal", async () => {
    const channel = defineChannel<"leaks", string>("leaks")
    const hub = memoryChannelHub()
    const connection = new AbortController()
    const make = () => {
      const subscription = hub.subscribe(channel, { signal: connection.signal })
      hub.publish(channel, "one")
      subscription.close()
      return new WeakRef(subscription)
    }
    expect(await isReleased(make)).toBe(true)
  })

  test("a cancelled channel stream closes and releases its subscription", async () => {
    const channel = defineChannel<"streamed", string>("streamed")
    const hub = memoryChannelHub()
    const make = async () => {
      const subscription = hub.subscribe(channel)
      const stream = channelReadableStream(subscription)
      await stream.cancel()
      expect(subscription.closed).toBe(true)
      return new WeakRef(subscription)
    }
    expect(await isReleased(make)).toBe(true)
  })

  test("heap stays flat across subscribe and close on one channel", async () => {
    const channel = defineChannel<"churn", string>("churn")
    const hub = memoryChannelHub()
    const connection = new AbortController()
    const result = await heapGrowth(() => {
      hub.subscribe(channel, { signal: connection.signal }).close()
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })
})

describe("channel hub retention is bounded", () => {
  test("publishing to an ever-new channel keeps at most maxChannels of them", async () => {
    const hub = memoryChannelHub({ maxChannels: 32, historySize: 4 })
    const result = await heapGrowth((i) => {
      hub.publish(defineChannel<string, Uint8Array>(`c${i}`), new Uint8Array(256))
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })

  test("a channel that is subscribed and unsubscribed with no publish leaves nothing", async () => {
    const hub = memoryChannelHub({ maxChannels: 32 })
    const result = await heapGrowth((i) => {
      hub.subscribe(defineChannel<string, string>(`s${i}`)).close()
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })

  test("a publish with no subscriber to an evicted channel releases its history", async () => {
    const hub = memoryChannelHub({ maxChannels: 1, historySize: 4 })
    let n = 0
    const make = () => {
      const payload = { bytes: new Uint8Array(4096) }
      hub.publish(defineChannel<string, object>(`first${n}`), payload)
      hub.publish(defineChannel<string, string>(`second${n++}`), "evicts first")
      return new WeakRef(payload)
    }
    expect(await isReleased(make)).toBe(true)
  })
})

import { expect, test } from "bun:test"
import { readDeferred, type Thenable } from "../src/read-deferred.ts"

// Unit-test the `use()` reimplementation that powers <Await> on Preact (preact/compat has no `use`).
// Pure + synchronous: the full <Await> + <Suspense> + hydration integration is browser-verified
// (examples/routing-preact streams an action's deferred receipt into <Await> client-side).

test("returns the value synchronously for a fulfilled (tagged) thenable", () => {
  const p = Promise.resolve("x") as Thenable<string>
  p.status = "fulfilled"
  p.value = "x"
  expect(readDeferred(p)).toBe("x")
})

test("throws the reason for a rejected (tagged) thenable", () => {
  const reason = new Error("boom")
  const p = Promise.reject(reason) as Thenable<string>
  p.catch(() => {}) // no unhandled rejection
  p.status = "rejected"
  p.reason = reason
  expect(() => readDeferred(p)).toThrow("boom")
})

test("throws the promise while pending, self-tags on resolve, then returns the value", async () => {
  let resolve!: (v: string) => void
  const base = new Promise<string>((r) => {
    resolve = r
  })
  const p = base as Thenable<string>
  // First read: status undefined → marks pending, attaches the self-tag, throws the promise itself.
  let thrown: unknown
  try {
    readDeferred(p)
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBe(p)
  expect(p.status).toBe("pending")
  // A second read while still pending re-throws the same promise (no re-attach).
  expect(() => readDeferred(p)).toThrow()
  // Settle → the self-tag records fulfilled + value → a later read returns synchronously.
  resolve("done")
  await base
  expect(p.status).toBe("fulfilled")
  expect(readDeferred(p)).toBe("done")
})

test("self-tags a rejection on settle (so a later read throws the reason)", async () => {
  let reject!: (e: unknown) => void
  const base = new Promise<string>((_r, rej) => {
    reject = rej
  })
  base.catch(() => {}) // no unhandled rejection
  const p = base as Thenable<string>
  try {
    readDeferred(p) // pending → attaches self-tag, throws
  } catch {
    // expected pending throw
  }
  reject(new Error("nope"))
  await base.catch(() => {})
  expect(p.status).toBe("rejected")
  expect(() => readDeferred(p)).toThrow("nope")
})

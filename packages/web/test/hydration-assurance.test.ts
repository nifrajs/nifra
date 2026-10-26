import { afterEach, describe, expect, test } from "bun:test"
import { assuranceHook } from "../src/internal/hydration-assurance.ts"

const KEY = Symbol.for("nifra.hydration.assurance")
const saved = Object.getOwnPropertyDescriptor(globalThis, KEY)
afterEach(() => {
  if (saved === undefined) Reflect.deleteProperty(globalThis, KEY)
  else Object.defineProperty(globalThis, KEY, saved)
})

describe("assuranceHook", () => {
  test("is undefined with no runner, a runner value that is not an object, or no such hook", () => {
    Reflect.deleteProperty(globalThis, KEY)
    expect(assuranceHook("onWarning")).toBeUndefined()
    Reflect.set(globalThis, KEY, "installed")
    expect(assuranceHook("onWarning")).toBeUndefined()
    Reflect.set(globalThis, KEY, null)
    expect(assuranceHook("onRecoverableError")).toBeUndefined()
    Reflect.set(globalThis, KEY, { onWarning: "not a function" })
    expect(assuranceHook("onWarning")).toBeUndefined()
    expect(assuranceHook("onRecoverableError")).toBeUndefined()
  })

  test("calls the runner's hook with every argument and no receiver", () => {
    const calls: unknown[][] = []
    const receivers: unknown[] = []
    Reflect.set(globalThis, KEY, {
      onRecoverableError(this: unknown, ...args: unknown[]) {
        receivers.push(this)
        calls.push(args)
      },
    })
    const error = new Error("mismatch")
    assuranceHook("onRecoverableError")?.(error, { componentStack: "at Page" })
    expect(calls).toEqual([[error, { componentStack: "at Page" }]])
    expect(receivers).toEqual([undefined])
  })

  test("reads the runner as the mount runs, so one installed later is found", () => {
    Reflect.deleteProperty(globalThis, KEY)
    expect(assuranceHook("onWarning")).toBeUndefined()
    const messages: string[] = []
    Reflect.set(globalThis, KEY, { onWarning: (message: string) => messages.push(message) })
    assuranceHook("onWarning")?.("hydration mismatch")
    expect(messages).toEqual(["hydration mismatch"])
  })
})

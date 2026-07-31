import { afterEach, expect, test } from "bun:test"
import {
  type Blocker,
  type BlockerFunction,
  IDLE_BLOCKER,
  setBlockerController,
  setBrowserNavigate,
} from "@nifrajs/web"
import { createRoot } from "solid-js"
import { useBlocker, useNavigate } from "../src/router.ts"

/**
 * The interception + restore-then-prompt state machine is tested exhaustively in `@nifrajs/web`'s suite.
 * What is specific here is the Solid wiring: `useNavigate` over the navigate bridge, and `useBlocker`
 * feeding a signal that disposes with the reactive root (what a component provides).
 */

const loc = () => ({ pathname: "/", search: "", hash: "" })

afterEach(() => {
  setBrowserNavigate(undefined)
  setBlockerController(undefined)
})

function fakeController(): {
  shouldBlock?: BlockerFunction
  onChange?: (b: Blocker) => void
  unregistered: boolean
} {
  const cap = { unregistered: false } as {
    shouldBlock?: BlockerFunction
    onChange?: (b: Blocker) => void
    unregistered: boolean
  }
  setBlockerController({
    register(shouldBlock, onChange) {
      cap.shouldBlock = shouldBlock
      cap.onChange = onChange
      return () => {
        cap.unregistered = true
      }
    },
  })
  return cap
}

test("useNavigate forwards through the bridge and no-ops before it", () => {
  const nav = useNavigate()
  expect(() => nav("/x")).not.toThrow() // no bridge yet
  const calls: Array<[string | number, unknown]> = []
  setBrowserNavigate((to, o) => calls.push([to, o]))
  nav("/next", { replace: true })
  expect(calls).toEqual([["/next", { replace: true }]])
})

test("useBlocker registers, reflects pushed state, and disposes cleanly", () => {
  const cap = fakeController()
  let dispose!: () => void
  const blocker = createRoot((d) => {
    dispose = d
    return useBlocker(() => true)
  })

  expect(blocker()).toBe(IDLE_BLOCKER)
  expect(cap.shouldBlock?.({ currentLocation: loc(), nextLocation: loc() })).toBe(true)

  cap.onChange?.({ state: "blocked", proceed: () => {}, reset: () => {} })
  expect(blocker().state).toBe("blocked")

  dispose()
  expect(cap.unregistered).toBe(true)
})

test("useBlocker boolean form reads as itself", () => {
  const cap = fakeController()
  createRoot((dispose) => {
    useBlocker(true)
    expect(cap.shouldBlock?.({ currentLocation: loc(), nextLocation: loc() })).toBe(true)
    dispose()
  })
})

import { afterEach, expect, test } from "bun:test"
import {
  type Blocker,
  type BlockerFunction,
  IDLE_BLOCKER,
  setBlockerController,
  setBrowserNavigate,
} from "@nifrajs/web"
import { get } from "svelte/store"
import { useBlocker, useNavigate } from "../src/router.ts"

/**
 * The interception + restore-then-prompt state machine is tested exhaustively in `@nifrajs/web`'s suite.
 * What is specific here is the Svelte wiring: `useNavigate` over the navigate bridge, and `useBlocker`
 * as a `readable` store that registers on the first subscription and unregisters on the last.
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

test("useBlocker registers on first subscribe, reflects state, unregisters on last unsubscribe", () => {
  const cap = fakeController()
  const blocker = useBlocker(() => true)
  const seen: Blocker["state"][] = []
  const unsubscribe = blocker.subscribe((b) => seen.push(b.state))

  // The start notifier ran on subscribe -> registered; initial value is idle.
  expect(get(blocker)).toBe(IDLE_BLOCKER)
  expect(cap.shouldBlock?.({ currentLocation: loc(), nextLocation: loc() })).toBe(true)

  cap.onChange?.({ state: "blocked", proceed: () => {}, reset: () => {} })
  expect(get(blocker).state).toBe("blocked")
  expect(seen).toEqual(["unblocked", "blocked"])

  unsubscribe()
  expect(cap.unregistered).toBe(true)
})

test("useBlocker boolean form reads as itself", () => {
  const cap = fakeController()
  const unsubscribe = useBlocker(true).subscribe(() => {})
  expect(cap.shouldBlock?.({ currentLocation: loc(), nextLocation: loc() })).toBe(true)
  unsubscribe()
})

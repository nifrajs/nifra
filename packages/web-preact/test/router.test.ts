import { afterEach, expect, test } from "bun:test"
import { setBrowserNavigate } from "@nifrajs/web"
import { h } from "preact"
import { renderToString } from "preact-render-to-string"
import { useBlocker, useNavigate } from "../src/router.ts"

/**
 * The interception + restore-then-prompt state machine is tested exhaustively in `@nifrajs/web`'s suite;
 * the registration effect (which needs a client mount) is browser-verified, same as the other client
 * hooks. What is asserted here is Preact's SSR contract: `useNavigate` resolves the bridge at call time,
 * and `useBlocker` renders idle on the server so the first client render matches (no hydration mismatch).
 */

afterEach(() => setBrowserNavigate(undefined))

test("useNavigate forwards through the bridge and no-ops before it", () => {
  let nav: ReturnType<typeof useNavigate> | undefined
  renderToString(
    h(() => {
      nav = useNavigate()
      return null
    }, {}),
  )
  if (nav === undefined) throw new Error("the component never rendered")

  expect(() => nav?.("/x")).not.toThrow() // no bridge yet
  const calls: Array<[string | number, unknown]> = []
  setBrowserNavigate((to, o) => calls.push([to, o]))
  nav("/next", { replace: true })
  expect(calls).toEqual([["/next", { replace: true }]])
})

test("useBlocker is idle on SSR (effects don't run) - hydration-safe", () => {
  let blocker: ReturnType<typeof useBlocker> | undefined
  renderToString(
    h(() => {
      blocker = useBlocker(true)
      return null
    }, {}),
  )
  expect(blocker?.state).toBe("unblocked")
  expect(blocker?.proceed).toBeUndefined()
  expect(blocker?.reset).toBeUndefined()
})

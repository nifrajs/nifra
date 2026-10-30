import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import {
  type BlockerFunction,
  rawHref,
  setBlockerController,
  setBrowserNavigate,
} from "@nifrajs/web"
import { GlobalWindow } from "happy-dom"
import { act, createElement, type ReactNode } from "react"
import type { Root } from "react-dom/client"
import { Navigate, useBlocker } from "../src/router.ts"

const window = new GlobalWindow({ url: "https://router.test/" })
const installed: string[] = []

beforeAll(() => {
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis) continue
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: Reflect.get(window, key),
    })
    installed.push(key)
  }
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
})

afterEach(() => {
  setBlockerController(undefined)
  setBrowserNavigate(undefined)
})

afterAll(async () => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  for (const key of installed) Reflect.deleteProperty(globalThis, key)
  await window.happyDOM.close()
})

async function withRoot(run: (root: Root) => Promise<void>): Promise<void> {
  const container = document.createElement("div")
  document.body.append(container)
  const { createRoot } = await import("react-dom/client")
  const root = createRoot(container)
  try {
    await run(root)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
}

function BlockerProbe(props: { readonly shouldBlock: boolean | BlockerFunction }): ReactNode {
  useBlocker(props.shouldBlock)
  return null
}

test("useBlocker registers once and reads the latest predicate", async () => {
  let registered: BlockerFunction | undefined
  let registrations = 0
  let cleanups = 0
  setBlockerController({
    register(shouldBlock) {
      registrations++
      registered = shouldBlock
      return () => {
        cleanups++
      }
    },
  })

  const args = {
    currentLocation: { pathname: "/from", search: "", hash: "" },
    nextLocation: { pathname: "/to", search: "", hash: "" },
  }

  await withRoot(async (root) => {
    await act(async () => root.render(createElement(BlockerProbe, { shouldBlock: true })))
    if (registered === undefined) throw new Error("[test] blocker was not registered")
    expect(registered(args)).toBe(true)

    await act(async () =>
      root.render(
        createElement(BlockerProbe, {
          shouldBlock: (next) => next.nextLocation.pathname === "/allowed",
        }),
      ),
    )
    if (registered === undefined) throw new Error("[test] blocker registration disappeared")
    expect(registered(args)).toBe(false)
    expect(registrations).toBe(1)
  })

  expect(cleanups).toBe(1)
})

test("Navigate uses the browser bridge after the client mounts", async () => {
  const calls: Array<[string | number, unknown]> = []
  setBrowserNavigate((to, options) => calls.push([to, options]))

  await withRoot(async (root) => {
    await act(async () =>
      root.render(createElement(Navigate, { to: rawHref("/next"), replace: true })),
    )
  })

  expect(calls).toEqual([["/next", { replace: true }]])
})

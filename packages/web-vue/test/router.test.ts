import { afterEach, expect, test } from "bun:test"
import {
  type Blocker,
  type BlockerFunction,
  IDLE_BLOCKER,
  setBlockerController,
  setBrowserNavigate,
} from "@nifrajs/web"
import { createSSRApp, defineComponent, effectScope, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { compose } from "../src/compose.ts"
import { useBlocker, useNavigate, useSearch } from "../src/router.ts"

/**
 * The interception + restore-then-prompt state machine is tested exhaustively in `@nifrajs/web`'s suite.
 * What is specific here is the Vue wiring: `useNavigate` over the navigate bridge, and `useBlocker`
 * feeding a `shallowRef` that stops with the effect scope (what a component provides).
 */

const loc = () => ({ pathname: "/", search: "", hash: "" })

afterEach(() => {
  setBrowserNavigate(undefined)
  setBlockerController(undefined)
})

// Stand in for installHistory's registry: capture what useBlocker registers so the test can drive it.
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

test("useBlocker registers, reflects pushed state, and unregisters with the scope", () => {
  const cap = fakeController()
  const scope = effectScope()
  const blocker = scope.run(() => useBlocker(() => true))
  if (blocker === undefined) throw new Error("the scope produced no blocker")

  expect(blocker.value).toBe(IDLE_BLOCKER)
  expect(cap.shouldBlock?.({ currentLocation: loc(), nextLocation: loc() })).toBe(true)

  cap.onChange?.({ state: "blocked", proceed: () => {}, reset: () => {} })
  expect(blocker.value.state).toBe("blocked")

  scope.stop()
  expect(cap.unregistered).toBe(true)
})

test("useBlocker boolean form reads as itself", () => {
  const cap = fakeController()
  const scope = effectScope()
  scope.run(() => useBlocker(true))
  expect(cap.shouldBlock?.({ currentLocation: loc(), nextLocation: loc() })).toBe(true)
  scope.stop()
})

test("compose threads RenderProps.search to useSearch (reactive ref, SSR-correct)", async () => {
  // The value the server puts in RenderProps.search flows through compose's SearchProvider to useSearch;
  // the client mount derives the same value via searchOfChain, so the two renders match.
  const Page = defineComponent({
    setup() {
      const search = useSearch()
      return () => h("span", null, String(search.value.page))
    },
  })
  const html = await renderToString(
    createSSRApp({
      render: () => compose([Page], { data: null, search: { page: 2 }, path: "/r?page=2" }),
    }),
  )
  // Vue applies undeclared props as fallthrough attrs on the root element, so match the text tolerantly.
  expect(html).toContain(">2</span>")
})

test("useSearch is an empty ref for a render with no search context", async () => {
  const Page = defineComponent({
    setup() {
      const search = useSearch()
      return () => h("span", null, String(Object.keys(search.value).length))
    },
  })
  const html = await renderToString(createSSRApp({ render: () => compose([Page], { data: null }) }))
  expect(html).toContain("<span>0</span>")
})

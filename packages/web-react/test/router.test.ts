import { afterEach, expect, test } from "bun:test"
import { setBrowserNavigate } from "@nifrajs/web"
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { compose } from "../src/compose.ts"
import {
  Link,
  Navigate,
  NavLink,
  RouterContext,
  type SetSearchParams,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "../src/router.ts"

// SSR-only assertions (bun:test has no DOM): we render through react-dom/server and verify the routing
// context the hooks read is threaded correctly — which is exactly what makes hydration match. Click /
// navigation behavior is browser-verified against the real packages (examples/web-react).

// Provide a router context (params + path) around a node, the way `compose` does on both sides.
const withRoute = (path: string, node: ReactNode, params: Record<string, string> = {}): string =>
  renderToStaticMarkup(createElement(RouterContext.Provider, { value: { params, path } }, node))

afterEach(() => setBrowserNavigate(undefined))

test("compose threads the matched params to useParams (SSR-correct)", () => {
  const Page = () => {
    const { id } = useParams<{ id: string }>()
    return createElement("span", null, id)
  }
  const html = renderToStaticMarkup(
    compose([Page], { data: null, params: { id: "7" }, path: "/users/7" }),
  )
  expect(html).toContain("<span>7</span>")
})

test("compose provides an empty context when a render has no routing props", () => {
  const Page = () => {
    const params = useParams()
    const loc = useLocation()
    return createElement("span", null, `${Object.keys(params).length}|${loc.pathname}`)
  }
  const html = renderToStaticMarkup(compose([Page], { data: null }))
  expect(html).toContain("<span>0|</span>")
})

test("useLocation splits pathname/search from the router path (hash is always empty)", () => {
  const Page = () => {
    const l = useLocation()
    return createElement("span", null, `${l.pathname}|${l.search}|${l.hash}`)
  }
  expect(withRoute("/search?q=react", createElement(Page))).toContain(
    "<span>/search|?q=react|</span>",
  )
})

test("useSearchParams exposes the current query", () => {
  const Page = () => {
    const [sp] = useSearchParams()
    return createElement("span", null, `${sp.get("q")}/${sp.get("p")}`)
  }
  expect(withRoute("/s?q=hello&p=2", createElement(Page))).toContain("<span>hello/2</span>")
})

test("Link renders a real <a href> (working before hydration, right-clickable)", () => {
  const html = renderToStaticMarkup(
    createElement(Link, { to: "/about", className: "nav" }, "About"),
  )
  expect(html).toContain('href="/about"')
  expect(html).toContain('class="nav"')
  expect(html).toContain(">About</a>")
})

test("NavLink marks aria-current on a prefix match", () => {
  const active = withRoute("/users/7", createElement(NavLink, { to: "/users" }, "Users"))
  expect(active).toContain('aria-current="page"')

  const inactive = withRoute("/posts", createElement(NavLink, { to: "/users" }, "Users"))
  expect(inactive).not.toContain("aria-current")
})

test("NavLink end matches exactly — home isn't active on a subpath", () => {
  const onSub = withRoute("/dashboard", createElement(NavLink, { to: "/", end: true }, "Home"))
  expect(onSub).not.toContain("aria-current")

  const onHome = withRoute("/", createElement(NavLink, { to: "/", end: true }, "Home"))
  expect(onHome).toContain('aria-current="page"')
})

test("NavLink resolves a function className with the active state", () => {
  const on = withRoute(
    "/users",
    createElement(
      NavLink,
      {
        to: "/users",
        className: ({ isActive }: { isActive: boolean }) => (isActive ? "on" : "off"),
      },
      "U",
    ),
  )
  expect(on).toContain('class="on"')
})

test("NavLink is case-insensitive by default, case-sensitive when asked", () => {
  const insensitive = withRoute("/Users", createElement(NavLink, { to: "/users" }, "U"))
  expect(insensitive).toContain('aria-current="page"')

  const sensitive = withRoute(
    "/Users",
    createElement(NavLink, { to: "/users", caseSensitive: true }, "U"),
  )
  expect(sensitive).not.toContain("aria-current")
})

test("Navigate renders nothing on the server (the redirect is a client effect)", () => {
  expect(renderToStaticMarkup(createElement(Navigate, { to: "/login" }))).toBe("")
})

test("useNavigate no-ops (no throw) before a browser navigate is registered", () => {
  let navigate: ReturnType<typeof useNavigate> | undefined
  const Page = () => {
    navigate = useNavigate()
    return null
  }
  renderToStaticMarkup(compose([Page], { data: null }))
  expect(() => navigate?.("/x")).not.toThrow()
})

test("useNavigate forwards through the registered browser bridge", () => {
  const calls: Array<[string | number, unknown]> = []
  setBrowserNavigate((to, options) => calls.push([to, options]))
  let navigate: ReturnType<typeof useNavigate> | undefined
  const Page = () => {
    navigate = useNavigate()
    return null
  }
  renderToStaticMarkup(compose([Page], { data: null }))
  navigate?.("/next", { replace: true })
  expect(calls).toEqual([["/next", { replace: true }]])
})

// Capture the setSearchParams setter for a given router path (renders a probe component that stashes it).
function captureSetSearchParams(path: string): SetSearchParams {
  let setter: SetSearchParams | undefined
  const Probe = () => {
    const [, set] = useSearchParams()
    setter = set
    return null
  }
  renderToStaticMarkup(
    createElement(RouterContext.Provider, { value: { params: {}, path } }, createElement(Probe)),
  )
  if (setter === undefined) throw new Error("setter not captured")
  return setter
}

test("setSearchParams navigates with the new query — record/string/URLSearchParams/updater/array/empty", () => {
  const calls: string[] = []
  setBrowserNavigate((to) => calls.push(to as string))
  const set = captureSetSearchParams("/s?q=old")
  set({ q: "new" }) // record
  set("q=raw&p=2") // raw string
  set(new URLSearchParams("a=1")) // URLSearchParams
  set((prev) => {
    prev.set("q", "up")
    return prev
  }) // updater over the current query (?q=old)
  set({ tags: ["a", "b"] }) // array value → repeated key
  set({}) // empty → no "?" suffix
  expect(calls).toEqual(["/s?q=new", "/s?q=raw&p=2", "/s?a=1", "/s?q=up", "/s?tags=a&tags=b", "/s"])
})

// A minimal MouseEvent stand-in for driving Link's click handler without a DOM. `preventDefault`
// flips `defaultPrevented` so the handler's guard behaves like a real event.
interface MockClick {
  defaultPrevented: boolean
  button: number
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  preventDefault: () => void
}
function mockClick(over: Partial<MockClick> = {}): MockClick {
  const e: MockClick = {
    defaultPrevented: false,
    button: 0,
    preventDefault() {
      e.defaultPrevented = true
    },
    ...over,
  }
  return e
}
// Pull Link's rendered <a> onClick out of the forwardRef render (no DOM needed to exercise its logic).
function linkOnClick(props: Record<string, unknown>): (e: MockClick) => void {
  const rendered = (
    Link as unknown as {
      render: (p: unknown, r: unknown) => { props: { onClick: (e: MockClick) => void } }
    }
  ).render(props, null)
  return rendered.props.onClick
}

test("Link intercepts a plain left-click → preventDefault + navigate(to, {replace})", () => {
  const calls: Array<[unknown, unknown]> = []
  setBrowserNavigate((to, o) => calls.push([to, o]))
  const e = mockClick()
  linkOnClick({ to: "/x", replace: true })(e)
  expect(e.defaultPrevented).toBe(true)
  expect(calls).toEqual([["/x", { replace: true }]])
})

test("Link leaves modified / non-left / already-handled clicks to the browser", () => {
  const calls: unknown[] = []
  setBrowserNavigate((to) => calls.push(to))
  linkOnClick({ to: "/x" })(mockClick({ button: 1 })) // middle-click
  linkOnClick({ to: "/x" })(mockClick({ metaKey: true })) // cmd/ctrl-click (new tab)
  linkOnClick({ to: "/x" })(mockClick({ defaultPrevented: true })) // an upstream handler took it
  linkOnClick({ to: "/x", target: "_blank" })(mockClick()) // target opts out
  expect(calls).toEqual([])
})

test("Link runs the user onClick first; a user preventDefault suppresses navigation", () => {
  const calls: unknown[] = []
  setBrowserNavigate((to) => calls.push(to))
  let userCalled = false
  const e = mockClick()
  linkOnClick({
    to: "/x",
    onClick: (ev: MockClick) => {
      userCalled = true
      ev.preventDefault()
    },
  })(e)
  expect(userCalled).toBe(true)
  expect(calls).toEqual([]) // defaultPrevented after the user handler → bail
})

test("Link click before hydration (no bridge) is a no-op — the native <a href> handles it", () => {
  setBrowserNavigate(undefined)
  const e = mockClick()
  linkOnClick({ to: "/x" })(e)
  expect(e.defaultPrevented).toBe(false) // no preventDefault → browser does the full-page navigation
})

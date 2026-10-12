import { expect, test } from "bun:test"
import { appUrl } from "../src/internal/route-path.ts"
import { createClientRouter } from "../src/router.ts"

const patterns = [
  { routeId: "home", pattern: "/" },
  { routeId: "cms", pattern: "/*slug" },
]

/** Run `body` as a page on `https://shop.example`, recording every fetch the router makes. */
async function onPage(href: string, body: (fetched: string[]) => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch
  const realLocation = Object.getOwnPropertyDescriptor(globalThis, "location")
  const fetched: string[] = []
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: new URL(href).origin, href },
  })
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a test double; the router only calls fetch, never its static members.
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    fetched.push(`${init?.method ?? "GET"} ${String(input)}`)
    return Response.json({ html: "<p>own</p>" })
  }) as typeof fetch
  try {
    await body(fetched)
  } finally {
    globalThis.fetch = realFetch
    if (realLocation === undefined) Reflect.deleteProperty(globalThis, "location")
    else Object.defineProperty(globalThis, "location", realLocation)
  }
}

test("a page whose path starts // revalidates, navigates and submits on its own origin", async () => {
  await onPage("https://shop.example//evil.example/x", async (fetched) => {
    const router = createClientRouter({
      patterns,
      initial: {
        routeId: "cms",
        params: { slug: "/evil.example/x" },
        path: "//evil.example/x",
        data: { html: "<p>real</p>" },
        pending: false,
      },
      loadModule: async () => {},
    })
    await router.invalidate()
    await router.navigate("/\\evil.example/y")
    const form = new FormData()
    form.set("email", "v@x")
    await router.submit("//evil.example/z", form).catch(() => {})
    await router.navigate("/plain")
    expect(fetched).toEqual([
      "GET https://shop.example//evil.example/x",
      "GET https://shop.example/\\evil.example/y",
      "POST https://shop.example//evil.example/z",
      // The submit's revalidation of the page on screen.
      "GET https://shop.example/\\evil.example/y",
      "GET /plain",
    ])
  })
})

test("appUrl leaves a path alone off the browser and for an ordinary path", () => {
  expect(appUrl("//evil.example/x")).toBe("//evil.example/x")
  expect(appUrl("/a//b")).toBe("/a//b")
})

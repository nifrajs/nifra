import { expect, test } from "bun:test"
import type { CookieOptions } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"
import { createWebApp } from "../src/index.ts"
import {
  progressiveCookieHeader,
  progressiveCookieRedirect,
} from "../src/internal/progressive-cookies.ts"
import {
  createServerComponents,
  defineServerComponent,
  serverComponentInstance,
} from "../src/server-components.ts"

test("progressive owner GET cookies honor secure, path, exact host and deletion boundaries", () => {
  const request = new Request("https://fixture.test/products/item", {
    headers: { cookie: "subject=old; untouched=public" },
  })
  expect(
    progressiveCookieHeader(request, [
      { name: "subject", value: "new value" },
      { name: "outside", value: "forbidden", options: { path: "/product" } },
      { name: "foreign", value: "forbidden", options: { domain: "other.test" } },
      { name: "expired", value: "forbidden", options: { maxAge: 0 } },
    ]),
  ).toBe("untouched=public; subject=new%20value")
  expect(progressiveCookieHeader(request, [{ name: "subject", value: "", deleted: true }])).toBe(
    "untouched=public",
  )
  const insecure = new Request("http://fixture.test/", { headers: { cookie: "subject=old" } })
  expect(progressiveCookieHeader(insecure, [{ name: "subject", value: "new" }])).toBe("subject=old")
  expect(
    progressiveCookieHeader(insecure, [
      { name: "subject", value: "new", options: { secure: false } },
    ]),
  ).toBe("subject=new")
})

test("parent-domain action cookies use a browser owner GET instead of synthesizing acceptance", () => {
  const request = new Request("https://app.fixture.test/products/item")
  expect(
    progressiveCookieRedirect(request, [
      { name: "subject", value: "public", options: { domain: ".fixture.test" } },
    ]),
  ).toBe(true)
  expect(
    progressiveCookieRedirect(request, [
      { name: "subject", value: "public", options: { domain: "app.fixture.test" } },
    ]),
  ).toBe(false)
  expect(
    progressiveCookieRedirect(request, [
      { name: "subject", value: "public", options: { domain: "other.test" } },
    ]),
  ).toBe(false)
})

/** An owner route whose native-POST action sets `subject` with `cookieOptions`; `trace` records each step. */
function progressiveCookieApp(trace: string[], cookieOptions: CookieOptions) {
  const component = defineServerComponent(
    {
      input: t.object({}),
      props: t.object({ title: t.string() }),
      authorize() {
        trace.push("authorize")
      },
      load() {
        trace.push("load")
        return { title: "fabricated-public-title" }
      },
      view: ({ props }) => props.title,
    },
    "parent_domain_component",
  )
  return createWebApp({
    clientEntry: "/entry.js",
    llmsTxt: false,
    serverComponents: createServerComponents({
      build: "parent_domain_build",
      adapter: { name: "vue", version: 1, render: () => ({ html: "public" }) },
      owners: {
        form: {
          components: [component],
          scope: "anonymous",
          instances: () => [serverComponentInstance(component, "stable", {})],
        },
      },
    }),
    manifest: {
      routes: [
        {
          id: "form",
          pattern: "/form",
          file: "form.ts",
          layoutIds: [],
          errorIds: [],
          load: async () => ({
            default: () => null,
            action({ set }) {
              trace.push("action")
              set.headers["x-action"] = "saved"
              set.cookie("subject", "fabricated-public", cookieOptions)
              return { saved: true }
            },
            loader({ request }) {
              trace.push("loader")
              expect(request.headers.get("cookie")).toBe("subject=fabricated-public")
              return null
            },
          }),
        },
      ],
      layouts: {},
      errors: {},
    },
    adapter: {
      hydrationHead: () => "",
      renderToString: () => "public",
      renderToStream: () =>
        new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
    },
    use(server) {
      server.beforeHandle((ctx) => {
        trace.push("hook:" + ctx.req.method)
      })
    },
  })
}

test("parent-domain progressive POST redirects with cookies before any owner component work", async () => {
  const trace: string[] = []
  const app = progressiveCookieApp(trace, { domain: ".fixture.test" })
  const response = await app.fetch(
    new Request("https://app.fixture.test/form?view=public", { method: "POST" }),
  )
  expect(response.status).toBe(303)
  expect(response.headers.get("location")).toBe("/form?view=public")
  expect(response.headers.get("set-cookie")).toContain("Domain=.fixture.test")
  expect(response.headers.get("x-action")).toBe("saved")
  expect(response.headers.get("cache-control")).toBe("private, no-store")
  expect(await response.text()).toBe("")
  expect(trace).toEqual(["hook:POST", "action"])
  const owner = await app.fetch(
    new Request(new URL(response.headers.get("location")!, "https://app.fixture.test"), {
      headers: { cookie: "subject=fabricated-public" },
    }),
  )
  expect(owner.status).toBe(200)
  await owner.text()
  expect(trace).toEqual(["hook:POST", "action", "hook:GET", "loader", "authorize", "load"])
})

test("a Secure action cookie on a request seen as http: lets the browser make the owner GET", async () => {
  // A TLS terminator in front: the browser is on https, the app sees http.
  const trace: string[] = []
  const app = progressiveCookieApp(trace, {})
  const response = await app.fetch(
    new Request("http://app.fixture.test/form?view=public", { method: "POST" }),
  )
  expect(response.status).toBe(303)
  expect(response.headers.get("location")).toBe("/form?view=public")
  expect(response.headers.get("set-cookie")).toContain("Secure")
  expect(trace).toEqual(["hook:POST", "action"])
  const owner = await app.fetch(
    new Request(new URL(response.headers.get("location")!, "http://app.fixture.test"), {
      headers: { cookie: "subject=fabricated-public" },
    }),
  )
  expect(owner.status).toBe(200)
  await owner.text()
  expect(trace).toEqual(["hook:POST", "action", "hook:GET", "loader", "authorize", "load"])
})

test("progressiveCookieRedirect: a Secure change over http: needs the browser, a non-Secure one does not", () => {
  expect(
    progressiveCookieRedirect(new Request("http://app.fixture.test/form"), [
      { name: "subject", value: "new", options: { secure: false } },
    ]),
  ).toBe(false)
  expect(
    progressiveCookieRedirect(new Request("http://app.fixture.test/form"), [
      { name: "subject", value: "new" },
    ]),
  ).toBe(true)
})

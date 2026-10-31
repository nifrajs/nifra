import { expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { createWebApp } from "../src/index.ts"
import type { Manifest } from "../src/manifest.ts"
import { readComponentFlightFrames, readComponentFrames } from "../src/server-components/frames.ts"
import {
  COMPONENT_FLIGHT_MEDIA_TYPE,
  componentRequestHeader,
} from "../src/server-components/protocol.ts"
import {
  createServerComponents,
  defineServerComponent,
  serverComponentIdentity,
  serverComponentInstance,
} from "../src/server-components.ts"

const admissionStages = [
  "hook",
  "filesystem",
  "gate",
  "layout",
  "page",
  "scope",
  "instances",
  "component-authorize",
  "service",
] as const
for (const deniedStage of admissionStages) {
  test(`owner refresh stops at ${deniedStage} and cannot retain an earlier layout admission`, async () => {
    const trace: string[] = []
    const enter = (stage: (typeof admissionStages)[number]): void => {
      trace.push(stage)
      if (stage === deniedStage) throw new Response(null, { status: 403 })
    }
    const component = defineServerComponent(
      {
        input: t.object({}),
        props: t.object({ title: t.string() }),
        authorize() {
          enter("component-authorize")
        },
        load() {
          enter("service")
          return { title: "fabricated-private-projection" }
        },
        view: ({ props }) => props.title,
      },
      "admission_component",
    )
    const components = createServerComponents({
      build: "admission_build",
      adapter: {
        name: "vue",
        version: 1,
        render: async () => ({ html: "fabricated-private-projection" }),
      },
      owners: {
        owner: {
          components: [component],
          scope() {
            enter("scope")
            return "anonymous"
          },
          instances() {
            enter("instances")
            return [serverComponentInstance(component, "stable", {})]
          },
        },
      },
    })
    const manifest: Manifest = {
      routes: [
        {
          id: "owner",
          pattern: "/owner",
          file: "owner.ts",
          layoutIds: ["gate", "layout"],
          errorIds: [],
          middlewareIds: ["middleware"],
          load: async () => ({
            default: () => null,
            loader() {
              enter("page")
              return null
            },
          }),
        },
      ],
      layouts: {
        gate: {
          file: "gate.ts",
          load: async () => ({
            default: () => null,
            gate: true,
            loader() {
              enter("gate")
              return null
            },
          }),
        },
        layout: {
          file: "layout.ts",
          load: async () => ({
            default: () => null,
            loader() {
              enter("layout")
              return null
            },
          }),
        },
      },
      middlewares: {
        middleware: {
          file: "middleware.ts",
          load: async () => ({
            default() {
              enter("filesystem")
            },
          }),
        },
      },
      errors: {},
    }
    const app = createWebApp({
      manifest,
      clientEntry: "/entry.js",
      llmsTxt: false,
      serverComponents: components,
      adapter: {
        hydrationHead: () => "",
        renderToString: () => "",
        renderToStream: () => new ReadableStream(),
      },
      use(app) {
        app.beforeHandle(() => {
          enter("hook")
        })
      },
    })
    const header = componentRequestHeader({
      v: 1,
      build: "admission_build",
      reference: "admission_component",
      key: "stable",
      parent: null,
      generation: 1,
      routeEpoch: 0,
      authEpoch: 0,
      input: {},
    })
    const response = await app.fetch(
      new Request("https://fixture.test/owner", {
        headers: { "x-nifra-component": header, "sec-fetch-site": "same-origin" },
      }),
    )
    expect(response.status).toBe(403)
    // Ordinary layouts and the page keep Nifra's parallel loader semantics; gates block the page.
    expect(trace).toEqual([
      ...admissionStages.slice(0, admissionStages.indexOf(deniedStage) + 1),
      ...(deniedStage === "layout" ? ["page"] : []),
    ])
    expect(await response.text()).not.toContain("fabricated-private-projection")
    trace.length = 0
    const retained = await app.fetch(
      new Request("https://fixture.test/owner", {
        headers: {
          "x-nifra-component": header,
          "x-nifra-retain": "gate,layout",
          "sec-fetch-site": "same-origin",
        },
      }),
    )
    expect(retained.status).toBe(deniedStage === "hook" ? 403 : 400)
    expect(trace).toEqual(["hook"])
  })
}

test("component refresh runs the actual owner GET and every owner loader before component authorization", async () => {
  const trace: string[] = []
  const component = defineServerComponent(
    {
      input: t.object({ id: t.string() }),
      props: t.object({ name: t.string() }),
      authorize(ctx, input) {
        trace.push("component-authorize")
        expect(ctx.request.method).toBe("GET")
        expect(ctx.params.id).toBe(input.id)
        expect(ctx.layoutData).toEqual(["gate", "ordinary"])
      },
      load(ctx) {
        trace.push("component-load")
        expect(ctx.data).toEqual({ id: "example" })
        return { name: "public", internal: "fabricated-private" }
      },
      view: ({ props }) => `<p>${props.name}</p>`,
    },
    "component_example",
  )
  const components = createServerComponents({
    build: "build_1",
    adapter: {
      name: "vue",
      version: 1,
      async render(view, props) {
        trace.push("component-render")
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The fabricated render adapter is paired with this test definition; the executor validates public props before rendering.
        return { html: await (view as (args: { props: unknown }) => string)({ props }) }
      },
    },
    owners: {
      product: {
        components: [component],
        scope: "anonymous",
        instances: () => [serverComponentInstance(component, "example", { id: "example" })],
      },
    },
  })
  const manifest: Manifest = {
    routes: [
      {
        id: "product",
        pattern: "/products/:id",
        layoutIds: ["gate", "ordinary"],
        errorIds: [],
        file: "product.ts",
        middlewareIds: ["middleware"],
        load: async () => ({
          default: () => null,
          loader: ({ params }) => {
            trace.push("page")
            return { id: params.id }
          },
        }),
      },
    ],
    layouts: {
      gate: {
        file: "gate.ts",
        load: async () => ({
          default: () => null,
          gate: true,
          loader: () => {
            trace.push("gate")
            return "gate"
          },
        }),
      },
      ordinary: {
        file: "ordinary.ts",
        load: async () => ({
          default: () => null,
          loader: () => {
            trace.push("ordinary")
            return "ordinary"
          },
        }),
      },
    },
    middlewares: {
      middleware: {
        file: "middleware.ts",
        load: async () => ({
          default: () => {
            trace.push("filesystem")
          },
        }),
      },
    },
    errors: {},
  }
  const app = createWebApp({
    manifest,
    clientEntry: "/entry.js",
    llmsTxt: false,
    serverComponents: components,
    adapter: {
      renderToString: () => "",
      renderToStream: () =>
        new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
      hydrationHead: () => "",
    },
    use(app) {
      app.beforeHandle((ctx) => {
        trace.push("owner-get")
        if (ctx.req.headers.get("x-deny") === "1") return new Response(null, { status: 403 })
        return undefined
      })
    },
  })
  const header = componentRequestHeader({
    v: 1,
    build: "build_1",
    reference: "component_example",
    key: "example",
    parent: null,
    generation: 1,
    routeEpoch: 0,
    authEpoch: 0,
    input: { id: "example" },
  })
  const response = await app.fetch(
    new Request("https://fixture.test/products/example", {
      headers: { "x-nifra-component": header, "sec-fetch-site": "same-origin" },
    }),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("private, no-store")
  const frames = await readComponentFrames(response.body!, new AbortController().signal)
  expect(frames.value).toMatchObject({ records: [{ html: "<p>public</p>" }] })
  expect(trace).toEqual([
    "owner-get",
    "filesystem",
    "gate",
    "ordinary",
    "page",
    "component-authorize",
    "component-load",
    "component-render",
  ])
  trace.length = 0
  const denied = await app.fetch(
    new Request("https://fixture.test/products/example", {
      headers: { "x-nifra-component": header, "sec-fetch-site": "same-origin", "x-deny": "1" },
    }),
  )
  expect(denied.status).toBe(403)
  expect(trace).toEqual(["owner-get"])
})

test("a React owner uses progressive Flight only for a verified single-component selection", async () => {
  const component = defineServerComponent(
    {
      input: t.object({}),
      props: t.object({ title: t.string() }),
      authorize() {},
      load: () => ({ title: "public" }),
      view: ({ props }) => props.title,
    },
    "progressive_owner_component",
  )
  const payload = new TextEncoder().encode('0:"progressive"\n')
  const runtime = createServerComponents({
    build: "build_1",
    adapter: {
      name: "react",
      version: 1,
      render: () => ({ html: "buffered" }),
      renderProgressive: (_view, _props, context) => {
        expect(context.nonce).toBe("nonce_1")
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(payload)
            controller.close()
          },
        })
      },
    },
    owners: {
      owner: {
        scope: "anonymous",
        components: [component],
        instances: () => [serverComponentInstance(component, "stable", {})],
      },
    },
  })
  if (runtime.progressive === undefined) throw new Error("React adapter lost progressive support")
  const request = new Request("https://fixture.test/owner", {
    headers: { accept: COMPONENT_FLIGHT_MEDIA_TYPE },
  })
  const context = {
    request,
    req: request,
    params: {},
    api: undefined,
    env: undefined,
    draft: false,
    live() {},
    search: {},
    set: { headers: {}, cookie() {}, deleteCookie() {} },
    signal: request.signal,
    data: null,
    layoutData: [],
  }
  const response = await runtime.progressive(
    "owner",
    context,
    {
      v: 1,
      build: "build_1",
      reference: "progressive_owner_component",
      key: "stable",
      parent: null,
      generation: 1,
      routeEpoch: 0,
      authEpoch: 0,
      input: {},
    },
    "nonce_1",
  )
  expect(response.headers.get("content-type")).toBe(COMPONENT_FLIGHT_MEDIA_TYPE)
  const decoded = await readComponentFlightFrames(response.body!, request.signal)
  expect(decoded.metadata).toMatchObject({
    v: 1,
    build: "build_1",
    adapter: "react",
    reference: "progressive_owner_component",
    key: "stable",
  })
  expect(await new Response(decoded.flight).text()).toBe('0:"progressive"\n')
})

test("server component owner setup rejects unsafe build, assets, public cache and undeclared grants", () => {
  const adapter = { name: "vue" as const, version: 1 as const, render: () => ({ html: "" }) }
  expect(() => createServerComponents({ build: "bad build", adapter, owners: {} })).toThrow()
  expect(() =>
    createServerComponents({
      build: "build_1",
      adapter,
      owners: {},
      assets: ["/assets/../secret"],
    }),
  ).toThrow()

  const cachedOwner = {
    scope: "anonymous" as const,
    components: [],
    instances: () => [],
    cache: { scope: "public" as const, requestIndependent: true as const, revalidate: 30 },
  }
  expect(() =>
    createServerComponents({ build: "build_1", adapter, owners: { owner: cachedOwner } }),
  ).toThrow()

  const privileged = defineServerComponent(
    {
      input: t.object({}),
      props: t.object({}),
      authorize() {},
      load: () => ({}),
      view: () => null,
      capabilities: ["private_read"],
    },
    "privileged_component",
  )
  expect(() =>
    createServerComponents({
      build: "build_1",
      adapter,
      owners: {
        owner: {
          scope: "anonymous",
          components: [privileged],
          instances: () => [],
        },
      },
    }),
  ).toThrow()
})

test("progressive component form rerender runs owner GET authorization after the action exactly once", async () => {
  const trace: string[] = []
  let denyGet = false
  const component = defineServerComponent(
    {
      input: t.object({}),
      props: t.object({ title: t.string() }),
      authorize: () => {
        trace.push("authorize")
      },
      load: () => {
        trace.push("load")
        return { title: "public" }
      },
      view: ({ props }) => props.title,
    },
    "progressive_component",
  )
  const runtime = createServerComponents({
    build: "build_1",
    adapter: {
      name: "vue",
      version: 1,
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The fabricated render adapter is paired with this test definition; the executor validates public props before rendering.
      render: (_view, props) => ({ html: (props as { title: string }).title }),
    },
    owners: {
      form: {
        scope: "anonymous",
        components: [component],
        instances: () => [serverComponentInstance(component, "stable", {})],
      },
    },
  })
  const manifest: Manifest = {
    routes: [
      {
        id: "form",
        pattern: "/form",
        layoutIds: [],
        errorIds: [],
        file: "form.ts",
        load: async () => ({
          default: () => null,
          action: ({ set }) => {
            trace.push("action")
            set.headers["x-action"] = "1"
            set.cookie("example", "public")
            return { saved: true }
          },
          loader: ({ request }) => {
            trace.push(`page:${request.method}`)
            expect(request.headers.get("cookie")).toContain("example=public")
            return null
          },
        }),
      },
    ],
    layouts: {},
    errors: {},
  }
  let rendered: unknown
  const app = createWebApp({
    manifest,
    serverComponents: runtime,
    clientEntry: "/entry.js",
    llmsTxt: false,
    adapter: {
      renderToString: (_chain, props) => {
        rendered = props
        return "public form"
      },
      renderToStream: (_chain, props) => {
        rendered = props
        return new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("public form"))
            c.close()
          },
        })
      },
      hydrationHead: () => "",
    },
    use(app) {
      app.beforeHandle((c) => {
        trace.push(`hook:${c.req.method}`)
        if (denyGet && c.req.method === "GET") return new Response(null, { status: 403 })
        return undefined
      })
    },
  })
  const response = await app.fetch(new Request("https://fixture.test/form", { method: "POST" }))
  expect(response.status).toBe(200)
  await response.text()
  expect(trace).toEqual(["hook:POST", "action", "hook:GET", "page:GET", "authorize", "load"])
  expect(rendered).toMatchObject({
    actionData: { saved: true },
    serverComponents: { records: [{ html: "public" }] },
  })
  expect(response.headers.get("x-action")).toBe("1")
  expect(response.headers.get("set-cookie")).toContain("example=public")
  trace.length = 0
  denyGet = true
  const denied = await app.fetch(new Request("https://fixture.test/form", { method: "POST" }))
  expect(denied.status).toBe(403)
  expect(trace).toEqual(["hook:POST", "action", "hook:GET"])
})

test("an invalid sibling input rejects the whole owner before any component authorization or load", async () => {
  const calls: string[] = []
  const component = defineServerComponent(
    {
      input: t.object({ id: t.string() }),
      props: t.object({}),
      authorize: () => {
        calls.push("authorize")
      },
      load: () => {
        calls.push("load")
        return {}
      },
      view: () => null,
    },
    "preflight",
  )
  const runtime = createServerComponents({
    build: "build_1",
    adapter: { name: "vue", version: 1, render: () => ({ html: "" }) },
    owners: {
      owner: {
        scope: "anonymous",
        components: [component],
        instances: () => [
          serverComponentInstance(component, "valid", { id: "public" }),
          { component, key: "invalid", input: { id: 42 } },
        ],
      },
    },
  })
  const request = new Request("https://fixture.test/")
  await expect(
    runtime.execute("owner", {
      request,
      req: request,
      params: {},
      api: undefined,
      env: undefined,
      draft: false,
      live() {},
      search: {},
      set: { headers: {}, cookie() {}, deleteCookie() {} },
      signal: request.signal,
      data: null,
      layoutData: [],
    }),
  ).rejects.toMatchObject({ code: "component_input" })
  expect(calls).toEqual([])
})

test("a parent refresh executes its allowed subtree once and receives the exact child render", async () => {
  const calls: string[] = []
  const child = defineServerComponent(
    {
      input: t.object({}),
      props: t.object({ title: t.string() }),
      authorize() {},
      load() {
        calls.push("load:child")
        return { title: "child-public" }
      },
      view: ({ props }) => props.title,
    },
    "child",
  )
  const parent = defineServerComponent(
    {
      input: t.object({}),
      props: t.object({ title: t.string() }),
      authorize() {},
      load() {
        calls.push("load:parent")
        return { title: "parent-public" }
      },
      view: ({ props }) => props.title,
    },
    "parent",
  )
  const sibling = defineServerComponent(
    {
      input: t.object({}),
      props: t.object({}),
      authorize() {},
      load() {
        calls.push("load:sibling")
        return {}
      },
      view: () => null,
    },
    "sibling",
  )
  const parentId = await serverComponentIdentity("owner", parent, "parent")
  const runtime = createServerComponents({
    build: "build_1",
    adapter: {
      name: "vue",
      version: 1,
      render: (_view, props, context) => {
        calls.push(`render:${context.reference}`)
        return {
          html:
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The fabricated render adapter is paired with this test definition; the executor validates public props before rendering.
            (props as { title?: string }).title +
            (context.children?.map((record) => record.html).join("") ?? ""),
        }
      },
    },
    owners: {
      owner: {
        scope: "anonymous",
        components: [parent, child, sibling],
        instances: () => [
          serverComponentInstance(parent, "parent", {}),
          serverComponentInstance(child, "child", {}, parentId),
          serverComponentInstance(sibling, "sibling", {}),
        ],
      },
    },
  })
  const request = new Request("https://fixture.test/")
  const state = await runtime.execute(
    "owner",
    {
      request,
      req: request,
      params: {},
      api: undefined,
      env: undefined,
      draft: false,
      live() {},
      search: {},
      set: { headers: {}, cookie() {}, deleteCookie() {} },
      signal: request.signal,
      data: null,
      layoutData: [],
    },
    {
      v: 1,
      build: "build_1",
      reference: "parent",
      key: "parent",
      parent: null,
      input: {},
      generation: 1,
      routeEpoch: 0,
      authEpoch: 0,
    },
  )
  expect(calls).toEqual(["load:child", "render:child", "load:parent", "render:parent"])
  expect(state.records.map((record) => record.reference)).toEqual(["parent", "child"])
  expect(state.records[0]?.html).toBe("parent-publicchild-public")
})

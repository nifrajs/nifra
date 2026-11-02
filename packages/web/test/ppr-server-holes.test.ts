import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { t } from "@nifrajs/schema"
import type { BoundaryRequestCtx, BoundaryStates } from "../src/boundary.ts"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"
import { type HoleRegistration, serverHoleComponent } from "../src/internal/ppr/contract.ts"
import { frameBodyOf } from "../src/internal/ppr/frames.ts"
import { partialPrerendering } from "../src/ppr.ts"
import { DATA_HEADER, HOLE_FILL_HEADER } from "../src/router.ts"
import { serverHole } from "../src/server-components/hole.ts"
import {
  createServerComponents,
  defineServerComponent,
  type ServerComponentContext,
  type ServerComponentRenderAdapter,
} from "../src/server-components.ts"

const ORIGIN = "http://app.test"
const ISLAND = '<nifra-island data-nifra-island="i_1"><button>0</button></nifra-island>'

/** Renders a view as its props' title and one island, as an adapter's native renderer would. */
const componentAdapter: ServerComponentRenderAdapter = {
  name: "vue",
  version: 1,
  render: async (_view, props) => ({
    html: `<section>${typeof props === "object" && props !== null && "title" in props ? String(props.title) : ""}${ISLAND}</section>`,
    islands: [{ reference: "ref_counter", key: "k", props: { start: 0 }, renderId: "i_1" }],
  }),
}

interface Probe {
  authorized: ServerComponentContext[]
  states: BoundaryStates[]
}

function componentApp(
  options: {
    readonly input?: (ctx: BoundaryRequestCtx) => unknown
    readonly authorize?: (ctx: ServerComponentContext) => void
    readonly load?: (ctx: ServerComponentContext) => unknown
    readonly listed?: boolean
    readonly interactive?: boolean
  } = {},
) {
  const probe: Probe = { authorized: [], states: [] }
  const Summary = defineServerComponent(
    {
      input: t.object({ id: t.string() }),
      props: t.object({ title: t.string() }),
      authorize(ctx) {
        probe.authorized.push(ctx)
        options.authorize?.(ctx)
      },
      load: (ctx, input) =>
        options.load?.(ctx) ?? { title: `item ${input.id}`, internal: "PRIVATE_FIELD_17" },
      view: () => null,
    },
    "ref_summary",
  )
  const page = (props: { readonly boundaries?: BoundaryStates }) => {
    if (props.boundaries !== undefined) probe.states.push(props.boundaries)
    return `<main>${Object.keys(props.boundaries ?? {})
      .map((name) => `<div data-nifra-hole="${name}" aria-busy="true"></div>`)
      .join("")}</main>`
  }
  const adapter: RenderAdapter = {
    renderToString: (_chain, props) => page(props),
    renderToStream: (_chain, props) =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(page(props)))
          controller.close()
        },
      }),
    hydrationHead: () => "",
    renderFragment: (ui) => `<p>${String(ui())}</p>`,
  }
  const boundaries: readonly HoleRegistration[] = [
    {
      name: "summary",
      mode: "dynamic",
      interactive: options.interactive === true,
      render: serverHole(Summary),
      load: (ctx: BoundaryRequestCtx) => options.input?.(ctx) ?? { id: ctx.params.id },
    },
    {
      name: "note",
      mode: "dynamic",
      render: (data: { readonly text: string }) => data.text,
      load: () => ({ text: "a note" }),
    },
  ]
  const manifest: Manifest = {
    routes: [
      {
        id: "p/[id]",
        pattern: "/p/:id",
        layoutIds: [],
        layoutParams: [],
        file: "p/[id].tsx",
        load: async () => ({
          default: "page",
          shellLoader: () => ({ title: "shell" }),
          boundaries,
        }),
      },
    ],
    layouts: {},
    notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
  }
  const app = createWebApp({
    adapter,
    manifest,
    clientEntry: "/c.js",
    serverComponents: createServerComponents({
      build: "hole_build",
      adapter: componentAdapter,
      owners: {},
      holes: options.listed === false ? {} : { "p/[id]": { components: [Summary] } },
    }),
    ppr: partialPrerendering({
      shellChecks: "unchecked-development",
      options: { blockingFor: /test-bot/ },
    }),
  })
  return { app, probe }
}

// Hole failures and the fixture's shell warnings are logged; these tests read what responses carry.
let quiet: Array<{ mockRestore(): void }> = []
beforeEach(() => {
  quiet = [
    spyOn(console, "error").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
  ]
})
afterEach(() => {
  for (const spy of quiet) spy.mockRestore()
})

/** Hole `name`'s frame JSON in a streamed document. */
const frameIn = (html: string, name: string) => {
  const start = html.indexOf(`<script type="application/json" id="nifra-ppr:${name}">`)
  expect(start).toBeGreaterThan(-1)
  return frameBodyOf(html.slice(start))
}

const get = async (
  app: ReturnType<typeof componentApp>["app"],
  path: string,
  headers: Record<string, string> = {},
) => app.fetch(new Request(`${ORIGIN}${path}`, { headers }))

/** A whole NDJSON data response: its first line with each deferred value in place. */
async function settled(res: Response): Promise<{ readonly boundaries?: Record<string, unknown> }> {
  const [head = "null", ...rest] = (await res.text()).split("\n").filter((line) => line !== "")
  const values = new Map<number, unknown>()
  for (const line of rest) {
    const value: { readonly i: number; readonly v?: unknown } = JSON.parse(line)
    values.set(value.i, value.v)
  }
  return JSON.parse(head, (_key, value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    "__nifra_deferred" in value &&
    typeof value.__nifra_deferred === "number"
      ? values.get(value.__nifra_deferred)
      : value,
  )
}

test("a hole showing a server component streams its HTML and the record its islands mount from", async () => {
  const { app, probe } = componentApp()
  const res = await get(app, "/p/7", { cookie: "session=ada" })
  const html = await res.text()
  expect(res.headers.get("cache-control")).toContain("no-store")
  const frame = frameIn(html, "summary")
  expect(frame).toMatchObject({
    v: 1,
    html: `<section>item 7${ISLAND}</section>`,
    component: {
      reference: "ref_summary",
      key: "summary",
      parent: null,
      input: { id: "7" },
      islands: [{ reference: "ref_counter", key: "k", props: { start: 0 }, renderId: "i_1" }],
    },
  })
  // The frame carries the HTML once, and the props schema dropped the field the view never saw.
  expect(frame).not.toHaveProperty("component.html")
  expect(html.includes("PRIVATE_FIELD_17")).toBe(false)
  // The component reads this visitor's request, under the hole's own signal.
  expect(probe.authorized[0]?.request.headers.get("cookie")).toBe("session=ada")
  expect(probe.authorized[0]?.params).toEqual({ id: "7" })
  expect(frameIn(html, "note")).toEqual({ v: 1, html: "<p>a note</p>" })
})

test("a data request sends the hole as a host with its fill, so a client navigation can mount it", async () => {
  const { app } = componentApp()
  const payload = await settled(await get(app, "/p/8", { [DATA_HEADER]: "1" }))
  expect(payload.boundaries?.summary).toMatchObject({
    name: "summary",
    status: "pending",
    ppr: true,
    fill: { v: 1, html: `<section>item 8${ISLAND}</section>`, component: { key: "summary" } },
  })
  // A hole the client does not hold as a host gets its data.
  expect(payload.boundaries?.note).toMatchObject({ data: { text: "a note" } })
  expect(payload.boundaries?.note).not.toHaveProperty("ppr")
  const reload = await settled(
    await get(app, "/p/8", { [DATA_HEADER]: "1", [HOLE_FILL_HEADER]: "summary,note" }),
  )
  expect(reload.boundaries?.note).toMatchObject({
    ppr: true,
    fill: { v: 1, html: "<p>a note</p>" },
  })
})

test("a blocking render puts the settled fill in the state, for the host's server HTML", async () => {
  const { app, probe } = componentApp()
  await (await get(app, "/p/9", { "user-agent": "test-bot" })).text()
  expect(probe.states.at(-1)?.summary).toMatchObject({
    ppr: true,
    fill: { v: 1, html: `<section>item 9${ISLAND}</section>` },
  })
  expect(probe.states.at(-1)?.note).toMatchObject({ status: "ready", data: { text: "a note" } })
})

test("an input the component's schema refuses, or an authorize that refuses, shows the error slot", async () => {
  const wrong = componentApp({ input: () => ({ id: 5 }) })
  expect(frameIn(await (await get(wrong.app, "/p/1")).text(), "summary")).toMatchObject({
    error: true,
  })
  const refused = componentApp({
    authorize: () => {
      throw new Response(null, { status: 403 })
    },
  })
  const html = await (await get(refused.app, "/p/1")).text()
  expect(frameIn(html, "summary")).toMatchObject({ error: true })
  expect(frameIn(html, "note")).toEqual({ v: 1, html: "<p>a note</p>" })
})

test("a component in a hole cannot set a cookie: the shell already sent the headers", async () => {
  const { app } = componentApp({
    load: (ctx) => {
      ctx.set.cookie("seen", "1")
      return { title: "never" }
    },
  })
  const res = await get(app, "/p/2")
  expect(frameIn(await res.text(), "summary")).toMatchObject({ error: true })
  expect(res.headers.get("set-cookie")).toBeNull()
})

test("a route whose server component holes the app does not list, or makes interactive, fails", async () => {
  const unlisted = componentApp({ listed: false })
  expect((await get(unlisted.app, "/p/3")).status).toBe(500)
  const interactive = componentApp({ interactive: true })
  expect((await get(interactive.app, "/p/4")).status).toBe(500)
  expect(unlisted.probe.authorized).toEqual([])
  expect(interactive.probe.authorized).toEqual([])
})

test("a route is an owner or hosts holes, never both", () => {
  const Summary = defineServerComponent(
    {
      input: t.object({}),
      props: t.object({}),
      authorize() {},
      load: () => ({}),
      view: () => null,
    },
    "ref_both",
  )
  expect(() =>
    createServerComponents({
      build: "hole_build",
      adapter: componentAdapter,
      owners: {
        "p/[id]": { components: [Summary], scope: "anonymous", instances: () => [] },
      },
      holes: { "p/[id]": { components: [Summary] } },
    }),
  ).toThrow()
})

test("a server component hole's render names its component and renders nothing itself", () => {
  const Summary = defineServerComponent(
    {
      input: t.object({}),
      props: t.object({}),
      authorize() {},
      load: () => ({}),
      view: () => null,
    },
    "ref_render",
  )
  const render = serverHole(Summary)
  expect(serverHoleComponent(render)).toBe(Summary)
  expect(serverHoleComponent(() => null)).toBeUndefined()
  // An adapter that rendered the hole in the browser, past the server's own path, would fail loudly.
  expect(() => render({})).toThrow("renders on the server only")
})

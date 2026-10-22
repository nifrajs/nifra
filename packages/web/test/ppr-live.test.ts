import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import type { BoundaryRequestCtx, SharedHoleCtx } from "../src/boundary.ts"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"
import type { HoleRegistration } from "../src/internal/ppr/contract.ts"
import { createKeyring } from "../src/live/keyring.ts"
import { live } from "../src/live.ts"
import { partialPrerendering } from "../src/ppr.ts"

const SECRET = "s".repeat(32)
const APP_ID = "ppr-live-test"
const ORIGIN = "http://app.test"
const SID = "0123456789abcdef0123456789abcdef"
const CART = "B:cart:p/[id]"
const PRICE = "B:price:p/[id]"
const BROKEN = "B:broken:p/[id]"

const page = (props: { readonly data: unknown; readonly boundaries?: object }) =>
  `<main>${JSON.stringify(props.data)}${Object.keys(props.boundaries ?? {})
    .map((name) => `<div data-nifra-hole="${name}" aria-busy="true"></div>`)
    .join("")}</main>`

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

/** A partially prerendered page whose holes declare live keys, and a live runtime. */
function liveApp() {
  const calls = { cart: 0, price: 0 }
  const boundaries: readonly HoleRegistration[] = [
    {
      name: "cart",
      mode: "dynamic",
      interactive: true,
      render: (data: { readonly count: number }) => `cart ${data.count}`,
      load: (ctx: BoundaryRequestCtx) => {
        calls.cart++
        ctx.live(`cart:${ctx.params.id}`)
        return { count: 2 }
      },
    },
    {
      name: "price",
      mode: "shared",
      revalidate: 60,
      render: (data: { readonly amount: number }) => `price ${data.amount}`,
      load: (ctx: SharedHoleCtx) => {
        calls.price++
        ctx.live(`price:${ctx.params.id}`)
        return { amount: 10 }
      },
    },
    {
      name: "broken",
      mode: "dynamic",
      render: () => "never",
      load: (ctx: BoundaryRequestCtx) => {
        ctx.live("broken:key")
        throw new Error("the broken service is down")
      },
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
    live: live({ secret: SECRET, appId: APP_ID, subject: () => "alice" }),
    experimental: { ppr: partialPrerendering({ shellChecks: "unchecked-development" }) },
  })
  return { app, calls }
}

// The broken hole's failure is logged by kind; these tests read what the responses carry.
let logged: { mockRestore(): void } | undefined
beforeEach(() => {
  logged = spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => logged?.mockRestore())

interface Settled {
  readonly boundaries?: Record<string, Record<string, unknown>>
  readonly live?: { readonly grant?: string; readonly tags?: Record<string, readonly string[]> }
}

/** A whole NDJSON response: its first line with each deferred value in place. */
async function settled(res: Response): Promise<Settled> {
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

const liveLoad = (app: ReturnType<typeof liveApp>["app"], body: Record<string, unknown>) =>
  Promise.resolve(
    app.fetch(
      new Request(`${ORIGIN}/_nifra/live/load`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          path: "/p/1",
          sid: SID,
          frame: "page",
          mode: "load",
          retain: [],
          grants: [],
          ...body,
        }),
      }),
    ),
  )

const ownersOf = async (grant: string | undefined) => {
  const keyring = await createKeyring({ secrets: [SECRET], appId: APP_ID, ttl: 600 })
  return (await keyring.open(grant, Date.now()))?.claims.owners
}

test("a live load grants each hole that loaded, in one frame after the holes", async () => {
  const { app } = liveApp()
  await (await app.fetch(new Request(`${ORIGIN}/p/1`))).text()
  const payload = await settled(await liveLoad(app, { fill: true }))
  expect(payload.boundaries?.cart).toMatchObject({
    ppr: true,
    fill: { v: 1, html: "<p>cart 2</p>" },
  })
  expect(payload.boundaries?.price).toMatchObject({
    ppr: true,
    fill: { v: 1, html: "<p>price 10</p>" },
  })
  expect(payload.boundaries?.broken).toMatchObject({ ppr: true, fill: { v: 1, error: true } })
  const owners = await ownersOf(payload.live?.grant)
  expect(owners?.[CART]?.k).toEqual(["cart:1"])
  // A shared hole's keys come with its stored entry.
  expect(owners?.[PRICE]?.k).toEqual(["price:1"])
  // A hole that did not load owns nothing: its keys are watched for nobody.
  expect(owners?.[BROKEN]).toBeUndefined()
  expect(
    Object.values(payload.live?.tags ?? {})
      .flat()
      .sort(),
  ).toEqual([CART, PRICE])
})

test("a load presenting the grant keeps each hole whose keys did not change", async () => {
  const { app, calls } = liveApp()
  await (await app.fetch(new Request(`${ORIGIN}/p/1`))).text()
  const first = await settled(await liveLoad(app, { fill: true }))
  const grant = first.live?.grant
  const before = calls.cart
  const again = await settled(await liveLoad(app, { fill: true, retain: [CART], grants: [grant] }))
  expect(calls.cart).toBe(before)
  expect(again.boundaries?.cart).toEqual({
    name: "cart",
    mode: "dynamic",
    status: "pending",
    ppr: true,
    kept: true,
  })
  const owners = await ownersOf(again.live?.grant)
  expect(owners?.[CART]?.k).toEqual(["cart:1"])
  expect(owners?.[PRICE]?.k).toEqual(["price:1"])
})

test("the document carries no grant: only a live load issues one", async () => {
  const { app } = liveApp()
  const html = await (await app.fetch(new Request(`${ORIGIN}/p/1`))).text()
  expect(html).toContain('data-nifra-hole="cart"')
  expect(html.includes('"grant"')).toBe(false)
  expect(html.includes('"subjects"')).toBe(false)
})

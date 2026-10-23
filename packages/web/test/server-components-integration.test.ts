import { expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { PAGE_HIDE_EVENT, PAGE_SHOW_EVENT } from "../src/internal/page-events.ts"
import type { ClientRouter, RouterState } from "../src/router.ts"
import {
  type ComponentClientAdapter,
  ComponentController,
} from "../src/server-components/client.ts"
import {
  componentControllers,
  invalidateComponentScope,
} from "../src/server-components/registry.ts"
import {
  bindComponentRouter,
  refreshAfterComponentMutation,
} from "../src/server-components/router-integration.ts"
import type { ComponentState, ServerComponentContext } from "../src/server-components/types.ts"
import {
  createServerComponents,
  defineComponentOwner,
  defineServerComponent,
  serverComponentInstance,
} from "../src/server-components.ts"

const initial: ComponentState = {
  v: 1,
  build: "build_1",
  adapter: "vue",
  owner: "owner_1",
  scope: "scope_1",
  records: [],
}
const adapter: ComponentClientAdapter = {
  name: "vue",
  prepare: () => null,
  hydrate: () => ({ update() {}, dispose() {} }),
  update() {},
}

test("component GET owners reject domain writes and undeclared capabilities", () => {
  const owner = defineComponentOwner({
    components: [],
    scope: "anonymous",
    capabilities: ["catalog.read", "telemetry.write"],
    instances: () => [],
  })
  const renderAdapter = {
    name: "vue" as const,
    version: 1 as const,
    render: () => ({ v: 1 as const, html: "" }),
  }
  const capabilities = [
    { id: "catalog.read", zone: "domain" as const, access: "read" as const },
    { id: "telemetry.write", zone: "operational" as const, access: "write" as const },
    { id: "catalog.write", zone: "domain" as const, access: "write" as const },
  ]
  const options = {
    build: "build_1",
    adapter: renderAdapter,
    capabilities,
    owners: { owner },
  }
  const runtime = createServerComponents(options)
  expect(runtime.owns("owner")).toBe(true)
  expect(runtime.capabilities("owner")).toEqual(["catalog.read", "telemetry.write"])
  for (const capability of ["catalog.write", "catalog.missing"])
    expect(() =>
      createServerComponents({
        ...options,
        owners: { owner: { ...owner, capabilities: [capability] } },
      }),
    ).toThrow("component_contract")
})
class ObservedController extends ComponentController {
  readonly trace: string[] = []
  failInvalidation = false
  override cancelPending(): void {
    this.trace.push("cancel")
    super.cancelPending()
  }
  override async navigate(): Promise<void> {
    this.trace.push("navigate")
    await super.navigate()
  }
  override async adopt(value: ComponentState, url?: string): Promise<void> {
    this.trace.push("adopt")
    await super.adopt(value, url)
  }
  override async refresh(instance: string): Promise<boolean> {
    this.trace.push(`refresh:${instance}`)
    return true
  }
  override park(page: Node): void {
    this.trace.push(`park:${String(Reflect.get(page, "name"))}`)
    super.park(page)
  }
  override unpark(page: Node): void {
    this.trace.push(`unpark:${String(Reflect.get(page, "name"))}`)
    super.unpark(page)
  }
  override async invalidateScope(): Promise<void> {
    this.trace.push("invalidate")
    if (this.failInvalidation) throw new Error("native teardown failed")
    await super.invalidateScope()
  }
}

test("router transitions cancel pending owners, adopt verified data and report invalid data", async () => {
  const saved = [...componentControllers]
  componentControllers.clear()
  const errors: string[] = []
  const controller = new ObservedController({
    state: initial,
    adapter,
    onError: (code) => errors.push(code),
  })
  let value: RouterState = {
    routeId: "owner",
    data: null,
    params: {},
    path: "/owner",
    pending: false,
  }
  let notify: (() => void) | undefined
  let stopped = false
  const router: Pick<ClientRouter, "snapshot" | "subscribe"> = {
    snapshot: () => value,
    subscribe(listener) {
      notify = listener
      return () => {
        stopped = true
      }
    },
  }
  const stop = bindComponentRouter(router)
  try {
    value = { ...value, pending: true, pendingPath: "/next" }
    notify?.()
    notify?.()
    expect(controller.trace).toEqual(["cancel"])
    value = { ...value, pending: false, path: "/next" }
    notify?.()
    await new Promise((accept) => setTimeout(accept, 0))
    expect(controller.trace).toContain("navigate")
    value = { ...value, serverComponents: { ...initial, scope: "scope_2" } }
    notify?.()
    await new Promise((accept) => setTimeout(accept, 0))
    expect(controller.state.scope).toBe("scope_2")
    value = { ...value, serverComponents: { ...initial, adapter: "solid" } }
    notify?.()
    await new Promise((accept) => setTimeout(accept, 0))
    expect(errors).toEqual(["component_failed"])
    stop()
    expect(stopped).toBe(true)
  } finally {
    await controller.dispose()
    for (const item of saved) componentControllers.add(item)
  }
})

test("the router binding parks the components of a kept page from its page events", () => {
  const saved = [...componentControllers]
  componentControllers.clear()
  // Each restored as it was: a `document` left defined, even as undefined, turns off code generation
  // in the output guard for every later test in the process.
  const globals = ["document", "Node"].map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  )
  class FakeNode {
    constructor(readonly name: string) {}
    contains(): boolean {
      return false
    }
  }
  const listeners = new Map<string, Set<(event: Event) => void>>()
  Reflect.set(globalThis, "Node", FakeNode)
  Reflect.set(globalThis, "document", {
    addEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener))
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener)
    },
  })
  const fire = (type: string, target: unknown): void => {
    // biome-ignore lint/plugin/noChainedTypeAssertions: a plain object stands in for an event
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the binding reads only `type` and `target` off a page event
    const event = { type, target } as unknown as Event
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
  }
  const controller = new ObservedController({ state: initial, adapter })
  const value: RouterState = { routeId: "owner", data: null, params: {}, path: "/", pending: false }
  try {
    const stop = bindComponentRouter({ snapshot: () => value, subscribe: () => () => {} })
    fire(PAGE_HIDE_EVENT, new FakeNode("list"))
    fire(PAGE_SHOW_EVENT, new FakeNode("list"))
    fire(PAGE_HIDE_EVENT, null)
    stop()
    fire(PAGE_HIDE_EVENT, new FakeNode("detail"))
    expect(controller.trace).toEqual(["park:list", "unpark:list"])
  } finally {
    componentControllers.clear()
    for (const item of saved) componentControllers.add(item)
    for (const [name, descriptor] of globals)
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
      else Object.defineProperty(globalThis, name, descriptor)
  }
})

test("mutation integration deduplicates instance refreshes and never refreshes failed writes", async () => {
  const controller = new ObservedController({ state: initial, adapter })
  try {
    const denied = { ok: false, reason: "denied" }
    expect(await refreshAfterComponentMutation(Promise.resolve(denied), controller, ["one"])).toBe(
      denied,
    )
    expect(controller.trace).toEqual([])
    const success = { ok: true, revision: 2 }
    expect(
      await refreshAfterComponentMutation(Promise.resolve(success), controller, [
        "one",
        "one",
        "two",
      ]),
    ).toBe(success)
    expect(controller.trace).toEqual(["refresh:one", "refresh:two"])
  } finally {
    await controller.dispose()
  }
})

test("scope invalidation broadcasts only a token and reports cross-tab teardown failure", async () => {
  const saved = [...componentControllers]
  componentControllers.clear()
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window")
  const channelBefore = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel")
  const channels: LocalChannel[] = []
  class LocalChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null
    readonly sent: unknown[] = []
    closed = false
    constructor(readonly name: string) {
      channels.push(this)
    }
    postMessage(value: unknown): void {
      this.sent.push(value)
    }
    close(): void {
      this.closed = true
    }
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} })
  Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: LocalChannel })
  const errors: string[] = []
  const controller = new ObservedController({
    state: initial,
    adapter,
    onError: (code) => errors.push(code),
  })
  try {
    expect(channels).toHaveLength(1)
    const channel = channels[0]!
    expect(channel.name).toBe("nifra-component-scope-v1")
    channel.onmessage?.({ data: { private: "fabricated" } })
    expect(controller.trace).toEqual([])
    await invalidateComponentScope()
    expect(channel.sent).toEqual([1])
    controller.failInvalidation = true
    channel.onmessage?.({ data: 1 })
    await new Promise((accept) => setTimeout(accept, 0))
    expect(errors).toEqual(["component_failed"])
    controller.failInvalidation = false
    await controller.dispose()
    expect(channel.closed).toBe(true)
  } finally {
    await controller.dispose()
    if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore)
    else Reflect.deleteProperty(globalThis, "window")
    if (channelBefore) Object.defineProperty(globalThis, "BroadcastChannel", channelBefore)
    else Reflect.deleteProperty(globalThis, "BroadcastChannel")
    for (const item of saved) componentControllers.add(item)
  }
})

test("native render records and HTTP controls stay bounded and private", async () => {
  const component = defineServerComponent(
    {
      input: t.object({}),
      props: t.object({ title: t.string() }),
      authorize() {},
      load: () => ({ title: "Public", internal: "fabricated-private" }),
      view: () => null,
    },
    "reference_1",
  )
  const runtime = createServerComponents({
    build: "build_1",
    adapter: {
      name: "vue",
      version: 1,
      render(_view, props, context) {
        expect(props).toEqual({ title: "Public" })
        return {
          html: "<p>Public</p>",
          payload: { value: "Public" },
          islands: [
            {
              reference: "island_1",
              key: "stable",
              props: { title: "Public" },
              renderId: `${context.instance}_island`,
            },
          ],
        }
      },
    },
    owners: {
      owner: {
        components: [component],
        scope: "anonymous",
        instances: () => [serverComponentInstance(component, "stable", {})],
      },
    },
  })
  const request = new Request("https://fixture.test/owner")
  const context: ServerComponentContext = {
    request,
    req: request,
    params: {},
    api: undefined,
    env: undefined,
    draft: false,
    live() {},
    search: {},
    data: null,
    layoutData: [],
    signal: request.signal,
    set: { headers: {}, cookie() {}, deleteCookie() {} },
  }
  const state = await runtime.execute("owner", context)
  expect(state.records[0]?.islands?.[0]?.props).toEqual({ title: "Public" })
  for (const status of [201, 303, 403, 418]) {
    const response = runtime.failure(
      new Response(null, { status, headers: { "cache-control": "public", location: "/login" } }),
    )
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    if (status === 201) expect(await response.json()).toEqual({ v: 1, control: { status: 201 } })
    else expect(response.status).toBe(status)
  }
})

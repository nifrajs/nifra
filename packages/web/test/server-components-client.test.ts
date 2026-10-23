import { afterAll, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import {
  type ComponentClientAdapter,
  ComponentController,
  type ComponentState,
  resolveComponentRecord,
} from "../src/server-components/client.ts"
import { componentFrames } from "../src/server-components/frames.ts"
import { COMPONENT_MEDIA_TYPE, readComponentRequest } from "../src/server-components/protocol.ts"

const locationBefore = Object.getOwnPropertyDescriptor(globalThis, "location")
Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { href: "https://fixture.test/owner", origin: "https://fixture.test" },
})
afterAll(() => {
  if (locationBefore === undefined) Reflect.deleteProperty(globalThis, "location")
  else Object.defineProperty(globalThis, "location", locationBefore)
})
const state = (scope = "scope_1", revision = "public", input = {}): ComponentState => ({
  v: 1,
  build: "build_1",
  adapter: "vue",
  owner: "owner_1",
  scope,
  records: [
    {
      reference: "reference_1",
      instance: "instance_1",
      parent: null,
      key: "stable",
      input,
      html: revision,
    },
  ],
})

test("a compiled browser generation mismatch refuses hydration and reloads at most once", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "__NIFRA_COMPONENT_BUILD__")
  Object.defineProperty(globalThis, "__NIFRA_COMPONENT_BUILD__", {
    configurable: true,
    value: "compiled_build",
  })
  let reloads = 0
  const errors: string[] = []
  try {
    const h = harness()
    for (let index = 0; index < 2; index++)
      expect(
        () =>
          new ComponentController({
            state: { ...state(), build: "stale_fixture_build" },
            adapter: h.adapter,
            reload: () => {
              reloads++
            },
            onError: (code) => errors.push(code),
          }),
      ).toThrow()
    expect(reloads).toBe(1)
    expect(errors).toEqual(["component_version"])
    expect(h.trace).toEqual([])
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "__NIFRA_COMPONENT_BUILD__")
    else Object.defineProperty(globalThis, "__NIFRA_COMPONENT_BUILD__", previous)
  }
})
test("untrusted hydration HTML and hidden managed slots fail before a native root can mount", () => {
  const h = harness()
  const initial = state()
  const record = initial.records[0]!
  for (const records of [
    [{ ...record, html: '<img src="x" onerror="alert(1)">' }],
    [
      {
        ...record,
        islands: [
          {
            reference: "island",
            key: "stable",
            renderId: "render",
            props: {},
            slots: { summary: '<svg onload="alert(1)"></svg>' },
          },
        ],
      },
    ],
  ]) {
    expect(
      () => new ComponentController({ state: { ...initial, records }, adapter: h.adapter }),
    ).toThrow()
  }
  expect(h.trace).toEqual([])
})
function harness() {
  const trace: string[] = []
  // Pure controller tests use a host token; the actual DOM/native roots run in the browser suite.
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: These controller-only host tokens implement the exercised methods; the real DOM/native ABI is covered by the three-engine browser suite.
  const host = {} as Element
  const adapter: ComponentClientAdapter = {
    name: "vue",
    prepare: (record) => record.html,
    hydrate: (_host, record) => {
      trace.push(`hydrate:${record.html}`)
      return {
        update() {},
        dispose() {
          trace.push(`dispose:${record.html}`)
        },
      }
    },
    create: (_host, record) => {
      trace.push(`create:${record.html}`)
      return {
        update() {},
        dispose() {
          trace.push(`dispose:${record.html}`)
        },
      }
    },
    update: (_root, record, _prepared, current) => {
      if (current()) trace.push(`update:${record.html}`)
    },
  }
  return { trace, host, adapter }
}

test("typed outlet lookup treats reordered public input fields as the same resource", () => {
  const initial = state("scope_1", "public", { id: "resource", filter: "public" })
  const handle = {
    reference: "reference_1",
    input: t.object({ id: t.string(), filter: t.string() }),
  }
  expect(
    resolveComponentRecord(initial, handle, "stable", { filter: "public", id: "resource" })
      .instance,
  ).toBe("instance_1")
  expect(() =>
    resolveComponentRecord(initial, handle, "stable", { filter: "public", id: "other" }),
  ).toThrow()
})

test("native readiness resolves mount waiters and cancels waiters when their owner is disposed", async () => {
  const h = harness()
  const controller = new ComponentController({ state: state(), adapter: h.adapter })
  const ready = controller.whenReady("instance_1")
  await controller.mount(h.host, "instance_1")
  await ready
  await controller.whenReady("instance_1")
  await expect(controller.whenReady("missing")).rejects.toMatchObject({
    code: "component_unavailable",
  })
  await controller.dispose()
  const other = new ComponentController({ state: state(), adapter: h.adapter })
  const cancelled = other.whenReady("instance_1")
  const outcome = cancelled.then(
    () => {
      throw new Error("Disposed owner unexpectedly became ready")
    },
    (error: unknown) => error,
  )
  await other.dispose()
  expect(await outcome).toMatchObject({ code: "component_cancelled" })
})

test("route adoption preserves native state when equivalent input fields arrive in another order", async () => {
  const h = harness()
  const controller = new ComponentController({
    state: state("scope_1", "old", { id: "resource", filter: { mode: "public", count: 1 } }),
    adapter: h.adapter,
  })
  try {
    await controller.mount(h.host, "instance_1")
    await controller.adopt(
      state("scope_1", "new", { filter: { count: 1, mode: "public" }, id: "resource" }),
    )
    expect(h.trace).toEqual(["hydrate:old", "update:new"])
  } finally {
    await controller.dispose()
  }
})

test("owner adoption disposes an old auth scope and creates authorized roots for stable identities", async () => {
  const h = harness()
  const controller = new ComponentController({ state: state(), adapter: h.adapter })
  try {
    await controller.mount(h.host, "instance_1")
    await controller.adopt(state("scope_2", "new-public"))
    expect(h.trace).toEqual(["hydrate:public", "dispose:public", "create:new-public"])
    expect(controller.state.scope).toBe("scope_2")
  } finally {
    await controller.dispose()
  }
})
test("changed resource input replaces the native root even when the explicit key is stable", async () => {
  const h = harness()
  const controller = new ComponentController({ state: state(), adapter: h.adapter })
  try {
    await controller.mount(h.host, "instance_1")
    await controller.adopt(state("scope_1", "new-public", { resource: "next" }))
    expect(h.trace).toEqual(["hydrate:public", "dispose:public", "create:new-public"])
  } finally {
    await controller.dispose()
  }
})
test("scope invalidation clears private controller payloads and a subsequent verified adoption can mount", async () => {
  const h = harness()
  const controller = new ComponentController({ state: state(), adapter: h.adapter })
  try {
    await controller.mount(h.host, "instance_1")
    await controller.invalidateScope()
    expect(controller.state.records).toEqual([])
    await controller.adopt(state("scope_2", "next-public"))
    expect(h.trace).toEqual(["hydrate:public", "dispose:public", "create:next-public"])
  } finally {
    await controller.dispose()
  }
})
test("failed preparation can be retried without retaining an orphan mount", async () => {
  const h = harness()
  let first = true
  h.adapter.prepare = () => {
    if (first) {
      first = false
      throw new Error("fixture failure")
    }
    return null
  }
  const controller = new ComponentController({ state: state(), adapter: h.adapter })
  try {
    await expect(controller.mount(h.host, "instance_1")).rejects.toThrow()
    await controller.mount(h.host, "instance_1")
    expect(h.trace).toEqual(["hydrate:public"])
  } finally {
    await controller.dispose()
  }
})

const refreshedResponse: NonNullable<
  import("../src/server-components/client.ts").ComponentControllerOptions["fetch"]
> = async (url, init) => {
  const selection = readComponentRequest(
    new Request(url, { ...init, headers: { ...init?.headers, "sec-fetch-site": "same-origin" } }),
  )!
  const next = state("scope_1", "next")
  return new Response(
    componentFrames(
      {
        ...selection,
        input: undefined,
        adapter: next.adapter,
        owner: next.owner,
        scope: next.scope,
        instance: "instance_1",
      },
      next,
    ),
    { headers: { "content-type": COMPONENT_MEDIA_TYPE } },
  )
}

test("failed decode and preparation retain the last authorized native tree", async () => {
  for (const failure of ["decode", "prepare"] as const) {
    const h = harness()
    const controller = new ComponentController({
      state: state(),
      adapter: h.adapter,
      fetch:
        failure === "prepare"
          ? refreshedResponse
          : async () =>
              new Response("invalid", { headers: { "content-type": COMPONENT_MEDIA_TYPE } }),
    })
    try {
      await controller.mount(h.host, "instance_1")
      if (failure === "prepare")
        h.adapter.prepare = () => {
          throw new Error("fixture preparation")
        }
      await expect(controller.refresh("instance_1")).rejects.toThrow()
      expect(h.trace).toEqual(["hydrate:public"])
      expect(controller.state.records[0]?.html).toBe("public")
      h.adapter.prepare = (record) => record.html
    } finally {
      await controller.dispose()
    }
  }
})

test("a failed native commit disposes once and permits a verified remount", async () => {
  const h = harness()
  const controller = new ComponentController({
    state: state(),
    adapter: h.adapter,
    fetch: refreshedResponse,
  })
  try {
    await controller.mount(h.host, "instance_1")
    h.adapter.update = () => {
      throw new Error("fixture native commit")
    }
    await expect(controller.refresh("instance_1")).rejects.toThrow()
    expect(h.trace).toEqual(["hydrate:public", "dispose:public"])
    await controller.mount(h.host, "instance_1")
    expect(h.trace).toEqual(["hydrate:public", "dispose:public", "hydrate:public"])
  } finally {
    await controller.dispose()
  }
})

test("only a typed generation failure reloads; busy and ordinary conflicts retain state", async () => {
  for (const [status, body, expected] of [
    [409, { conflict: true }, "component_failed"],
    [429, { v: 1, error: "component_busy" }, "component_busy"],
    [504, { v: 1, error: "component_timeout" }, "component_timeout"],
    [409, { v: 1, error: "component_version" }, "component_version"],
  ] as const) {
    const h = harness()
    let reloads = 0
    const controller = new ComponentController({
      state: { ...state(), build: `failure_${expected}` },
      adapter: h.adapter,
      reload: () => {
        reloads++
      },
      fetch: async () => Response.json(body, { status }),
    })
    try {
      await controller.mount(h.host, "instance_1")
      if (expected === "component_version")
        expect(await controller.refresh("instance_1")).toBe(false)
      else
        await expect(controller.refresh("instance_1")).rejects.toMatchObject({
          code: expected,
          status,
        })
      expect(reloads).toBe(expected === "component_version" ? 1 : 0)
      expect(h.trace).toEqual(["hydrate:public"])
    } finally {
      await controller.dispose()
    }
  }
})

test("parallel parent refreshes release admission before mounting new descendants", async () => {
  const roots = Array.from({ length: 4 }, (_, index) => ({
    instance: `parent_${index}`,
    reference: "reference_1",
    parent: null,
    key: index,
    input: {},
    html: "initial",
  }))
  const hosts = new Map<string, Element>()
  for (const record of roots) {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: These controller-only host tokens implement the exercised methods; the real DOM/native ABI is covered by the three-engine browser suite.
    hosts.set(record.instance, {
      querySelectorAll: () => [],
      childNodes: [1],
    } as unknown as Element)
  }
  const adapter: ComponentClientAdapter = {
    name: "vue",
    prepare: () => null,
    hydrate: () => ({ update() {}, dispose() {} }),
    create: () => ({ update() {}, dispose() {} }),
    update(_root, record) {
      const host = hosts.get(record.instance)!
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: These controller-only host tokens implement the exercised methods; the real DOM/native ABI is covered by the three-engine browser suite.
      const child = {
        childNodes: [1],
        getAttribute: () => `${record.instance}_child`,
        parentElement: { closest: () => host },
      } as unknown as Element
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: These controller-only host tokens implement the exercised methods; the real DOM/native ABI is covered by the three-engine browser suite.
      host.querySelectorAll = (() => [child]) as unknown as Element["querySelectorAll"]
    },
  }
  const controller = new ComponentController({
    state: { ...state(), records: roots },
    adapter,
    fetch: async (url, init) => {
      const request = new Request(url, {
        ...init,
        headers: { ...init?.headers, "sec-fetch-site": "same-origin" },
      })
      const selection = readComponentRequest(request)!
      const root = roots.find((record) => record.key === selection.key)!
      const next = {
        ...state(),
        records: [
          { ...root, html: "next" },
          { ...root, instance: `${root.instance}_child`, parent: root.instance },
        ],
      }
      return new Response(
        componentFrames(
          {
            ...selection,
            input: undefined,
            adapter: next.adapter,
            owner: next.owner,
            scope: next.scope,
            instance: root.instance,
          },
          next,
        ),
        { headers: { "content-type": COMPONENT_MEDIA_TYPE } },
      )
    },
  })
  try {
    await Promise.all(
      roots.map((record) => controller.mount(hosts.get(record.instance)!, record.instance)),
    )
    expect(await Promise.all(roots.map((record) => controller.refresh(record.instance)))).toEqual([
      true,
      true,
      true,
      true,
    ])
  } finally {
    await controller.dispose()
  }
})

test("a later child refresh cancels an older parent payload before it can overwrite the subtree", async () => {
  const h = harness()
  const parent = state().records[0]!
  const child = { ...parent, instance: "child_1", parent: parent.instance, key: "child" }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: These controller-only host tokens implement the exercised methods; the real DOM/native ABI is covered by the three-engine browser suite.
  const childHost = {
    childNodes: [1],
    getAttribute: () => child.instance,
    parentElement: { closest: () => h.host },
  } as unknown as Element
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: These controller-only host tokens implement the exercised methods; the real DOM/native ABI is covered by the three-engine browser suite.
  h.host.querySelectorAll = (() => [childHost]) as unknown as Element["querySelectorAll"]
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => {
    started = resolve
  })
  const controller = new ComponentController({
    state: { ...state(), records: [parent, child] },
    adapter: h.adapter,
    fetch: async (url, init) => {
      const selection = readComponentRequest(
        new Request(url, {
          ...init,
          headers: { ...init?.headers, "sec-fetch-site": "same-origin" },
        }),
      )!
      const selected = selection.key === "child" ? child : parent
      if (selected === parent) {
        started()
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      const next = {
        ...state(),
        records:
          selected === child
            ? [{ ...child, html: "latest-child" }]
            : [
                { ...parent, html: "old-parent" },
                { ...child, html: "old-child" },
              ],
      }
      return new Response(
        componentFrames(
          {
            ...selection,
            input: undefined,
            adapter: next.adapter,
            owner: next.owner,
            scope: next.scope,
            instance: selected.instance,
          },
          next,
        ),
        { headers: { "content-type": COMPONENT_MEDIA_TYPE } },
      )
    },
  })
  try {
    await controller.mount(h.host, parent.instance)
    const old = controller.refresh(parent.instance)
    await waiting
    expect(await controller.refresh(child.instance)).toBe(true)
    release()
    expect(await old).toBe(false)
    expect(
      controller.state.records.find((record) => record.instance === child.instance)?.html,
    ).toBe("latest-child")
    expect(h.trace).not.toContain("update:old-child")
  } finally {
    await controller.dispose()
  }
})
test("an obsolete adoption cannot update after a later route adoption", async () => {
  const h = harness()
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  h.adapter.prepare = async (record) => {
    if (record.html === "old") {
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    return record.html
  }
  const controller = new ComponentController({ state: state(), adapter: h.adapter })
  try {
    await controller.mount(h.host, "instance_1")
    const old = controller.adopt(state("scope_1", "old"))
    await waiting
    await controller.adopt(state("scope_1", "latest"))
    release()
    await old
    expect(h.trace).toEqual(["hydrate:public", "update:latest"])
    expect(controller.state.records[0]?.html).toBe("latest")
  } finally {
    await controller.dispose()
  }
})

/** A refresh response carrying `next` as the frames for whatever instance the request selected. */
const respondWith =
  (
    next: ComponentState,
  ): NonNullable<
    import("../src/server-components/client.ts").ComponentControllerOptions["fetch"]
  > =>
  async (url, init) => {
    const selection = readComponentRequest(
      new Request(url, { ...init, headers: { ...init?.headers, "sec-fetch-site": "same-origin" } }),
    )!
    return new Response(
      componentFrames(
        {
          ...selection,
          input: undefined,
          adapter: next.adapter,
          owner: next.owner,
          scope: next.scope,
          instance: next.records[0]?.instance,
        },
        next,
      ),
      { headers: { "content-type": COMPONENT_MEDIA_TYPE } },
    )
  }

async function refreshWith(
  fetch: NonNullable<
    import("../src/server-components/client.ts").ComponentControllerOptions["fetch"]
  >,
) {
  const h = harness()
  const navigated: string[] = []
  const errors: string[] = []
  const controller = new ComponentController({
    state: state(),
    adapter: h.adapter,
    fetch,
    navigate: (url) => navigated.push(url),
    onError: (code) => errors.push(code),
  })
  await controller.mount(h.host, "instance_1")
  const outcome = await controller.refresh("instance_1").then(
    (value) => value,
    (error: { code?: string }) => error.code ?? "thrown",
  )
  const records = controller.state.records.length
  const trace = [...h.trace]
  await controller.dispose()
  return { outcome, navigated, errors, records, trace }
}

test("a controller refuses another adapter's state and a second mount of one instance", async () => {
  const h = harness()
  expect(
    () => new ComponentController({ state: state(), adapter: { ...h.adapter, name: "svelte" } }),
  ).toThrow(expect.objectContaining({ code: "component_version" }))
  const controller = new ComponentController({ state: state(), adapter: h.adapter })
  try {
    await controller.mount(h.host, "instance_1")
    await expect(controller.mount(h.host, "instance_1")).rejects.toMatchObject({
      code: "component_contract",
    })
  } finally {
    await controller.dispose()
  }
})

test("a refresh answered by a redirect navigates to the owner instead", async () => {
  const result = await refreshWith(async () => new Response(null, { status: 302 }))
  expect(result).toMatchObject({ outcome: false, navigated: ["https://fixture.test/owner"] })
})

test("a refresh the server denies invalidates the scope", async () => {
  const result = await refreshWith(async () => new Response(null, { status: 403 }))
  expect(result).toMatchObject({ outcome: false, errors: ["component_denied"], records: 0 })
})

test("a terminal control answer navigates, and a malformed one is a protocol error", async () => {
  const control =
    (body: string | null, header = "200") =>
    async () =>
      new Response(body, { headers: { "x-nifra-component-control": header } })
  const done = await refreshWith(control('{"v":1,"control":{"status":200}}'))
  expect(done).toMatchObject({ outcome: false, navigated: ["https://fixture.test/owner"] })
  for (const [body, header] of [
    [null, "200"],
    ["{not json", "200"],
    ["[1]", "200"],
    ['{"v":2,"control":{"status":200}}', "200"],
    ['{"v":1,"control":{"status":302}}', "302"],
    ['{"v":1,"control":{"status":200}}', "204"],
  ] as const) {
    const refused = await refreshWith(control(body, header))
    expect(refused).toMatchObject({ outcome: "component_protocol", navigated: [] })
  }
})

test("a refresh whose frames break the protocol keeps the mounted tree", async () => {
  const base = state("scope_1", "next")
  const child = {
    ...base.records[0]!,
    instance: "orphan",
    parent: "ghost",
    reference: "reference_2",
  }
  for (const fetch of [
    async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    respondWith({ ...base, build: "build_2" }),
    respondWith({ ...base, records: [...base.records, child] }),
  ]) {
    const result = await refreshWith(fetch)
    expect(result).toMatchObject({ outcome: "component_protocol", trace: ["hydrate:public"] })
  }
})

test("a refresh answered for another auth scope invalidates instead of updating", async () => {
  const result = await refreshWith(respondWith(state("scope_2", "next")))
  expect(result).toMatchObject({
    outcome: false,
    errors: ["component_denied"],
    records: 0,
    trace: ["hydrate:public"],
  })
})

// A `keepAlive` page and the outlet hosts inside it, for the controller's parking.
function page(...hosts: Element[]): Node {
  const contains = (node: unknown): boolean => hosts.some((host) => host === node)
  // biome-ignore lint/plugin/noChainedTypeAssertions: a plain object stands in for a page element
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: parking reads only `contains` off a page
  return { contains } as unknown as Node
}
function outletHost(name: string, rendered = true): Element {
  // biome-ignore lint/plugin/noChainedTypeAssertions: a plain object stands in for an outlet host
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the controller reads only `contains` and `childNodes` off a host here
  return { name, contains: () => false, childNodes: rendered ? [name] : [] } as unknown as Element
}
function hostAdapter() {
  const trace: string[] = []
  const nameOf = (host: Element): string => String(Reflect.get(host, "name"))
  const root = (host: Element, record: { readonly html: string }) => ({
    update() {},
    dispose() {
      trace.push(`dispose:${nameOf(host)}:${record.html}`)
    },
  })
  const adapter: ComponentClientAdapter = {
    name: "vue",
    prepare: (record) => record.html,
    hydrate: (host, record) => {
      trace.push(`hydrate:${nameOf(host)}:${record.html}`)
      return root(host, record)
    },
    create: (host, record) => {
      trace.push(`create:${nameOf(host)}:${record.html}`)
      return root(host, record)
    },
    update: (root, record, _prepared, current) => {
      if (current()) trace.push(`update:${record.html}`)
      void root
    },
  }
  return { trace, adapter }
}
const empty = (): ComponentState => ({ ...state(), records: [] })

test("a parked page's components outlive the navigations away and update once it is back", async () => {
  const { trace, adapter } = hostAdapter()
  const host = outletHost("a")
  const controller = new ComponentController({ state: state(), adapter })
  try {
    await controller.mount(host, "instance_1")
    controller.park(page(host))
    await controller.adopt(empty())
    await controller.navigate()
    expect(trace).toEqual(["hydrate:a:public"])
    await controller.adopt(state("scope_1", "kept"))
    controller.unpark(page(host))
    await controller.adopt(state("scope_1", "fresh"))
    expect(trace).toEqual(["hydrate:a:public", "update:fresh"])
  } finally {
    await controller.dispose()
  }
  expect(trace.at(-1)).toBe("dispose:a:public")
})

test("a parked instance frees its id for another page, and the outlet's host tells them apart", async () => {
  const { trace, adapter } = hostAdapter()
  const [a, b] = [outletHost("a"), outletHost("b")]
  const controller = new ComponentController({ state: state(), adapter })
  try {
    await controller.mount(a, "instance_1")
    controller.park(page(a))
    await controller.mount(b, "instance_1")
    await controller.unmount("instance_1", a)
    expect(trace).toEqual(["hydrate:a:public", "hydrate:b:public", "dispose:a:public"])
    await controller.adopt(state("scope_1", "next"))
    expect(trace.at(-1)).toBe("update:next")
  } finally {
    await controller.dispose()
  }
})

test("a page shown again while its instance is mounted elsewhere releases its parked copy", async () => {
  const { trace, adapter } = hostAdapter()
  const [a, b] = [outletHost("a"), outletHost("b")]
  const controller = new ComponentController({ state: state(), adapter })
  try {
    await controller.mount(a, "instance_1")
    controller.park(page(a))
    await controller.mount(b, "instance_1")
    controller.unpark(page(a))
    await Bun.sleep(0)
    expect(trace).toEqual(["hydrate:a:public", "hydrate:b:public", "dispose:a:public"])
  } finally {
    await controller.dispose()
  }
  expect(trace).toEqual([
    "hydrate:a:public",
    "hydrate:b:public",
    "dispose:a:public",
    "dispose:b:public",
  ])
})

test("a page hidden while its components hydrate mounts them again once it is shown", async () => {
  const { trace, adapter } = hostAdapter()
  for (const host of [outletHost("a"), outletHost("b", false)]) {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = true
    const gated: ComponentClientAdapter = {
      ...adapter,
      prepare: async (...args) => {
        if (held) {
          held = false
          await gate
        }
        return adapter.prepare(...args)
      },
    }
    const controller = new ComponentController({ state: state(), adapter: gated })
    const errors: string[] = []
    try {
      const mounting = controller.mount(host, "instance_1").catch((error: unknown) => {
        errors.push(String(error))
      })
      await Bun.sleep(0)
      controller.park(page(host))
      release()
      await mounting
      expect(errors).toEqual([])
      controller.unpark(page(host))
      await controller.whenReady("instance_1")
    } finally {
      await controller.dispose()
    }
  }
  // Hydrating over the server's markup when it is still there, else creating it.
  expect(trace).toEqual([
    "hydrate:a:public",
    "dispose:a:public",
    "create:b:public",
    "dispose:b:public",
  ])
})

test("a scope change releases parked components with the rest", async () => {
  const { trace, adapter } = hostAdapter()
  const host = outletHost("a")
  const controller = new ComponentController({ state: state(), adapter })
  try {
    await controller.mount(host, "instance_1")
    controller.park(page(host))
    await controller.invalidateScope()
    expect(trace).toEqual(["hydrate:a:public", "dispose:a:public"])
    controller.unpark(page(host))
    await controller.adopt(state("scope_2", "next"))
    expect(trace).toEqual(["hydrate:a:public", "dispose:a:public"])
  } finally {
    await controller.dispose()
  }
})

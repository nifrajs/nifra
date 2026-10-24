import { afterAll, beforeAll, expect, test } from "bun:test"
import { createSlotParking } from "@nifrajs/web/keep-alive"
import {
  type ComponentClientAdapter,
  ComponentController,
  type ServerComponent as ComponentHandle,
  type ComponentState,
} from "@nifrajs/web/server-components/client"
import { GlobalWindow } from "happy-dom"
import * as React from "react"
import { act, type ComponentType, createElement, type ReactNode } from "react"
import type { ServerComponentProps } from "../src/server-components/outlet.ts"

// The React outlet on a kept page, in a happy-dom document: `<Activity>` cleans up a hidden page's
// effects, which must not take the native root the controller parked with the page.
const window = new GlobalWindow({ url: "https://fixture.test/owner" })
const installed: string[] = []
let client: typeof import("react-dom/client")
let ServerComponent: (props: ServerComponentProps<unknown, unknown, unknown>) => ReactNode

beforeAll(async () => {
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
  // After the globals: react-dom reads them when it loads.
  client = await import("react-dom/client")
  ServerComponent = (await import("../src/server-components/outlet.ts")).ServerComponent
})

afterAll(async () => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  for (const key of installed) Reflect.deleteProperty(globalThis, key)
  await window.happyDOM.close()
})

const state: ComponentState = {
  v: 1,
  build: "build_1",
  adapter: "react",
  owner: "owner_1",
  scope: "scope_1",
  records: [
    {
      reference: "reference_1",
      instance: "instance_1",
      parent: null,
      key: "stable",
      input: {},
      html: "<b>count 0</b>",
    },
  ],
}

const any: ComponentHandle["input"] = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
}
const component: ComponentHandle = {
  reference: "reference_1",
  view: () => null,
  input: any,
  props: any,
}

// Each hydrate and dispose the native roots see, with a gate on the next one.
const traced = () => {
  const trace: string[] = []
  let next = Promise.withResolvers<void>()
  const note = (entry: string) => {
    trace.push(entry)
    next.resolve()
    next = Promise.withResolvers<void>()
  }
  const root = () => ({
    update() {},
    dispose: () => note("dispose"),
  })
  const adapter: ComponentClientAdapter = {
    name: "react",
    prepare: (record) => record.html,
    hydrate: () => {
      note("hydrate")
      return root()
    },
    create: () => {
      note("create")
      return root()
    },
    update: () => {},
  }
  return { trace, adapter, next: () => next.promise }
}
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: React's own export, read by name as the keep-alive mount does
const Activity = Reflect.get(React, "Activity") as ComponentType<{
  readonly mode: "hidden" | "visible"
  readonly children?: ReactNode
}>
const outlet = (
  options: Pick<ServerComponentProps<unknown, unknown, unknown>, "controller" | "clientAdapter">,
) =>
  createElement(
    "section",
    { id: "page" },
    createElement(ServerComponent, {
      state,
      component,
      instanceKey: "stable",
      input: {},
      ...options,
    }),
  )
const rendered = async (run: (view: ReturnType<typeof client.createRoot>) => Promise<void>) => {
  const container = document.createElement("div")
  document.body.append(container)
  const view = client.createRoot(container)
  try {
    await run(view)
  } finally {
    await act(async () => view.unmount())
    container.remove()
  }
}

test("a server component on a kept page keeps its root while <Activity> hides the page", async () => {
  const { trace, adapter } = traced()
  const controller = new ComponentController({ state, adapter })
  const tree = (mode: "hidden" | "visible") =>
    createElement(Activity, { mode }, outlet({ controller }))
  try {
    await rendered(async (view) => {
      await act(async () => view.render(tree("visible")))
      await controller.whenReady("instance_1")
      const page = document.getElementById("page")
      if (page === null) throw new Error("[test] no page")
      // The page events come before React hides the page and after it shows the page again.
      const hide = async () => {
        controller.park(page)
        await act(async () => view.render(tree("hidden")))
      }
      await hide()
      await act(async () => view.render(tree("visible")))
      controller.unpark(page)
      await controller.whenReady("instance_1")
      expect(trace).toEqual(["hydrate"])

      // Hidden again, then dropped: the view's slot leaves, and the root goes with it.
      const parking = createSlotParking()
      parking.page("\0kept")(page)
      await hide()
      expect(trace).toEqual(["hydrate"])
      parking.after([])
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
      expect(trace).toEqual(["hydrate", "dispose"])
    })
  } finally {
    await controller.dispose()
  }
})

test("an outlet React removes from a shown page takes its root along", async () => {
  // With the page's controller, which unmounts the root and stays.
  const shared = traced()
  const controller = new ComponentController({ state, adapter: shared.adapter })
  try {
    await rendered(async (view) => {
      await act(async () => view.render(outlet({ controller })))
      await controller.whenReady("instance_1")
      const disposed = shared.next()
      await act(async () => view.render(null))
      await disposed
      expect(shared.trace).toEqual(["hydrate", "dispose"])
    })
  } finally {
    await controller.dispose()
  }

  // Without one, the outlet's own controller goes too.
  const own = traced()
  await rendered(async (view) => {
    const hydrated = own.next()
    await act(async () => view.render(outlet({ clientAdapter: own.adapter })))
    await hydrated
    const disposed = own.next()
    await act(async () => view.render(null))
    await disposed
    expect(own.trace).toEqual(["hydrate", "dispose"])
  })
})

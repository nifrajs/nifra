import { afterAll, beforeAll, expect, test } from "bun:test"
import { GlobalWindow } from "happy-dom"
import { h, render } from "preact"
import { act } from "preact/test-utils"
import { installRouteSlotClientHarness } from "../../web/test/route-slot-client-harness.ts"
import { RouteSlot, useRouteSlot } from "../src/route-slot.ts"
import { RenderPropsContext } from "../src/router.ts"

declare module "@nifrajs/web" {
  interface RouteTable {
    "/dashboard": { readonly slots: { readonly inspector: readonly ["/users/:id"] } }
    "/users/:id": object
  }
}

const window = new GlobalWindow({ url: "https://route-slot.test/dashboard" })
const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, "document")

beforeAll(() => {
  Reflect.set(globalThis, "window", window)
  Reflect.set(globalThis, "document", window.document)
})

afterAll(async () => {
  if (beforeWindow === undefined) Reflect.deleteProperty(globalThis, "window")
  else Object.defineProperty(globalThis, "window", beforeWindow)
  if (beforeDocument === undefined) Reflect.deleteProperty(globalThis, "document")
  else Object.defineProperty(globalThis, "document", beforeDocument)
  await window.happyDOM.close()
})

test("Preact binding subscribes, loads the target chain, and opens and closes URL state", async () => {
  function Target(props: { readonly data: { readonly label: string } }) {
    return h("p", { id: "slot-ready" }, props.data.label)
  }

  const harness = installRouteSlotClientHarness([Target])
  const container = document.createElement("div")
  document.body.append(container)
  const path = "/dashboard?tab=preact&slot.inspector=%2Fusers%2F7"

  function Probe() {
    const slot = useRouteSlot("inspector")
    return h(
      "div",
      null,
      h(RouteSlot, { name: "inspector", fallback: h("p", null, "Loading target") }),
      h("output", { id: "slot-status" }, slot.status),
      h(
        "button",
        {
          id: "slot-navigation",
          onClick: () => {
            slot.open("/users/7")
            slot.close()
          },
        },
        "navigate",
      ),
    )
  }

  try {
    await act(async () => {
      render(
        h(RenderPropsContext.Provider, { value: { data: null, path, pending: false } }, h(Probe)),
        container,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(container.querySelector("#slot-status")?.textContent).toBe("ready")
    expect(harness.requests).toHaveLength(1)
    expect(container.innerHTML).toContain("authorized target")

    await act(async () => {
      container.querySelector<HTMLButtonElement>("#slot-navigation")?.click()
    })
  } finally {
    await act(async () => render(null, container))
    container.remove()
    harness.restore()
  }
})

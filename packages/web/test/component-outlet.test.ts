import { describe, expect, test } from "bun:test"
import {
  mountOutlet,
  type OutletFramework,
  type OutletProps,
  outletHtml,
} from "../src/internal/component-outlet.ts"
import {
  type ComponentClientAdapter,
  ComponentController,
  type ComponentState,
} from "../src/server-components/client.ts"

const state: ComponentState = {
  v: 1,
  build: "build_1",
  adapter: "vue",
  owner: "owner_1",
  scope: "scope_1",
  records: [
    {
      reference: "reference_1",
      instance: "instance_1",
      parent: null,
      key: "stable",
      input: {},
      html: "<p>range</p>",
    },
  ],
}
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the outlet reads only `localName` and hands the host to a controller this file stubs
const host = { localName: "nifra-component" } as Element

// A page's own controller: records what the outlet asks of it, and fails each call when `failing`.
class PageController extends ComponentController {
  readonly calls: string[] = []
  readonly errors: string[] = []
  constructor(
    private readonly failing = false,
    private readonly parked = false,
  ) {
    super({ state, adapter: rejecting() })
  }
  #call(name: string): Promise<void> {
    this.calls.push(name)
    return this.failing ? Promise.reject(new Error(name)) : Promise.resolve()
  }
  override mount(_host: Element, instance: string): Promise<void> {
    return this.#call(`mount ${instance}`)
  }
  override unmount(instance: string): Promise<void> {
    return this.#call(`unmount ${instance}`)
  }
  override dispose(): Promise<void> {
    return this.#call("dispose")
  }
  override adopt(): Promise<void> {
    return this.#call("adopt")
  }
  override isParked(): boolean {
    return this.parked
  }
  override reportError(code: string): void {
    this.errors.push(code)
  }
}

function rejecting(): ComponentClientAdapter {
  const fail = () => Promise.reject(new Error("unavailable"))
  return { name: "vue", prepare: fail, hydrate: fail, update: fail }
}

// The outlet's latest props, and every code its `onError` received.
function outlet(props: Omit<OutletProps, "state" | "onError">): {
  readonly latest: { current: OutletProps }
  readonly errors: string[]
  readonly reported: Promise<void>
} {
  const errors: string[] = []
  let settle = () => {}
  const reported = new Promise<void>((resolve) => {
    settle = resolve
  })
  const latest = {
    current: {
      ...props,
      state,
      onError: (code: string) => {
        errors.push(code)
        settle()
      },
    },
  }
  return { latest, errors, reported }
}

describe("outletHtml", () => {
  test("is the record's range inside its <nifra-component>", () => {
    expect(outletHtml(state.records[0]!)).toEqual({
      __html: '<nifra-component data-nifra-component="instance_1"><p>range</p></nifra-component>',
    })
  })
})

describe("mountOutlet", () => {
  test("throws without a controller or an adapter, from the page or the framework", () => {
    const { latest } = outlet({})
    expect(() => mountOutlet(latest, host, "instance_1")).toThrow("component_contract")
  })

  test("reports a host without its <nifra-component> to the page's controller and onError", () => {
    const controller = new PageController()
    const page = outlet({ controller })
    for (const missing of [null, undefined, { localName: "div" }]) {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: stands in for the outlet host's first child, read only for its `localName`
      expect(mountOutlet(page.latest, missing as Element | null | undefined, "instance_1")).toBe(
        undefined,
      )
    }
    expect(controller.calls).toEqual([])
    expect(controller.errors).toEqual(Array(3).fill("component_contract"))
    expect(page.errors).toEqual(Array(3).fill("component_contract"))
  })

  test("mounts, adopts and unmounts through the page's controller", () => {
    const controller = new PageController()
    const { latest, errors } = outlet({ controller })
    const mounted = mountOutlet(latest, host, "instance_1")
    mounted?.adopt(state)
    mounted?.teardown()
    expect(controller.calls).toEqual(["mount instance_1", "adopt", "unmount instance_1"])
    expect(errors).toEqual([])
  })

  test("reports each failure to the page's controller and to the outlet's onError", async () => {
    const controller = new PageController(true)
    const { latest, errors } = outlet({ controller })
    const mounted = mountOutlet(latest, host, "instance_1")
    mounted?.adopt(state)
    mounted?.teardown()
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.errors).toEqual(Array(3).fill("component_failed"))
    expect(errors).toEqual(Array(3).fill("component_failed"))
  })

  test("leaves a parked instance to its page only where hiding cleans up effects", () => {
    const hiding: OutletFramework = { hidingCleansUp: true }
    const kept = new PageController(false, true)
    mountOutlet(outlet({ controller: kept }).latest, host, "instance_1", hiding)?.teardown()
    expect(kept.calls).toEqual(["mount instance_1"])
    const shown = new PageController(false, true)
    mountOutlet(outlet({ controller: shown }).latest, host, "instance_1")?.teardown()
    expect(shown.calls).toEqual(["mount instance_1", "unmount instance_1"])
  })

  test("makes a controller from the framework's adapter, which reports to onError once", async () => {
    let made = 0
    const framework: OutletFramework = {
      clientAdapter: () => {
        made++
        return rejecting()
      },
    }
    const { latest, errors, reported } = outlet({})
    const mounted = mountOutlet(latest, host, "instance_1", framework)
    await reported
    mounted?.teardown()
    expect(made).toBe(1)
    expect(errors).toEqual(["component_failed"])
  })
})

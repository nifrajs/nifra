import type {
  ComponentClientAdapter,
  ComponentClientRoot,
  ComponentRecord,
  CurrentComponent,
} from "@nifrajs/web/server-components/client"
import { bytesStream, decodeComponentBytes } from "@nifrajs/web/server-components/stream"
import { createFromReadableStream } from "@vitejs/plugin-rsc/browser"
import { createElement, type ReactNode, useLayoutEffect, useSyncExternalStore } from "react"
import { flushSync } from "react-dom"
import { createRoot, hydrateRoot } from "react-dom/client"

// Flight's framework-facing lazy ABI is pinned with React/Flight in the compatibility gate.
async function prepareTree(
  value: unknown,
  current: CurrentComponent,
  seen = new Set<object>(),
  depth = 0,
): Promise<void> {
  if (!current()) throw new Error("component_cancelled")
  if (depth > 64 || seen.size > 16384) throw new Error("component_limit")
  if (typeof value !== "object" || value === null || seen.has(value)) return
  seen.add(value)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
  const node = value as Record<string, unknown>
  if (node.$$typeof === Symbol.for("react.lazy")) {
    const init = node._init
    if (typeof init !== "function") throw new Error("component_protocol")
    while (true) {
      try {
        await prepareTree(init(node._payload), current, seen, depth + 1)
        break
      } catch (pending) {
        if (
          typeof pending !== "object" ||
          pending === null ||
          !("then" in pending) ||
          typeof pending.then !== "function"
        )
          throw pending
        await pending
        if (!current()) throw new Error("component_cancelled")
      }
    }
  } else if ("then" in node && typeof node.then === "function") {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
    await prepareTree(await (value as Promise<unknown>), current, seen, depth + 1)
  } else if (Array.isArray(value)) {
    await Promise.all(value.map((child) => prepareTree(child, current, seen, depth + 1)))
  } else if (node.$$typeof === Symbol.for("react.transitional.element")) {
    await prepareTree(node.type, current, seen, depth + 1)
    await prepareTree(node.props, current, seen, depth + 1)
  } else {
    await Promise.all(
      Object.values(node).map((child) => prepareTree(child, current, seen, depth + 1)),
    )
  }
}

class FlightRoot implements ComponentClientRoot {
  readonly #host: Element
  readonly #root: ReturnType<typeof createRoot>
  readonly #listeners = new Set<() => void>()
  #snapshot: ReactNode
  #current: CurrentComponent
  #committed: ReactNode = null
  #disposed = false
  #ready: () => void
  readonly ready: Promise<void>
  constructor(
    host: Element,
    tree: ReactNode,
    record: ComponentRecord,
    current: CurrentComponent,
    fresh = false,
  ) {
    this.#host = host
    this.#snapshot = tree
    this.#current = current
    let ready!: () => void
    this.ready = new Promise<void>((resolve) => {
      ready = resolve
    })
    this.#ready = ready
    const store = this
    function CurrentTree() {
      const value = useSyncExternalStore(
        (listener) => {
          store.#listeners.add(listener)
          return () => store.#listeners.delete(listener)
        },
        () => store.#snapshot,
        () => tree,
      )
      const display = store.#current() ? value : store.#committed
      useLayoutEffect(() => {
        store.#committed = display
        store.#ready()
      })
      return display
    }
    const options = {
      identifierPrefix: `${record.instance}-`,
      onRecoverableError() {
        if (current()) throw new Error("component_failed")
      },
      onUncaughtError() {
        store.#ready()
        store.dispose()
        throw new Error("component_failed")
      },
    }
    if (fresh) {
      this.#root = createRoot(host, options)
      this.#root.render(createElement(CurrentTree))
    } else this.#root = hydrateRoot(host, createElement(CurrentTree), options)
  }
  publish(tree: ReactNode, current: CurrentComponent): void {
    if (this.#disposed || !current()) return
    flushSync(() => {
      if (!current()) return
      this.#current = current
      this.#snapshot = tree
      for (const listener of this.#listeners) listener()
    })
  }
  update(): never {
    throw new Error("component_contract")
  }
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#root.unmount()
    this.#listeners.clear()
    this.#host.replaceChildren()
    this.#ready()
  }
}
export function reactComponentClient(): ComponentClientAdapter {
  return {
    name: "react",
    async prepare(record, current) {
      if (
        typeof record.payload !== "object" ||
        record.payload === null ||
        Array.isArray(record.payload) ||
        !Object.hasOwn(record.payload, "flight")
      )
        throw new Error("component_protocol")
      const tree = await createFromReadableStream<ReactNode>(
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
        bytesStream(decodeComponentBytes((record.payload as Record<string, unknown>).flight)),
      )
      await prepareTree(tree, current)
      if (!current()) throw new Error("component_cancelled")
      return tree
    },
    async hydrate(host, record, tree, current) {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
      const root = new FlightRoot(host, tree as ReactNode, record, current)
      await root.ready
      return root
    },
    async create(host, record, tree, current) {
      if (!current()) throw new Error("component_cancelled")
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
      const root = new FlightRoot(host, tree as ReactNode, record, current, true)
      await root.ready
      return root
    },
    update(root, _record, tree, current) {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
      ;(root as FlightRoot).publish(tree as ReactNode, current)
    },
  }
}

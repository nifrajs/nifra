import type { ComponentClientAdapter, ComponentClientRoot, CurrentComponent } from "./client.ts"
import { ServerComponentError } from "./error.ts"
import { validateComponentTag } from "./html-policy.ts"
import { type ClientIsland, isClientIsland } from "./islands.ts"
import { guardComponentProps } from "./props.ts"
import type { ComponentIsland, ComponentState } from "./types.ts"

export interface NativeIslandRoot {
  readonly ready?: Promise<void>
  update(props: Record<string, unknown>, current: CurrentComponent): void | Promise<void>
  dispose(): void | Promise<void>
}
export interface NativeIslandRuntime {
  hydrate(
    host: Element,
    contract: ClientIsland,
    record: ComponentIsland,
    current: CurrentComponent,
  ): NativeIslandRoot | Promise<NativeIslandRoot>
}
export interface NativeRangeOptions {
  readonly adapter: Exclude<ComponentState["adapter"], "react">
  readonly islands: readonly ClientIsland[]
  readonly runtime: NativeIslandRuntime
  /** A narrowly scoped Trusted Types policy's createHTML, when the application requires TT. */
  readonly trustedHTML?: (html: string) => string | { toString(): string }
}
interface Prepared {
  fragment: DocumentFragment
  islands: readonly ComponentIsland[]
  contracts: ReadonlyMap<string, ClientIsland>
  nested: ReadonlyMap<string, Element>
}
interface MountedIsland {
  readonly host: Element
  readonly root: NativeIslandRoot
  readonly record: ComponentIsland
}
function failure(): ServerComponentError {
  return new ServerComponentError("component_protocol", 400)
}

/** Parse inertly and reject executable content before it can reach a live document. */
export function parseComponentHTML(
  html: string,
  context: Element,
  trustedHTML?: NativeRangeOptions["trustedHTML"],
): DocumentFragment {
  const range = document.createRange()
  range.selectNodeContents(context)
  // A TT policy only authorizes inert parsing here. Validation still precedes insertion.
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Preparation validates the complete record and owned DOM topology; only this adapter creates the prepared plan and native range.
  const source = (trustedHTML === undefined ? html : trustedHTML(html)) as string
  const inert = new DOMParser().parseFromString(source, "text/html")
  validateHTML(inert)
  const fragment = range.createContextualFragment(source)
  validateHTML(fragment)
  return fragment
}
function validateHTML(root: ParentNode): void {
  for (const element of root.querySelectorAll("*")) {
    validateComponentTag(element.localName, [...element.attributes])
  }
}
function hosts(fragment: ParentNode, islands: readonly ComponentIsland[]): Map<string, Element> {
  const map = new Map<string, Element>()
  for (const host of fragment.querySelectorAll("[data-nifra-island]")) {
    let parent = host.parentElement
    let nested = false
    while (parent !== null && parent !== fragment) {
      if (parent.hasAttribute("data-nifra-component")) {
        nested = true
        break
      }
      parent = parent.parentElement
    }
    if (nested) continue
    const id = host.getAttribute("data-nifra-island")
    if (
      id === null ||
      map.has(id) ||
      host.localName !== "nifra-island" ||
      (host.parentElement?.closest("nifra-island") !== null &&
        host.parentElement?.closest("nifra-island") !== undefined)
    )
      throw failure()
    map.set(id, host)
  }
  if (map.size !== islands.length || islands.some((record) => !map.has(record.renderId)))
    throw failure()
  return map
}
class NativeRange implements ComponentClientRoot {
  readonly #host: Element
  readonly #options: NativeRangeOptions
  #mounted = new Map<string, MountedIsland>()
  #disposed = false
  #pending = Promise.resolve()
  constructor(host: Element, options: NativeRangeOptions) {
    this.#host = host
    this.#options = options
  }
  async initialize(prepared: Prepared, current: CurrentComponent): Promise<void> {
    const actual = hosts(this.#host, prepared.islands)
    try {
      for (const record of prepared.islands) {
        if (!current()) throw failure()
        const host = actual.get(record.renderId)!
        const contract = prepared.contracts.get(record.reference)!
        const root = await this.#options.runtime.hydrate(host, contract, record, current)
        await root.ready
        if (!current()) {
          await root.dispose()
          throw failure()
        }
        this.#mounted.set(record.renderId, { host, root, record })
      }
    } catch (error) {
      await this.dispose()
      throw error
    }
  }
  commit(prepared: Prepared, current: CurrentComponent): Promise<void> {
    const pending = this.#pending.then(() => this.#commit(prepared, current))
    this.#pending = pending.catch(() => {
      /* The calling refresh owns the failure; later generations can proceed. */
    })
    return pending
  }
  async #commit(prepared: Prepared, current: CurrentComponent): Promise<void> {
    if (!current() || this.#disposed) return
    const nextHosts = hosts(prepared.fragment, prepared.islands)
    const retainedChildren = new Map<string, Element>()
    for (const host of this.#host.querySelectorAll("[data-nifra-component]")) {
      const id = host.getAttribute("data-nifra-component")
      if (id !== null && prepared.nested.has(id)) retainedChildren.set(id, host)
    }
    const next = new Map<string, MountedIsland>()
    const active = document.activeElement
    const selection =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? ([active.selectionStart, active.selectionEnd, active.selectionDirection] as const)
        : undefined
    const acquired: NativeIslandRoot[] = []
    const slots: Array<{ host: Element; fragment: DocumentFragment }> = []
    try {
      for (const record of prepared.islands) {
        const previous = this.#mounted.get(record.renderId)
        const placeholder = nextHosts.get(record.renderId)!
        if (
          previous !== undefined &&
          previous.record.reference === record.reference &&
          previous.record.key === record.key
        ) {
          for (const name of new Set([
            ...Object.keys(previous.record.slots ?? {}),
            ...Object.keys(record.slots ?? {}),
          ])) {
            const slot = [...previous.host.querySelectorAll("nifra-slot[data-nifra-slot]")].find(
              (element) => element.getAttribute("data-nifra-slot") === name,
            )
            if (slot === undefined) throw failure()
            slots.push({
              host: slot,
              fragment: parseComponentHTML(
                record.slots?.[name] ?? "",
                slot,
                this.#options.trustedHTML,
              ),
            })
          }
          next.set(record.renderId, { ...previous, record })
        } else {
          const root = await this.#options.runtime.hydrate(
            placeholder,
            prepared.contracts.get(record.reference)!,
            record,
            current,
          )
          acquired.push(root)
          await root.ready
          if (!current() || this.#disposed) {
            await Promise.all(acquired.map((root) => root.dispose()))
            return
          }
          next.set(record.renderId, { host: placeholder, root, record })
        }
      }
      if (!current() || this.#disposed) {
        await Promise.all(acquired.map((root) => root.dispose()))
        return
      }
      const removed = [...this.#mounted.values()].filter(
        (previous) => next.get(previous.record.renderId)?.root !== previous.root,
      )
      // No await inside this transaction: cancellation cannot detach a live retained root.
      for (const [id, previous] of this.#mounted)
        if (next.get(id)?.root === previous.root) nextHosts.get(id)!.replaceWith(previous.host)
      for (const [id, child] of retainedChildren) prepared.nested.get(id)!.replaceWith(child)
      for (const slot of slots) slot.host.replaceChildren(slot.fragment)
      this.#host.replaceChildren(prepared.fragment)
      this.#mounted = next
      const updates: Array<void | Promise<void>> = []
      for (const record of prepared.islands) {
        if (!current() || this.#disposed) return
        const previous = next.get(record.renderId)
        if (previous !== undefined && !acquired.includes(previous.root))
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Preparation validates the complete record and owned DOM topology; only this adapter creates the prepared plan and native range.
          updates.push(previous.root.update(record.props as Record<string, unknown>, current))
      }
      await Promise.all(updates)
      if (active instanceof HTMLElement && active.isConnected && current()) {
        active.focus({ preventScroll: true })
        if (
          selection !== undefined &&
          (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
          selection[0] !== null &&
          selection[1] !== null
        )
          active.setSelectionRange(selection[0], selection[1], selection[2] ?? undefined)
      }
      await Promise.all(removed.map((island) => island.root.dispose()))
    } catch (error) {
      await Promise.all(
        acquired
          .filter((root) => ![...this.#mounted.values()].some((island) => island.root === root))
          .map((root) => root.dispose()),
      )
      if (current()) await this.dispose()
      throw error
    }
  }
  update(): never {
    throw new ServerComponentError("component_contract")
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    try {
      await Promise.all([...this.#mounted.values()].map((island) => island.root.dispose()))
    } finally {
      this.#mounted.clear()
      this.#host.replaceChildren()
    }
  }
}
export function nativeComponentClient(options: NativeRangeOptions): ComponentClientAdapter {
  const contracts = new Map<string, ClientIsland>()
  for (const contract of options.islands) {
    if (
      !isClientIsland(contract) ||
      contract.reference === undefined ||
      contracts.has(contract.reference)
    )
      throw new ServerComponentError("component_contract")
    contracts.set(contract.reference, contract)
  }
  return {
    name: options.adapter,
    async prepare(record, current, host, context) {
      const islands: ComponentIsland[] = []
      for (const island of record.islands ?? []) {
        const contract = contracts.get(island.reference)
        if (
          contract === undefined ||
          Object.keys(island.slots ?? {}).some((name) => !contract.slots.includes(name))
        )
          throw failure()
        const props = await guardComponentProps(contract.props, island.props)
        if (!current()) throw failure()
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Preparation validates the complete record and owned DOM topology; only this adapter creates the prepared plan and native range.
        islands.push({ ...island, props: props as ComponentIsland["props"] })
      }
      const parseContext = host ?? document.createElement("nifra-component")
      const fragment = parseComponentHTML(record.html, parseContext, options.trustedHTML)
      hosts(fragment, islands)
      const nested = new Map<string, Element>()
      for (const child of fragment.querySelectorAll("[data-nifra-component]")) {
        if (child.parentElement?.closest("[data-nifra-component]") != null) continue
        const id = child.getAttribute("data-nifra-component")
        if (
          id === null ||
          nested.has(id) ||
          !(context?.records ?? []).some(
            (item) => item.instance === id && item.parent === record.instance,
          )
        )
          throw failure()
        nested.set(id, child)
      }
      return { fragment, islands, contracts, nested } satisfies Prepared
    },
    async hydrate(host, _record, prepared, current) {
      const range = new NativeRange(host, options)
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Preparation validates the complete record and owned DOM topology; only this adapter creates the prepared plan and native range.
      await range.initialize(prepared as Prepared, current)
      return range
    },
    async create(host, _record, prepared, current) {
      if (!current()) throw failure()
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Preparation validates the complete record and owned DOM topology; only this adapter creates the prepared plan and native range.
      host.replaceChildren((prepared as Prepared).fragment)
      const range = new NativeRange(host, options)
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Preparation validates the complete record and owned DOM topology; only this adapter creates the prepared plan and native range.
      await range.initialize(prepared as Prepared, current)
      return range
    },
    update(root, _record, prepared, current) {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Preparation validates the complete record and owned DOM topology; only this adapter creates the prepared plan and native range.
      return (root as NativeRange).commit(prepared as Prepared, current)
    },
  }
}

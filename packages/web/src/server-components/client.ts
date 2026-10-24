import { setHoleComponents } from "../internal/hole-runtime.ts"
import { onPageRelease } from "../internal/page-events.ts"
import { ServerComponentError } from "./error.ts"
import { readComponentFrames } from "./frames.ts"
import {
  COMPONENT_HEADER,
  COMPONENT_LIMITS,
  COMPONENT_MEDIA_TYPE,
  componentRequestHeader,
} from "./protocol.ts"
import { registerComponentController, unregisterComponentController } from "./registry.ts"
import { componentResponseFailure } from "./response.ts"
import { BoundedComponentTasks } from "./scheduler.ts"
import { parseComponentRecord, parseComponentState } from "./state.ts"
import { readComponentBytes } from "./stream.ts"
import type { ComponentKey, ComponentRecord, ComponentState, ServerComponent } from "./types.ts"
import { componentInputKey, componentValue } from "./value.ts"

declare const __NIFRA_COMPONENT_BUILD__: string

export type CurrentComponent = () => boolean
export interface ComponentClientRoot {
  update(record: ComponentRecord, current: CurrentComponent): void | Promise<void>
  dispose(): void | Promise<void>
}
export interface ComponentClientAdapter {
  readonly name: ComponentState["adapter"]
  prepare(
    record: ComponentRecord,
    current: CurrentComponent,
    host?: Element,
    context?: { readonly records: readonly ComponentRecord[] },
  ): unknown | Promise<unknown>
  hydrate(
    host: Element,
    record: ComponentRecord,
    prepared: unknown,
    current: CurrentComponent,
  ): ComponentClientRoot | Promise<ComponentClientRoot>
  create?(
    host: Element,
    record: ComponentRecord,
    prepared: unknown,
    current: CurrentComponent,
  ): ComponentClientRoot | Promise<ComponentClientRoot>
  update(
    root: ComponentClientRoot,
    record: ComponentRecord,
    prepared: unknown,
    current: CurrentComponent,
  ): void | Promise<void>
}
export interface ComponentControllerOptions {
  readonly state: ComponentState
  readonly adapter: ComponentClientAdapter
  readonly ownerUrl?: string
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  readonly navigate?: (url: string) => void
  readonly onError?: (code: string) => void
  readonly reload?: () => void
}
interface Mounted {
  readonly host: Element
  record: ComponentRecord
  generation: number
  abort: AbortController
  root?: ComponentClientRoot
  ready: Promise<void>
  // Cancels the release a parked instance waits on from its page.
  unwatch?: (() => void) | undefined
}
function sameRecord(a: ComponentRecord, b: ComponentRecord): boolean {
  return (
    a.instance === b.instance &&
    a.reference === b.reference &&
    a.key === b.key &&
    a.parent === b.parent &&
    componentInputKey(a.input) === componentInputKey(b.input)
  )
}
function cancelled(): ServerComponentError {
  return new ServerComponentError("component_cancelled", 499)
}

export class ComponentController {
  #state: ComponentState
  #source: ComponentState | undefined
  #ownerUrl: string | undefined
  get state(): ComponentState {
    return this.#state
  }
  reportError(code: string): void {
    this.#options.onError?.(code)
  }
  readonly #options: ComponentControllerOptions
  readonly #mounted = new Map<string, Mounted>()
  // Set aside with a `keepAlive` page while it is hidden; another page may mount the same instances.
  readonly #parked = new Set<Mounted>()
  // Structural outlet anchors survive logout; their private records and native roots do not.
  readonly #restorable = new Map<string, Element>()
  readonly #teardown = new WeakMap<Element, Promise<void>>()
  readonly #mountWaiters = new Map<string, Set<() => void>>()
  readonly #tasks = new BoundedComponentTasks(4, COMPONENT_LIMITS.instances)
  #routeEpoch = 0
  #authEpoch = 0
  #adoption = 0
  #disposed = false
  constructor(options: ComponentControllerOptions) {
    this.#state = parseComponentState(options.state)
    this.#options = options
    this.#source = options.state
    this.#ownerUrl = options.ownerUrl
    if (this.state.adapter !== options.adapter.name)
      throw new ServerComponentError("component_version", 409)
    if (
      typeof __NIFRA_COMPONENT_BUILD__ === "string" &&
      this.state.build !== __NIFRA_COMPONENT_BUILD__
    ) {
      this.#versionReload()
      this.#state = { ...this.#state, records: [] }
      this.#source = undefined
      throw new ServerComponentError("component_version", 409)
    }
    registerComponentController(this)
  }
  async mount(host: Element, instance: string, fresh = false): Promise<void> {
    await this.#mount(host, instance, fresh)
  }
  async #mount(host: Element, instance: string, fresh: boolean): Promise<void> {
    await this.#teardown.get(host)
    // The page that parked it takes it back when it is shown again.
    if (this.isParked(instance, host)) return
    if (this.#disposed || this.#mounted.has(instance))
      throw new ServerComponentError("component_contract")
    const record = this.state.records.find((record) => record.instance === instance)
    if (record === undefined) throw new ServerComponentError("component_unavailable", 404)
    const mounted: Mounted = {
      host,
      record,
      generation: 0,
      abort: new AbortController(),
      ready: Promise.resolve(),
    }
    this.#mounted.set(instance, mounted)
    this.#restorable.delete(instance)
    const signal = AbortSignal.any([
      mounted.abort.signal,
      AbortSignal.timeout(COMPONENT_LIMITS.operationMs),
    ])
    const valid = this.#current(mounted)
    const current = () => valid() && !signal.aborted
    mounted.ready = this.#tasks
      .run(signal, async () => {
        const prepared = await this.#options.adapter.prepare(record, current, host, this.state)
        if (!current()) throw cancelled()
        const mount = fresh ? this.#options.adapter.create : this.#options.adapter.hydrate
        if (mount === undefined) throw new ServerComponentError("component_contract")
        const root = await mount.call(this.#options.adapter, host, record, prepared, current)
        if (!current()) {
          await root.dispose()
          throw cancelled()
        }
        mounted.root = root
      })
      .then(async () => {
        if (current()) await this.#syncChildren(mounted, this.#state.records, current)
      })
    for (const ready of this.#mountWaiters.get(instance) ?? []) ready()
    this.#mountWaiters.delete(instance)
    try {
      await mounted.ready
    } catch (error) {
      // Parked while it hydrated: it mounts again when its page is shown.
      if (this.#parked.has(mounted)) return
      if (this.#mounted.get(instance) === mounted) await this.unmount(instance)
      throw error
    }
  }
  async whenReady(instance: string): Promise<void> {
    const mounted = this.#mounted.get(instance)
    if (mounted !== undefined) {
      await mounted.ready
      return
    }
    if (this.#disposed || !this.state.records.some((record) => record.instance === instance))
      throw new ServerComponentError("component_unavailable", 404)
    await new Promise<void>((resolve, reject) => {
      const waiters = this.#mountWaiters.get(instance) ?? new Set<() => void>()
      const ready = () => {
        clearTimeout(timer)
        waiters.delete(ready)
        const mounted = this.#mounted.get(instance)
        if (mounted === undefined) reject(cancelled())
        else mounted.ready.then(resolve, reject)
      }
      const timer = setTimeout(() => {
        waiters.delete(ready)
        reject(new ServerComponentError("component_timeout", 504))
      }, COMPONENT_LIMITS.operationMs)
      waiters.add(ready)
      this.#mountWaiters.set(instance, waiters)
    })
  }
  #current(mounted: Mounted): CurrentComponent {
    const generation = mounted.generation
    const route = this.#routeEpoch
    const auth = this.#authEpoch
    return () =>
      !this.#disposed &&
      !mounted.abort.signal.aborted &&
      this.#mounted.get(mounted.record.instance) === mounted &&
      mounted.generation === generation &&
      this.#routeEpoch === route &&
      this.#authEpoch === auth
  }
  async refresh(instance: string, ownerUrl?: string): Promise<boolean> {
    const mounted = this.#mounted.get(instance)
    if (mounted === undefined || this.#disposed) return false
    try {
      await mounted.ready
    } catch {
      return false
    }
    if (this.#mounted.get(instance) !== mounted || this.#disposed) return false
    // A newer child intent must not be overwritten by an older in-flight ancestor subtree.
    let parent = mounted.record.parent
    while (parent !== null) {
      const ancestor = this.#mounted.get(parent)
      if (ancestor === undefined) break
      ancestor.abort.abort()
      ancestor.abort = new AbortController()
      ancestor.generation++
      parent = ancestor.record.parent
    }
    mounted.abort.abort()
    mounted.abort = new AbortController()
    mounted.generation++
    for (const child of this.#descendants(instance)) {
      child.abort.abort()
      child.abort = new AbortController()
      child.generation++
    }
    const valid = this.#current(mounted)
    const request = {
      v: 1 as const,
      build: this.state.build,
      reference: mounted.record.reference,
      key: mounted.record.key,
      parent: mounted.record.parent,
      input: mounted.record.input,
      generation: mounted.generation,
      routeEpoch: this.#routeEpoch,
      authEpoch: this.#authEpoch,
    }
    const owner = new URL(ownerUrl ?? this.#ownerUrl ?? location.href, location.href)
    if (owner.origin !== location.origin) throw new ServerComponentError("component_denied", 403)
    const signal = AbortSignal.any([
      mounted.abort.signal,
      AbortSignal.timeout(COMPONENT_LIMITS.operationMs),
    ])
    const current = () => valid() && !signal.aborted
    let updating = false
    try {
      const committed = await this.#tasks.run(signal, async () => {
        const response = await (this.#options.fetch ?? fetch)(owner, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "manual",
          signal,
          headers: {
            [COMPONENT_HEADER]: componentRequestHeader(request),
            accept: COMPONENT_MEDIA_TYPE,
          },
        })
        if (!current()) return false
        if (
          response.type === "opaqueredirect" ||
          (response.status >= 300 && response.status < 400)
        ) {
          this.#options.navigate?.(owner.href)
          if (this.#options.navigate === undefined) location.assign(owner.href)
          return false
        }
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) {
            this.#options.onError?.("component_denied")
            await this.invalidateScope()
            return false
          }
          const failure = await componentResponseFailure(response, signal)
          if (failure.code === "component_version") {
            this.#versionReload()
            return false
          }
          throw failure
        }
        if (response.headers.has("x-nifra-component-control")) {
          if (response.body === null) throw new ServerComponentError("component_protocol", 400)
          let value: unknown
          try {
            value = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                await readComponentBytes(response.body, signal, COMPONENT_LIMITS.headerBytes),
              ),
            )
          } catch {
            throw new ServerComponentError("component_protocol", 400)
          }
          const checked = componentValue(value, COMPONENT_LIMITS.headerBytes)
          if (typeof checked !== "object" || checked === null || Array.isArray(checked))
            throw new ServerComponentError("component_protocol", 400)
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
          const control = checked as Record<string, unknown>
          if (
            Object.keys(control).length !== 2 ||
            control.v !== 1 ||
            typeof control.control !== "object" ||
            control.control === null ||
            Array.isArray(control.control)
          )
            throw new ServerComponentError("component_protocol", 400)
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
          const terminal = control.control as Record<string, unknown>
          if (
            Object.keys(terminal).length !== 1 ||
            typeof terminal.status !== "number" ||
            !Number.isSafeInteger(terminal.status) ||
            terminal.status < 200 ||
            terminal.status > 299 ||
            response.headers.get("x-nifra-component-control") !== String(terminal.status)
          )
            throw new ServerComponentError("component_protocol", 400)
          if (current()) {
            this.#options.navigate?.(owner.href)
            if (this.#options.navigate === undefined) location.assign(owner.href)
          }
          return false
        }
        if (
          response.headers.get("content-type")?.split(";")[0]?.trim() !== COMPONENT_MEDIA_TYPE ||
          response.body === null
        )
          throw new ServerComponentError("component_protocol", 400)
        const decoded = await readComponentFrames(response.body, signal)
        const next = parseComponentState(
          decoded.value,
          COMPONENT_LIMITS.outputBytes,
          mounted.record.parent,
        )
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
        const meta = componentValue(decoded.metadata, COMPONENT_LIMITS.headerBytes) as Record<
          string,
          unknown
        >
        const expected = {
          ...request,
          input: undefined,
          adapter: next.adapter,
          owner: next.owner,
          scope: next.scope,
          instance: next.records[0]?.instance,
        }
        const keys = Object.keys(expected).filter((key) => key !== "input")
        if (
          typeof meta !== "object" ||
          meta === null ||
          Array.isArray(meta) ||
          Object.keys(meta).length !== keys.length ||
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
          keys.some((key) => meta[key] !== expected[key as keyof typeof expected]) ||
          next.build !== this.state.build ||
          next.adapter !== this.state.adapter ||
          next.owner !== this.state.owner ||
          next.records.length < 1 ||
          !sameRecord(mounted.record, next.records[0]!)
        )
          throw new ServerComponentError("component_protocol", 400)
        const incoming = new Map(next.records.map((record) => [record.instance, record]))
        for (const record of next.records.slice(1)) {
          let parent = record.parent
          let depth = 0
          while (parent !== instance) {
            if (parent === null || ++depth >= 16 || !incoming.has(parent))
              throw new ServerComponentError("component_protocol", 400)
            parent = incoming.get(parent)!.parent
          }
        }
        if (next.scope !== this.state.scope) {
          this.#options.onError?.("component_denied")
          await this.invalidateScope()
          return false
        }
        if (!current()) return false
        const record = next.records[0]!
        const prepared = await this.#options.adapter.prepare(record, current, mounted.host, next)
        if (!current() || signal.aborted) return false
        if (mounted.root === undefined) throw new ServerComponentError("component_contract")
        updating = true
        await this.#options.adapter.update(mounted.root, record, prepared, current)
        if (!current()) return false
        const replaced = recordSubtree(this.#state.records, instance)
        this.#state = {
          ...this.#state,
          records: [
            ...this.#state.records.filter((item) => !replaced.has(item.instance)),
            ...next.records,
          ],
        }
        mounted.record = record
        return true
      })
      if (committed && current()) await this.#syncChildren(mounted, this.#state.records, current)
      return committed && current()
    } catch (error) {
      if (!current() || signal.aborted) return false
      const failure =
        error instanceof ServerComponentError ? error : new ServerComponentError("component_failed")
      this.#options.onError?.(failure.code)
      if (updating) await this.unmount(instance)
      throw failure
    }
  }
  #versionReload(): void {
    const key = `nifra-component-reload:${this.state.build}`
    let used = false
    try {
      used = sessionStorage.getItem(key) === "1"
      if (!used) sessionStorage.setItem(key, "1")
    } catch {
      used = reloadedBuilds.has(this.state.build)
    }
    reloadedBuilds.add(this.state.build)
    if (used) {
      this.#options.onError?.("component_version")
      return
    }
    this.cancelPending()
    if (this.#options.reload !== undefined) this.#options.reload()
    else location.reload()
  }
  /** Abort networking immediately while retaining the tree until verified navigation arrives. */
  cancelPending(): void {
    this.#adoption++
    this.#routeEpoch++
    for (const mounted of this.#mounted.values()) {
      mounted.abort.abort()
      mounted.abort = new AbortController()
      mounted.generation++
    }
  }
  /**
   * Set aside the components inside `page`, a `keepAlive` page the router hides: their pending work is
   * cancelled, and navigation neither updates nor unmounts them until `unpark` takes them back.
   * `bindComponentRouter` calls it on the page events.
   */
  park(page: Node): void {
    for (const mounted of this.#mounted.values())
      if (page.contains(mounted.host)) {
        this.#mounted.delete(mounted.record.instance)
        this.#parked.add(mounted)
        mounted.unwatch = onPageRelease(page, () => {
          void this.#release(mounted).catch(() => this.reportError("component_failed"))
        })
        mounted.abort.abort()
        mounted.abort = new AbortController()
        mounted.generation++
      }
  }
  /** Take back the components `park` set aside inside `page`, which is shown again. */
  unpark(page: Node): void {
    for (const mounted of this.#parked) {
      if (!page.contains(mounted.host)) continue
      const id = mounted.record.instance
      if (this.#mounted.has(id) || this.#disposed) {
        void this.#release(mounted)
        continue
      }
      this.#parked.delete(mounted)
      mounted.unwatch?.()
      if (mounted.root !== undefined) this.#mounted.set(id, mounted)
      // Hidden while it hydrated, which `park` cancelled: mount it again.
      else
        void this.#mount(mounted.host, id, mounted.host.childNodes.length === 0).catch(() =>
          this.reportError("component_failed"),
        )
    }
  }
  /**
   * Whether `instance` at `host` is parked with its hidden page. An outlet whose framework cleans up a
   * hidden page's effects (React's `<Activity>`) leaves it parked: the page takes it back when shown
   * again, and releases it when dropped.
   */
  isParked(instance: string, host: Element): boolean {
    for (const mounted of this.#parked)
      if (mounted.host === host && mounted.record.instance === instance) return true
    return false
  }
  async #release(mounted: Mounted): Promise<void> {
    if (!this.#parked.delete(mounted)) return
    mounted.unwatch?.()
    for (const child of this.#parked)
      if (mounted.host.contains(child.host)) await this.#release(child)
    mounted.abort.abort()
    await mounted.ready.catch(() => {
      /* A parked hydration was cancelled; nothing of it can commit. */
    })
    await mounted.root?.dispose()
  }
  async adopt(state: ComponentState, ownerUrl?: string): Promise<void> {
    if (ownerUrl !== undefined) this.#ownerUrl = ownerUrl
    if (this.#disposed || state === this.#source) return
    const next = parseComponentState(state)
    if (next.build !== this.state.build || next.adapter !== this.state.adapter) {
      this.#versionReload()
      return
    }
    const targets = new Map(
      [...this.#restorable].map(([id, host]) => [id, { host, mounted: this.#mounted.get(id) }]),
    )
    for (const mounted of this.#mounted.values())
      if (mounted.record.parent === null || !this.#mounted.has(mounted.record.parent))
        targets.set(mounted.record.instance, { host: mounted.host, mounted })
    this.cancelPending()
    const adoption = this.#adoption
    const changedScope = next.owner !== this.state.owner || next.scope !== this.state.scope
    if (changedScope) await this.#clearScope()
    if (this.#disposed || adoption !== this.#adoption) return
    this.#state = next
    this.#source = state
    this.#restorable.clear()
    for (const [id, target] of targets) {
      if (this.#disposed || adoption !== this.#adoption) return
      const mounted = target.mounted
      const record = next.records.find((item) => item.instance === id)
      if (record === undefined) {
        await this.unmount(id)
        continue
      }
      if (mounted !== undefined && !changedScope && !sameRecord(mounted.record, record))
        await this.unmount(id)
      try {
        await mounted?.ready
      } catch {
        /* Cancelled initial hydration owns its error and can retry from verified state. */
      }
      if (this.#disposed || adoption !== this.#adoption) return
      if (!this.#mounted.has(id)) {
        try {
          await this.#mount(target.host, id, true)
        } catch (error) {
          if (adoption === this.#adoption) throw error
        }
        continue
      }
      if (mounted === undefined || this.#mounted.get(id) !== mounted) continue
      const current = this.#current(mounted)
      if (!current()) continue
      const prepared = await this.#options.adapter.prepare(record, current, mounted.host, next)
      if (!current() || mounted.root === undefined) continue
      await this.#options.adapter.update(mounted.root, record, prepared, current)
      if (current()) {
        mounted.record = record
        await this.#syncChildren(mounted, next.records, current)
      }
    }
  }
  #descendants(instance: string): Mounted[] {
    const ids = new Set([instance])
    const descendants: Mounted[] = []
    for (let depth = 0; depth < 16; depth++)
      for (const mounted of this.#mounted.values()) {
        if (
          mounted.record.parent !== null &&
          ids.has(mounted.record.parent) &&
          !ids.has(mounted.record.instance)
        ) {
          ids.add(mounted.record.instance)
          descendants.push(mounted)
        }
      }
    return descendants
  }
  async #syncChildren(
    parent: Mounted,
    records: readonly ComponentRecord[],
    current: CurrentComponent,
  ): Promise<void> {
    if (typeof parent.host.querySelectorAll !== "function") return
    const targets = new Map<string, Element>()
    for (const host of parent.host.querySelectorAll("[data-nifra-component]")) {
      if (host.parentElement?.closest("[data-nifra-component]") !== parent.host) continue
      const id = host.getAttribute("data-nifra-component")
      if (
        id === null ||
        targets.has(id) ||
        !records.some(
          (record) => record.instance === id && record.parent === parent.record.instance,
        )
      )
        throw new ServerComponentError("component_contract")
      targets.set(id, host)
    }
    for (const child of [...this.#mounted.values()].filter(
      (item) => item.record.parent === parent.record.instance,
    )) {
      const record = records.find((item) => item.instance === child.record.instance)
      if (
        record === undefined ||
        targets.get(child.record.instance) !== child.host ||
        !sameRecord(child.record, record)
      )
        await this.unmount(child.record.instance)
    }
    for (const [id, host] of targets) {
      if (!current()) return
      const record = records.find((item) => item.instance === id)!
      const child = this.#mounted.get(id)
      if (child === undefined) {
        await this.#mount(host, id, host.childNodes.length === 0)
        continue
      }
      await child.ready
      const valid = this.#current(child)
      const prepared = await this.#options.adapter.prepare(
        record,
        () => current() && valid(),
        host,
        { records },
      )
      if (!current() || !valid() || child.root === undefined) return
      await this.#options.adapter.update(child.root, record, prepared, () => current() && valid())
      if (current() && valid()) {
        child.record = record
        await this.#syncChildren(child, records, () => current() && valid())
      }
    }
  }
  /** Unmount `instance`; an outlet passes its `host`, which tells a parked page's instance apart. */
  async unmount(instance: string, host?: Element): Promise<void> {
    for (const mounted of this.#parked)
      if (mounted.host === host && mounted.record.instance === instance)
        return this.#release(mounted)
    this.#restorable.delete(instance)
    await this.#unmount(instance)
  }
  async #unmount(instance: string): Promise<void> {
    const mounted = this.#mounted.get(instance)
    if (mounted === undefined) return
    this.#mounted.delete(instance)
    mounted.abort.abort()
    const children = [...this.#mounted.values()]
      .filter((child) => child.record.parent === instance)
      .map((child) => this.#unmount(child.record.instance))
    const teardown = (async () => {
      await Promise.all(children)
      await mounted.ready.catch(() => {
        /* Unmounted hydration cannot publish; its primary error belongs to mount. */
      })
      await mounted.root?.dispose()
    })()
    this.#teardown.set(mounted.host, teardown)
    try {
      await teardown
    } finally {
      if (this.#teardown.get(mounted.host) === teardown) this.#teardown.delete(mounted.host)
    }
  }
  async #clearScope(preserveOutlets = false, keepParked = false): Promise<void> {
    this.#authEpoch++
    if (preserveOutlets) {
      for (const mounted of this.#mounted.values())
        if (mounted.record.parent === null || !this.#mounted.has(mounted.record.parent))
          this.#restorable.set(mounted.record.instance, mounted.host)
    } else this.#restorable.clear()
    this.#state = { ...this.#state, records: [] }
    this.#source = undefined
    await Promise.all([
      ...[...this.#mounted.keys()].map((instance) => this.#unmount(instance)),
      ...(keepParked ? [] : [...this.#parked].map((mounted) => this.#release(mounted))),
    ])
  }
  async invalidateScope(): Promise<void> {
    this.#adoption++
    await this.#clearScope(true)
  }
  async navigate(): Promise<void> {
    this.cancelPending()
    await this.#clearScope(false, !this.#disposed)
  }
  async dispose(): Promise<void> {
    this.#disposed = true
    unregisterComponentController(this)
    for (const waiters of this.#mountWaiters.values()) for (const ready of waiters) ready()
    this.#mountWaiters.clear()
    await this.navigate()
  }
}
const reloadedBuilds = new Set<string>()

function recordSubtree(records: readonly ComponentRecord[], instance: string): Set<string> {
  const ids = new Set([instance])
  for (let depth = 0; depth < 16; depth++)
    for (const record of records)
      if (record.parent !== null && ids.has(record.parent)) ids.add(record.instance)
  return ids
}

export function resolveComponentRecord<Input>(
  state: ComponentState,
  component: Pick<ServerComponent<Input>, "reference" | "input">,
  key: ComponentKey,
  input: NoInfer<Input>,
  parent: string | null = null,
): ComponentRecord {
  const checked = parseComponentState(state)
  const serialized = componentInputKey(componentValue(input, COMPONENT_LIMITS.inputBytes))
  const matches = checked.records.filter(
    (record) =>
      record.reference === component.reference &&
      record.key === key &&
      record.parent === parent &&
      componentInputKey(record.input) === serialized,
  )
  if (matches.length !== 1) throw new ServerComponentError("component_unavailable", 404)
  return matches[0]!
}

/**
 * Experimental: how the client islands inside partially prerendered holes that show server
 * components mount, as the adapter's component client, such as `vueComponentClient({ islands })`;
 * `undefined` forgets it. Call it in the client entry before the router mounts. Without one such a
 * hole shows its error slot.
 */
export function holeComponents(client: ComponentClientAdapter | undefined): void {
  setHoleComponents(client === undefined ? undefined : { client, record: parseComponentRecord })
}
export { invalidateComponentScope } from "./registry.ts"
export { bindComponentRouter, refreshAfterComponentMutation } from "./router-integration.ts"
export { parseComponentState } from "./state.ts"
export type {
  ComponentKey,
  ComponentRecord,
  ComponentState,
  ServerComponent,
  ServerComponentHandle,
} from "./types.ts"

/**
 * The app's route table: one canonical fact per registered route, and the router built over them.
 *
 * ## Why this is not in the server kernel
 *
 * Nothing here knows what a `Server` is. It owns matching, reflection, assurance and native-compilation
 * input, and the kernel holds one instance - which is the whole relationship. The reason it lived in
 * `server.ts` is that `RouteEntry` used to be declared there, and until that vocabulary moved to
 * `internal/` this could not be split out without exporting the engine's internals as public types.
 *
 * ## Why this costs the request path nothing
 *
 * Per-request code calls `this.catalog.find(...)`: a property load and a method call on an instance.
 * Which module DECLARED the class does not enter into that. The only cross-module operation is the
 * `new RouteCatalog()` in the server's constructor, once per server; every other method here runs at
 * registration.
 */
import type { CompiledRoutePattern } from "../router/pattern.ts"
import { type Method, Router, type RouterMatch } from "../router/router.ts"
import type { RouteDescriptor } from "../server/server-types.ts"
import type { AssuranceDeclaration } from "./route-assurance.ts"
import type { RouteEntry } from "./route-execution.ts"

/** One canonical runtime route fact. The catalog owns matching, reflection, assurance, tool metadata,
 * replay, and native compilation input so batch registration has one commit point. */
export interface CatalogRoute {
  readonly method: Method
  readonly path: string
  readonly pattern: CompiledRoutePattern
  readonly entry: RouteEntry
  readonly descriptor: RouteDescriptor
  readonly assurance: readonly AssuranceDeclaration[]
}

/**
 * Runtime route catalog. Single-route registration mutates directly; multi-route registration replays
 * the existing catalog plus the candidate batch into a staged router, then swaps the complete state only
 * after every route validates. Failed `implement()`/`merge()` batches therefore leave matching and
 * reflection unchanged.
 *
 * Coverage note: this file reports 90% functions with every method exercised. `bun test --coverage`
 * (1.3.14) counts one synthetic function per class that it never marks hit - a one-method class with a
 * passing test for that method reports 50%. So 90 is this file's ceiling, not a missing test; do not go
 * looking for the tenth function.
 */
export class RouteCatalog {
  private matcher = new Router<RouteEntry>()
  private records: CatalogRoute[] = []
  /** Allocation-free reflection view for the common no-assurance case. Derived only at commit time. */
  private descriptors: RouteDescriptor[] = []
  private assurancePresent = false

  add(route: CatalogRoute): void {
    this.matcher.add(route.method, route.pattern, route.entry)
    this.records.push(route)
    this.descriptors.push(route.descriptor)
    if (route.assurance.length > 0) this.assurancePresent = true
  }

  addBatch(routes: readonly CatalogRoute[]): void {
    if (routes.length === 0) return
    const nextRecords = this.records.concat(routes)
    const nextDescriptors = this.descriptors.concat(routes.map(({ descriptor }) => descriptor))
    const nextAssurancePresent =
      this.assurancePresent || routes.some((route) => route.assurance.length > 0)
    const staged = new Router<RouteEntry>()
    for (const route of this.records) staged.add(route.method, route.pattern, route.entry)
    for (const route of routes) staged.add(route.method, route.pattern, route.entry)
    this.matcher = staged
    this.records = nextRecords
    this.descriptors = nextDescriptors
    this.assurancePresent = nextAssurancePresent
  }

  find(method: string, path: string): RouterMatch<RouteEntry> {
    return this.matcher.find(method, path)
  }

  entries(): readonly CatalogRoute[] {
    return this.records
  }

  routeDescriptors(): ReadonlyArray<RouteDescriptor> {
    return this.descriptors
  }

  lastDescriptor(): RouteDescriptor | undefined {
    return this.records[this.records.length - 1]?.descriptor
  }

  hasAssurance(): boolean {
    return this.assurancePresent
  }
}

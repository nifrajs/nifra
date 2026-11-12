import type { StandardSchemaV1 } from "@nifrajs/core/server"
import type { LoaderContext } from "../manifest.ts"

export type ComponentKey = string | number
export type ComponentValue =
  | null
  | boolean
  | number
  | string
  | readonly ComponentValue[]
  | {
      readonly [key: string]: ComponentValue
    }

export interface ServerComponentContext extends LoaderContext {
  readonly signal: AbortSignal
  readonly data: unknown
  readonly layoutData: readonly unknown[]
}

export interface ServerComponentDefinition<Input, Props, View> {
  readonly input: StandardSchemaV1<unknown, Input>
  readonly props: StandardSchemaV1<unknown, Props>
  readonly authorize: (ctx: ServerComponentContext, input: Input) => void | Promise<void>
  readonly load: (ctx: ServerComponentContext, input: Input) => unknown | Promise<unknown>
  readonly view: (args: {
    readonly props: Props
    readonly children?: readonly ComponentRecord[]
  }) => View | Promise<View>
  readonly capabilities?: readonly string[]
}

export interface ServerComponent<Input = unknown, Props = unknown, View = unknown> {
  /** Compiler-generated opaque reference; application authors do not assign module URLs. */
  readonly reference?: string
  readonly view: (args: {
    readonly props: Props
    readonly children?: readonly ComponentRecord[]
  }) => View | Promise<View>
  readonly input: StandardSchemaV1<unknown, Input>
  readonly props: StandardSchemaV1<unknown, Props>
}

export interface PreparedServerComponent<Props = unknown, View = unknown> {
  readonly props: Props
  readonly view: (args: {
    readonly props: Props
    readonly children?: readonly ComponentRecord[]
  }) => View | Promise<View>
}

export interface ComponentRenderContext {
  readonly reference: string
  readonly instance: string
  readonly signal: AbortSignal
  readonly nonce?: string
  readonly children?: readonly ComponentRecord[]
}

export interface ComponentRender {
  readonly html: string
  readonly payload?: ComponentValue
  readonly islands?: readonly ComponentIsland[]
}

export interface ComponentIsland {
  readonly reference: string
  readonly key: ComponentKey
  readonly props: ComponentValue
  readonly renderId: string
  readonly slots?: Readonly<Record<string, string>>
}

export interface ServerComponentRenderAdapter {
  readonly name: "react" | "vue" | "svelte" | "solid" | "preact"
  readonly version: 1
  render(
    view: unknown,
    props: unknown,
    context: ComponentRenderContext,
  ): ComponentRender | Promise<ComponentRender>
  /** Optional React Flight stream for progressive owner refreshes. */
  renderProgressive?(
    view: unknown,
    props: unknown,
    context: ComponentRenderContext,
  ): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
}

export interface ComponentInstance {
  readonly component: ServerComponentHandle
  readonly key: ComponentKey
  readonly input: unknown
  readonly parent?: string
}

export interface ComponentOwnerCachePolicy {
  /** The cache can serve this complete route document to any anonymous visitor. */
  readonly scope: "public"
  /**
   * Required assertion that route, loader, layout, and component output are request-independent.
   * Nifra observes request-header reads through owner-route middleware, layouts, component
   * authorization/loading, and app hooks registered with `createWebApp({ use })`. Accessing the
   * request from an owner loader is conservatively treated as a dependency, including a native
   * `Request` copy. Replaced/uninspectable request views fail closed. Database, environment, global,
   * external-service, and other dependencies remain the application's responsibility.
   */
  readonly requestIndependent: true
  /** Positive freshness window in seconds for this complete owner route. */
  readonly revalidate: number
  /** Public invalidation tags shared by this route's cached documents. */
  readonly tags?: readonly string[]
}

export interface ComponentOwner {
  readonly components: readonly ServerComponentHandle[]
  readonly capabilities?: readonly string[]
  /**
   * Opts the complete owner route document into the shared ISR store. This is an explicit
   * application contract: every loader, layout, owner callback, and rendered record for this
   * route must be independent of request identity and secrets. Runtime validation also requires
   * the anonymous owner scope and no component capabilities.
   * Request-header reads by route middleware/loaders/layouts, component authorization/loading, or
   * app hooks registered through `createWebApp({ use })` make that response ineligible for shared
   * storage. Replaced or uninspectable request views fail closed. Database, environment, global,
   * external-service, and other dependencies remain the application's responsibility.
   */
  readonly cache?: ComponentOwnerCachePolicy
  readonly instances: (
    ctx: ServerComponentContext,
  ) => readonly ComponentInstance[] | Promise<readonly ComponentInstance[]>
  /** A public, non-secret token supplied by the application's auth integration. */
  readonly scope: "anonymous" | ((ctx: ServerComponentContext) => string | Promise<string>)
}

/** The server components a partially prerendered route's holes may show. */
export interface ComponentHoles {
  readonly components: readonly ServerComponentHandle[]
  readonly capabilities?: readonly string[]
}

export interface ServerComponentHandle {
  readonly reference?: string
  readonly input: StandardSchemaV1
  readonly props: StandardSchemaV1
  readonly view: (args: never) => unknown
}

export interface ComponentRecord extends ComponentRender {
  readonly instance: string
  readonly reference: string
  readonly key: ComponentKey
  readonly parent: string | null
  readonly input: ComponentValue
}

export interface ComponentState {
  readonly v: 1
  readonly build: string
  readonly adapter: "react" | "vue" | "svelte" | "solid" | "preact"
  readonly owner: string
  readonly scope: string
  readonly records: readonly ComponentRecord[]
}

/** Optional seam passed to createWebApp; disabled applications have no runtime import of this feature. */
export interface ServerComponentRuntime {
  owns(routeId: string): boolean
  capabilities(routeId: string): readonly string[]
  /** Deployment/build/adapter/route identity for explicitly public owner-page ISR entries. */
  cacheIdentity?(routeId: string): string | undefined
  /** Public ISR policy for the complete document of an opted-in owner route. */
  cachePolicy?(routeId: string): ComponentOwnerCachePolicy | undefined
  classify(request: Request, routeId: string): import("./protocol.ts").ComponentRequest | undefined
  execute(
    routeId: string,
    context: ServerComponentContext,
    selection?: import("./protocol.ts").ComponentRequest,
    nonce?: string,
  ): Promise<ComponentState>
  /** Progressive owner refresh; present only when the render adapter supports it. */
  progressive?(
    routeId: string,
    context: ServerComponentContext,
    selection: import("./protocol.ts").ComponentRequest,
    nonce?: string,
  ): Promise<Response>
  response(state: ComponentState, selection: import("./protocol.ts").ComponentRequest): Response
  failure(error: unknown): Response
  /** Whether the route's partially prerendered holes may show server components. */
  hosts?(routeId: string): boolean
  /** Render `component` as the route's hole `key`, with the hole loader's output as its input. */
  hole?(
    routeId: string,
    component: object,
    key: string,
    input: unknown,
    context: ServerComponentContext,
  ): Promise<ComponentRecord>
}

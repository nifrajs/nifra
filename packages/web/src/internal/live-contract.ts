/**
 * The seam between page execution and a configured live runtime (`@nifrajs/web/live`): types and one
 * symbol. An app without `live` imports nothing from the live module itself.
 */
import type { IdentityPlugin, WebSocketHandler } from "@nifrajs/core/server"
import type { LoaderContext } from "../manifest.ts"
import type { LiveClientEntry } from "./codegen.ts"

/** What `createWebApp` tells the runtime about its routes. */
export interface LiveRouteMatch {
  readonly routeId: string
  readonly layoutIds: readonly string[]
}

/** The app the live socket registers on. */
export interface LiveHostApp {
  use(plugin: IdentityPlugin): unknown
  ws<Data>(path: string, handler: WebSocketHandler<Data>): unknown
  publish(topic: string, data: string): void
}

export interface LiveAttachInput {
  /** The route a canonical `pathname + search` renders, or `null`. */
  readonly matchRoute: (path: string) => LiveRouteMatch | null
  readonly app: LiveHostApp
}

export interface LiveAttachment {
  /** Admission and dispatch for the live load endpoint; `undefined` for every other request. */
  readonly onRequest: (req: Request) => Promise<Request | Response> | undefined
  /** The live load a page request belongs to, or `undefined` for every request that is not one. */
  readonly loadOf: (req: Request) => LiveLoad | undefined
}

/** One live load, from the page handler's side. */
export interface LiveLoad {
  /** The route the endpoint mapped the retain list against. */
  readonly routeId: string
  /** `undefined` when admitted; else the 503 to answer with. An admitted load is released once. */
  admit(): Response | undefined
  /** Release the admission slot once the response is complete: at once, or when its stream ends. */
  settle(response: Response): Response
  release(): void
  /**
   * After middleware: resolve the viewer's subject. `false` when the presented grant's retention no
   * longer applies (another subject), so every owner loads fresh.
   */
  bind(ctx: LoaderContext): Promise<boolean>
  /** Skip the page loader: the page owner is retained. Read after {@link bind}. */
  readonly retainPage: boolean
  /** `ctx.live` for one owner. */
  collector(owner: string): (...keys: string[]) => void
  /** Close an owner's collector once its loader has settled. */
  seal(owner: string): void
  /** The envelope's `live` member, built after every loader settled without a throw or status. */
  finish(input: LiveFinish): Promise<LiveEnvelope>
}

export interface LiveFinish {
  /** Owners whose loaders ran and resolved. */
  readonly fresh: readonly string[]
  /** Owners whose loaders were skipped: their keys come from the presented grant. */
  readonly retained: readonly string[]
  readonly ctx: LoaderContext
}

export interface LiveEnvelope {
  /**
   * Opaque and stable per viewer, one per listed secret, newest first. A load sharing none with the
   * last one is another user, so client caches are cleared; a rotation always leaves one in common.
   */
  readonly subjects: readonly string[]
  /** Absent when no grant could be issued; the client then polls. */
  readonly grant?: string
  /** Wire tag to the frame's owners that watch its key. */
  readonly tags?: Readonly<Record<string, readonly string[]>>
  /** The page loader did not run: the client keeps its page data. */
  readonly page?: "retained"
  /** Seconds the grant stays valid from now; the client renews a minute before. */
  readonly ttl?: number
  /** For query hooks: with `queryKeys`, and in development so the page can warn. */
  readonly query?: LiveQueryKeys
}

export interface LiveQueryKeys {
  /** Fresh per load; absent when `queryKeys` is off. */
  readonly salt?: string
  /** Wire tag to its key's digest under `salt`. */
  readonly keys?: Readonly<Record<string, string>>
  /** The app runs in development: the page warns about query keys no grant holds. */
  readonly dev?: true
}

/** `createWebApp` reads the runtime through this symbol, so it is not public API on the object. */
export const LIVE_ATTACH: unique symbol = Symbol.for("nifra.web.live.attach")

export interface LiveRuntimeHandle {
  readonly [LIVE_ATTACH]: (input: LiveAttachInput) => LiveAttachment
  /** The client entry's `live` option for this runtime: the endpoints it serves, where not the default. */
  readonly clientEntry: LiveClientEntry
  /** Announce changed keys; resolves once this process applied the change. */
  publish(...keys: string[]): Promise<void>
}

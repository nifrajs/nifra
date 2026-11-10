import { fillRoutePath } from "@nifrajs/core/pattern"
import { type E2EApp, type E2EPaths, e2eUrl, serveTestApp } from "@nifrajs/testing/e2e"
import { type Agent, createAgent, type E2EModel } from "./agent.ts"
import { type Cache, type CacheOptions, createCache } from "./cache.ts"
import {
  type Clock,
  E2EError,
  type Engine,
  type EngineFactory,
  type HydrationMode,
  realClock,
} from "./engine.ts"
import type { UrlSource } from "./expect.ts"
import { type LocatorContext, Screen } from "./locator.ts"
import { playwrightEngine } from "./playwright.ts"

/** The `:name` segments of a route path. */
export type PathParams<P extends string> = P extends `${string}:${infer Rest}`
  ? Rest extends `${infer Name}/${infer Tail}`
    ? Name | PathParams<`/${Tail}`>
    : Rest
  : never

export interface OpenOptions<P extends string> {
  readonly params?: Record<PathParams<P>, string | number>
  readonly query?: Readonly<Record<string, string | number | boolean>>
}

/** A route with `:params` must be given them; one without takes only an optional query. */
export type OpenArgs<P extends string> = [PathParams<P>] extends [never]
  ? [options?: { readonly query?: OpenOptions<P>["query"] }]
  : [
      options: {
        readonly params: Record<PathParams<P>, string | number>
        readonly query?: OpenOptions<P>["query"]
      },
    ]

export interface E2EOptions {
  /** Defaults to the Playwright engine (`@nifrajs/e2e/playwright`), which needs `playwright` installed. */
  readonly engine?: EngineFactory
  /** A `testSession().cookies` jar (or anything with `header()`): logs the browser in without a UI login. */
  readonly cookies?: { header(): string }
  readonly hydration?: HydrationMode
  /** ms an action waits for its element. Default 5000. */
  readonly actionTimeout?: number
  /** ms an assertion retries before it fails. Default 5000. */
  readonly assertionTimeout?: number
  readonly pollInterval?: number
  readonly clock?: Clock
  /** Answers agent steps. Without it `t.agent` rejects with `MODEL_MISSING`; locator tests need none. */
  readonly model?: E2EModel | undefined
  /** Words every agent step should know: the product, its jargon, what a plan is called. */
  readonly agentContext?: string
  /** Characters of page outline one model call may carry. Default 12000. */
  readonly snapshotChars?: number
  /** The replay cache for `agent.act`. On by default; `false` turns it off. */
  readonly cache?: CacheOptions | false
}

export interface E2ESession<App> extends UrlSource, AsyncDisposable {
  readonly baseUrl: string
  readonly screen: Screen
  readonly agent: Agent
  open<P extends E2EPaths<App>>(path: P, ...args: OpenArgs<P>): Promise<void>
  close(): Promise<void>
}

export function parseCookieHeader(header: string): { name: string; value: string }[] {
  const cookies: { name: string; value: string }[] = []
  for (const raw of header.split(";")) {
    const part = raw.trim()
    const at = part.indexOf("=")
    if (at <= 0) continue
    cookies.push({ name: part.slice(0, at), value: part.slice(at + 1) })
  }
  return cookies
}

export function buildPath(
  pattern: string,
  params: Readonly<Record<string, string | number>> | undefined,
  query: Readonly<Record<string, string | number | boolean>> | undefined,
): string {
  const given: Record<string, string> = {}
  for (const [name, value] of Object.entries(params ?? {})) given[name] = String(value)
  const filled = fillRoutePath(pattern, given)
  if (!filled.ok) {
    const [missing] = filled.missing
    throw new E2EError(
      "BAD_PATH",
      missing === undefined
        ? `route ${pattern} cannot carry the value of "${filled.invalid.join('", "')}"`
        : `route ${pattern} needs the param "${missing}"`,
    )
  }
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) search.set(key, String(value))
  const text = search.toString()
  return text === "" ? filled.path : `${filled.path}?${text}`
}

/**
 * Serve `app` on an ephemeral port and drive it from a browser. The session is `AsyncDisposable`:
 * `await using t = await e2e(app)` closes the browser and the server at scope exit.
 */
export async function e2e<App extends E2EApp>(
  app: App,
  options: E2EOptions = {},
): Promise<E2ESession<App>> {
  const factory = options.engine ?? playwrightEngine()
  const served = await serveTestApp(app)
  let engine: Engine
  try {
    engine = await factory({
      baseUrl: served.baseUrl,
      cookies: options.cookies === undefined ? [] : parseCookieHeader(options.cookies.header()),
      hydration: options.hydration ?? "auto",
    })
  } catch (error) {
    await served.stop()
    throw error
  }
  const cache: Cache | undefined = options.cache === false ? undefined : createCache(options.cache)
  const context: LocatorContext = {
    engine,
    clock: options.clock ?? realClock,
    actionTimeout: options.actionTimeout ?? 5000,
    assertionTimeout: options.assertionTimeout ?? 5000,
    pollInterval: options.pollInterval ?? 100,
    onCheck: cache === undefined ? undefined : (passed) => cache.onCheck(passed),
  }
  const agent = createAgent({
    engine,
    clock: context.clock,
    pollInterval: context.pollInterval,
    actionTimeout: context.actionTimeout,
    model: options.model,
    context: options.agentContext,
    snapshotChars: options.snapshotChars ?? 12_000,
    origin: new URL(served.baseUrl).origin,
    cache,
    navigate: (path) => {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a model-chosen path is not a declared route; e2eUrl refuses anything that is not a same-origin path.
      return engine.goto(e2eUrl<App>(served.baseUrl, path as E2EPaths<App>))
    },
  })
  let closed: Promise<void> | undefined
  const close = (): Promise<void> => {
    closed ??= engine.close().finally(() => served.stop())
    return closed
  }
  return {
    baseUrl: served.baseUrl,
    context,
    screen: new Screen(context),
    agent,
    open: async (path, ...args) => {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: OpenArgs is a tuple of this one options shape per route; buildPath rejects a missing param at run time.
      const given = args[0] as
        | {
            params?: Record<string, string | number>
            query?: Record<string, string | number | boolean>
          }
        | undefined
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the type was checked at the call site (P extends E2EPaths<App>); e2eUrl re-checks same-origin at run time.
      const route = buildPath(path, given?.params, given?.query) as E2EPaths<App>
      return engine.goto(e2eUrl<App>(served.baseUrl, route))
    },
    url: () => engine.url(),
    path: async () => {
      const url = new URL(await engine.url())
      return `${url.pathname}${url.search}`
    },
    close,
    [Symbol.asyncDispose]: close,
  }
}

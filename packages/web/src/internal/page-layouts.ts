import { rawHref } from "../href.ts"
import type { LayoutEntry, LoaderContext, RouteEntry } from "../manifest.ts"
import { NAV_FROM_HEADER, RETAIN_HEADER } from "../router.ts"
import type { LiveLoad } from "./live-contract.ts"
import { forkLoaderContext } from "./loader-context.ts"
import type { ExecutionBase } from "./page-execution-base.ts"
import { keepsLayoutData, pathOf, retainedIndices, runGate } from "./page-execution-helpers.ts"
import {
  type GatedLayouts,
  isDataRequest,
  type LayoutRun,
  type PageRouteContext,
  type RetainContext,
  runLiveLoader,
} from "./page-execution-shared.ts"
import {
  isControlFlow,
  type LoadedLayoutModules,
  redirect,
  scopeParams,
  tagLayoutError,
} from "./render-document.ts"
import { MIDDLEWARE_SCOPE, type PageResponseControls } from "./response-controls.ts"
import { isStatusSignal, notFound } from "./status-page.ts"

const ignore = (): void => {}

export function createLayoutRunner<Env = unknown>(base: ExecutionBase<Env>) {
  const { manifest, cacheModules, loadModule, i18n, localeGuarded, matchManifestRoute, routeById } =
    base
  const preparedLayouts = new WeakMap<RouteEntry, LoadedLayoutModules>()

  // Load a route's layout modules once for the current execution. The render path needs each whole
  // module for its component + meta, while the data path also needs loader/gate/boundary declarations.
  const loadLayoutModules = async (route: RouteEntry): Promise<LoadedLayoutModules> => {
    const known = cacheModules ? preparedLayouts.get(route) : undefined
    if (known !== undefined) return known
    const modules = await Promise.all(
      route.layoutIds.map((id) => loadModule(manifest.layouts[id] as LayoutEntry)),
    )
    for (let i = 0; i < modules.length; i++) {
      if ((modules[i] as { action?: unknown }).action === undefined) continue
      const id = route.layoutIds[i] as string
      throw new Error(
        `[nifra/web] "${(manifest.layouts[id] as LayoutEntry).file}" exports an \`action\`, but layouts do not run one - only route files do. Move the mutation into the route that submits to it.`,
      )
    }
    if (cacheModules) preparedLayouts.set(route, modules)
    return modules
  }

  // No modules, data, or per-request state: reuse the settled result for page-only routes.
  const emptyLayoutRun: LayoutRun = {
    modules: [],
    layoutData: undefined,
    retained: [],
    pending: undefined,
  }

  // Development only. A layout loader that refuses access reads as a guard, and is not one: a client
  // navigation can skip it and an action below it runs without it.
  const warnsUngatedRefusal =
    typeof process !== "undefined" && process.env?.NODE_ENV === "development"
  const warnedUngated = new Set<string>()
  const warnUngatedRefusal = (layoutId: string, outcome: unknown): void => {
    if (warnedUngated.has(layoutId)) return
    // notFound() and gone() say the record is missing, which a layout may decide without guarding.
    const refusesAccess = isStatusSignal(outcome)
      ? outcome.status === 401 || outcome.status === 403
      : isControlFlow(outcome)
    if (!refusesAccess) return
    warnedUngated.add(layoutId)
    const file = manifest.layouts?.[layoutId]?.file ?? layoutId
    console.warn(
      `[nifra/web] the loader in "${file}" refused a request, but that layout is not a gate. A client navigation that keeps the layout on screen can skip its loader, and an action below it runs without it, so it does not protect the pages under it. Export \`gate = true\` from that file, or move the check into middleware. (Shown in development only.)`,
    )
  }

  /**
   * Run layout loaders, awaiting gates before starting the page loader and retaining only safe data.
   * `gated` carries gates that already ran for this request, so none runs twice.
   */
  const runLayoutChain = async (
    route: RouteEntry,
    ctx: LoaderContext,
    controls: PageResponseControls,
    retain?: RetainContext,
    gated?: GatedLayouts,
    live?: LiveLoad,
  ): Promise<LayoutRun> => {
    if (route.layoutIds.length === 0) return emptyLayoutRun
    const modules = gated?.modules ?? (await loadLayoutModules(route))
    if (!modules.some((m) => m.loader !== undefined)) {
      return { modules, layoutData: undefined, retained: [], pending: undefined }
    }
    const results: unknown[] = new Array(modules.length).fill(null)
    const retained: number[] = []
    const pending: Array<Promise<void>> = []
    try {
      for (let i = 0; i < modules.length; i++) {
        const layout = modules[i] as LoadedLayoutModules[number]
        const loader = layout.loader
        if (loader === undefined) continue
        if (retain !== undefined && layout.gate !== true) {
          let keep: boolean
          try {
            keep = keepsLayoutData(route, i, layout, ctx.params, retain)
          } catch (err) {
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The loaded layout array is derived from these same manifest IDs in the same order.
            throw tagLayoutError(err, route.layoutIds[i] as string)
          }
          if (keep) {
            retained.push(i)
            continue
          }
        }
        const scoped = forkLoaderContext(ctx, {
          params: scopeParams(ctx.params, route.layoutParams?.[i]),
          set: controls.scope(i),
        })
        const layoutId = route.layoutIds[i] as string
        if (modules[i]?.gate === true) {
          results[i] =
            gated !== undefined
              ? gated.gates[i]
              : await runGate(
                  route,
                  i,
                  live === undefined
                    ? loader
                    : (gateCtx) => runLiveLoader(live, `L:${layoutId}`, loader, gateCtx),
                  scoped,
                )
          continue
        }
        const index = i
        try {
          const value =
            live === undefined
              ? loader(scoped)
              : runLiveLoader(live, `L:${layoutId}`, loader, scoped)
          // Scalars settle synchronously. Objects keep await's intrinsic promise/thenable
          // assimilation: property-presence and prototype probes are unsafe for proxies.
          if (value !== null && (typeof value === "object" || typeof value === "function")) {
            pending.push(
              (async () => {
                let settled: unknown
                try {
                  settled = await value
                } catch (err) {
                  if (warnsUngatedRefusal) warnUngatedRefusal(layoutId, err)
                  throw tagLayoutError(err, layoutId)
                }
                // A returned redirect or Response refuses exactly as a thrown one: kept as layout data,
                // it would ship beside the page loader's data.
                if (isControlFlow(settled)) {
                  if (warnsUngatedRefusal) warnUngatedRefusal(layoutId, settled)
                  throw tagLayoutError(settled, layoutId)
                }
                results[index] = settled
              })(),
            )
          } else results[index] = value
        } catch (err) {
          if (warnsUngatedRefusal) warnUngatedRefusal(layoutId, err)
          // Preserve a synchronous throw as a pending layout failure, just like the async lane.
          pending.push(Promise.reject(tagLayoutError(err, layoutId)))
        }
      }
    } catch (err) {
      // The chain is abandoned: a loader it already started must not fail unobserved.
      for (const promise of pending) promise.catch(ignore)
      throw err
    }
    return {
      modules,
      layoutData: results,
      retained,
      pending:
        pending.length === 0 ? undefined : pending.length === 1 ? pending[0] : Promise.all(pending),
    }
  }

  /** Run only authorization gates before an action; ordinary layout data runs after a native action. */
  const runLayoutGates = async (
    route: RouteEntry,
    ctx: LoaderContext,
    controls: PageResponseControls,
  ): Promise<GatedLayouts> => {
    const modules = await loadLayoutModules(route)
    const gates: unknown[] = []
    for (let i = 0; i < modules.length; i++) {
      const mod = modules[i]
      if (mod?.gate !== true || mod.loader === undefined) continue
      gates[i] = await runGate(
        route,
        i,
        mod.loader,
        forkLoaderContext(ctx, {
          params: scopeParams(ctx.params, route.layoutParams?.[i]),
          set: controls.scope(i),
        }),
      )
    }
    return { modules, gates }
  }

  /** Outermost first; a failure carries its directory so the nearest `_error` above it renders. */
  const runMiddleware = async (
    route: RouteEntry,
    ctx: LoaderContext,
    controls: PageResponseControls,
    request: Request,
  ): Promise<void> => {
    if (i18n !== undefined && localeGuarded(route)) {
      // Before any app middleware, as a root `_middleware` would run: an unserved locale, or a page
      // missing from it, never reaches the app's code.
      const match = i18n.matchSegment(ctx.params.lang, pathOf(request))
      if (match.kind === "redirect") {
        throw tagLayoutError(redirect(rawHref(match.location), { status: 308 }), "_layout")
      }
      if (match.kind === "not-found") {
        try {
          notFound()
        } catch (signal) {
          throw tagLayoutError(signal, "_layout")
        }
      }
    }
    const ids = route.middlewareIds ?? []
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as string
      const entry = manifest.middlewares?.[id] as LayoutEntry
      const dirTag = `${id.slice(0, id.length - "_middleware".length)}_layout`
      let outcome: unknown
      try {
        const middleware = (await loadModule(entry)).default
        // A `_layout.backend.ts` that exports no middleware is a layout data module, nothing more.
        if (middleware === undefined) continue
        if (typeof middleware !== "function") {
          throw new Error(
            `[nifra/web] "${entry.file}" exports a middleware that is not a function.`,
          )
        }
        outcome = await middleware(
          forkLoaderContext(ctx, {
            params: scopeParams(ctx.params, route.middlewareParams?.[i]),
            set: controls.scope(MIDDLEWARE_SCOPE + i),
          }),
        )
      } catch (err) {
        throw tagLayoutError(err, dirTag)
      }
      if (outcome === undefined) continue
      throw tagLayoutError(
        isControlFlow(outcome)
          ? outcome
          : new Error(
              `[nifra/web] the middleware in "${entry.file}" returned a value. Middleware returns nothing to let the request through, or a redirect(), a status such as notFound(), or a Response to answer it.`,
            ),
        dirTag,
      )
    }
  }

  /**
   * The browser's side of a client navigation: the page it is leaving and the layout slots it asked
   * to keep. Undefined unless this is a data request whose `from` is same-origin and routable.
   */
  const retainContextOf = (c: PageRouteContext<Env>): RetainContext | undefined => {
    if (!isDataRequest(c)) return undefined
    const req = c.req
    const requested = retainedIndices(req.headers.get(RETAIN_HEADER))
    const from = req.headers.get(NAV_FROM_HEADER)
    if (requested.size === 0 || from === null) return undefined
    let toUrl: URL
    let fromUrl: URL
    try {
      toUrl = new URL(req.url)
      fromUrl = new URL(from, toUrl)
    } catch {
      return undefined
    }
    if (fromUrl.origin !== toUrl.origin) return undefined
    const previousMatch = matchManifestRoute(fromUrl.pathname + fromUrl.search)
    if (previousMatch === null) return undefined
    const previous = routeById.get(previousMatch.routeId)
    if (previous === undefined) return undefined
    return { requested, from: previous, fromParams: previousMatch.params, fromUrl, toUrl }
  }

  return {
    loadLayoutModules,
    runLayoutChain,
    runLayoutGates,
    runMiddleware,
    retainContextOf,
  }
}

export type LayoutRunner<Env = unknown> = ReturnType<typeof createLayoutRunner<Env>>

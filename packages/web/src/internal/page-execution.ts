import {
  type BoundaryRequestCtx,
  type BoundaryStates,
  boundaryDescriptors,
  resolveStaticBoundaries,
  startDynamicBoundaries,
} from "../boundary.ts"
import { defer } from "../deferred.ts"
import type { LoaderContext, RouteModule } from "../manifest.ts"
import { PREFETCH_HEADER } from "../router.ts"
import { forkLoaderContext, markLoaderContextWithLazyRequestAccessors } from "./loader-context.ts"
import { createActionHandler } from "./page-action.ts"
import { createDocumentRenderer } from "./page-document.ts"
import { createExecutionBase } from "./page-execution-base.ts"
import {
  leadingLayouts,
  liveOwners,
  loaderSearch,
  pathOf,
  searchChainOf,
} from "./page-execution-helpers.ts"
import {
  dataRedirect,
  type HoleOwners,
  holeRefresh,
  isDataRequest,
  type LayoutRun,
  liveEnvelopeOf,
  NO_LIVE,
  type PageExecutionOptions,
  type PageRequestExecutor,
  type PageResponse,
  type PageRouteContext,
  runLiveLoader,
  SENT_CONTROLS,
} from "./page-execution-shared.ts"
import { createLayoutRunner } from "./page-layouts.ts"
import { createStatusRenderer } from "./page-status.ts"
import { type PprRequest, serverHoleComponent } from "./ppr/contract.ts"
import {
  isControlFlow,
  type LoadedLayoutModules,
  type RenderAssemblyCache,
  tagLayoutError,
} from "./render-document.ts"
import {
  markRequestHeaderDependent,
  OWNER_REQUEST_HEADER_DEPENDENCY_HEADER,
  requestHeadersWereRead,
  trackRequestHeaderReads,
} from "./request-header-tracker.ts"
import { urlPartsFor } from "./request-url.ts"
import { PAGE_SCOPE, PageResponseControls, privateOutcome } from "./response-controls.ts"
import { isStatusSignal } from "./status-page.ts"

export type { NonceResolver } from "../nonce.ts"
export type {
  PageExecutionOptions,
  PageI18n,
  PageRequestExecutor,
  PageRouteContext,
} from "./page-execution-shared.ts"

/**
 * Own the page request program behind one private seam.
 *
 * `createWebApp` remains responsible for app construction, mount ordering, and route registration.
 * This module owns the page-specific contract: context, layout execution, control-flow precedence,
 * data/document assembly, and error/status rendering. GET and POST retain their distinct ordering
 * (ordinary layout data may run after an action; a gate must run before it) while sharing the same
 * outcome and render decisions.
 */
export function createPageRequestExecutor<Env = unknown>(
  options: PageExecutionOptions<Env>,
): PageRequestExecutor<Env> {
  const base = createExecutionBase(options)
  const layouts = createLayoutRunner(base)
  const status = createStatusRenderer(base, layouts)
  const {
    cacheModules,
    loadModule,
    apiFor,
    prerenderedSet,
    i18n,
    localeGuarded,
    matchManifestRoute,
    routeById,
    notFoundTargets,
    matchNotFoundScope,
    draftFlag,
    resolveNonce,
  } = base
  const { loadLayoutModules, runLayoutChain, runMiddleware, retainContextOf } = layouts
  const {
    renderStatusSignal,
    renderLoaderFailure,
    renderNestedNotFound,
    renderRouteNotFound,
    renderRouteFailure,
    renderNotFound,
  } = status

  const liveLoadOf = options.liveLoadOf
  const liveSeedOf = options.liveSeedOf

  // The action result is request-local; a browser cannot manufacture this handoff.
  const progressiveActionData = new WeakMap<Request, unknown>()
  const { handleDataOrDocument, pprRequestFor } = createDocumentRenderer(
    base,
    status,
    progressiveActionData,
  )
  const actionFor = createActionHandler(base, layouts, status, progressiveActionData)

  /** A live load holds one admission slot from before its middleware until its body is complete. */
  const admitLive =
    (run: (c: PageRouteContext<Env>, controls: PageResponseControls) => Promise<PageResponse>) =>
    async (c: PageRouteContext<Env>, controls: PageResponseControls): Promise<PageResponse> => {
      const live = liveLoadOf?.(c.req)
      if (live === undefined) return run(c, controls)
      const refused = live.admit()
      if (refused !== undefined) return refused
      let outcome: PageResponse
      try {
        outcome = await run(c, controls)
      } catch (err) {
        live.release()
        throw err
      }
      if (outcome instanceof Response) return live.settle(outcome)
      live.release()
      return outcome
    }

  /**
   * Run a page handler with the request's `ctx.set`, sealed once the handler settles - whatever it
   * answered with - so a write that arrives after the response was decided throws. A request that
   * queued a cookie answers with a response no shared cache may store, returned or thrown. A redirect
   * answering a data request, returned or thrown, reaches the client router intact.
   */
  const withResponseControls =
    (run: (c: PageRouteContext<Env>, controls: PageResponseControls) => Promise<PageResponse>) =>
    async (c: PageRouteContext<Env>): Promise<PageResponse> => {
      const controls = new PageResponseControls(c)
      try {
        const outcome = await run(c, controls)
        const answer = dataRedirect(c.req, isDataRequest(c), outcome) ?? outcome
        return controls.personalized ? (privateOutcome(answer) as PageResponse) : answer
      } catch (err) {
        if (!isControlFlow(err)) throw err
        const answer = dataRedirect(c.req, isDataRequest(c), err)
        // Returned rather than rethrown: the serving app sends a thrown `Response` exactly as it is,
        // without the cookies the request queued.
        if (controls.personalized) return privateOutcome(answer ?? err) as PageResponse
        if (answer !== undefined) return answer
        throw err
      } finally {
        controls.seal()
      }
    }

  return {
    get: (route) => {
      const is404Fallback = options.staticFallbacks?.[route.pattern] === "404"
      // One shell per locale: `<html lang>` is in it, and one route serves every locale.
      let assemblySlots = new Map<string, RenderAssemblyCache>()
      let assemblySlotMod: unknown
      let assemblySlotLayouts: LoadedLayoutModules | undefined
      const assemblyCacheFor = (
        mod: RouteModule,
        layouts: LoadedLayoutModules,
        req: Request,
      ): RenderAssemblyCache | undefined => {
        if (typeof mod.meta === "function") return undefined
        for (const layout of layouts) if (typeof layout.meta === "function") return undefined
        const layoutsUnchanged =
          assemblySlotLayouts !== undefined &&
          assemblySlotLayouts.length === layouts.length &&
          assemblySlotLayouts.every((layout, index) => layout === layouts[index])
        if (assemblySlotMod !== mod || !layoutsUnchanged) {
          assemblySlots = new Map()
          assemblySlotMod = mod
          assemblySlotLayouts = layouts
        }
        const key = i18n === undefined ? "" : i18n.localeOf(pathOf(req))
        let slot = assemblySlots.get(key)
        if (slot === undefined) {
          slot = {}
          assemblySlots.set(key, slot)
        }
        return slot
      }

      const page = async (
        c: PageRouteContext<Env>,
        controls: PageResponseControls,
      ): Promise<PageResponse> => {
        let live = liveLoadOf?.(c.req)
        const componentRuntime = options.serverComponents
        const componentOwner = componentRuntime?.owns(route.id) === true
        const loaderRequest =
          componentOwner && c.req.method === "GET" ? trackRequestHeaderReads(c.req) : c.req
        let componentRequest:
          | import("../server-components/protocol.ts").ComponentRequest
          | undefined
        try {
          componentRequest = componentRuntime?.classify(c.req, route.id)
        } catch (error) {
          return componentRuntime!.failure(error)
        }
        if (componentOwner || componentRequest !== undefined) controls.personalize()
        if (!componentOwner && is404Fallback && !prerenderedSet.has(urlPartsFor(c.req).pathname)) {
          return renderNotFound(c, controls)
        }
        const loaded = loadModule(route)
        const mod = cacheModules && !(loaded instanceof Promise) ? loaded : await loaded
        // A document's loaders declare their keys into a seed, which the page exchanges for a grant
        // once its socket opens, instead of loading itself again. Partially prerendered pages, whose
        // holes settle after the shell, and server-component routes load as before.
        const seeding =
          live === undefined &&
          liveSeedOf !== undefined &&
          !componentOwner &&
          componentRequest === undefined &&
          (options.ppr === undefined || mod.shellLoader === undefined) &&
          !isDataRequest(c)
        if (seeding) live = liveSeedOf(c.req, route.id)
        const draft = await draftFlag(c.req)
        // Unpublished content is the editor's alone: whatever cache-control a loader sets, no cache keeps it.
        if (draft) controls.personalize()
        let data: unknown
        let layoutData: readonly unknown[] | undefined
        let boundaryStates: BoundaryStates | undefined
        let layoutModules: LoadedLayoutModules | undefined
        let layoutRetained: readonly number[] = []
        let responseHeaders: Record<string, string> | undefined
        let componentState: import("../server-components/types.ts").ComponentState | undefined
        let componentAnswer: Response | undefined
        const requestApi = apiFor(c)
        let run: LayoutRun | undefined
        let skipPage = false
        let liveCtx: LoaderContext
        let holeOwners: HoleOwners | undefined
        try {
          const ctx: LoaderContext = {
            params: c.params,
            request: loaderRequest,
            req: loaderRequest,
            api: requestApi,
            env: c.env,
            draft,
            search: loaderSearch(mod.searchSchema, c.req),
            set: controls.scope(PAGE_SCOPE),
            live: NO_LIVE,
          }
          if (componentOwner && c.req.method === "GET") {
            const ownerRequest = (): Request => {
              markRequestHeaderDependent(loaderRequest)
              return loaderRequest
            }
            Object.defineProperties(ctx, {
              request: { configurable: true, enumerable: true, get: ownerRequest },
              req: { configurable: true, enumerable: true, get: ownerRequest },
            })
            markLoaderContextWithLazyRequestAccessors(ctx)
          }
          if (route.middlewareIds !== undefined || localeGuarded(route)) {
            await runMiddleware(route, ctx, controls, c.req)
          }
          // After middleware, before any loader: a grant issued to another viewer keeps nothing.
          const retains = live === undefined || (await live.bind(ctx))
          skipPage =
            live !== undefined &&
            retains &&
            !componentOwner &&
            live.retainPage &&
            live.routeId === route.id
          run = await runLayoutChain(
            route,
            ctx,
            controls,
            componentOwner || !retains ? undefined : retainContextOf(c),
            undefined,
            live,
          )
          layoutModules = run.modules
          layoutRetained = run.retained
          const boundaryDefinitions =
            componentRequest === undefined
              ? [
                  ...run.modules.flatMap((layout) => layout.boundaries ?? []),
                  ...(mod.boundaries ?? []),
                ]
              : []
          if (boundaryDefinitions.length > 0) boundaryDescriptors(boundaryDefinitions)
          const effectiveSearch = searchChainOf(run.modules, mod, c.req)
          const ppr = options.ppr
          const shellLoader =
            componentRequest === undefined && !componentOwner ? mod.shellLoader : undefined
          let pprRequest: PprRequest | undefined
          // How a document that renders whole gets its holes: complete, unless no shell exists yet.
          let wholeHoles: "settled" | "deferred" = "settled"
          if (ppr !== undefined && shellLoader !== undefined) {
            ppr.assertRoute(route, run.modules, boundaryDefinitions)
            pprRequest = pprRequestFor(
              c,
              route,
              mod,
              run.modules,
              boundaryDefinitions,
              shellLoader,
              requestApi,
              draft,
              effectiveSearch,
            )
            const refresh = holeRefresh(c, pprRequest, live)
            if (refresh instanceof Response) return refresh
            pprRequest = refresh.request
            holeOwners = refresh.owners
            const components = options.serverComponents
            const renderHole = components?.hosts?.(route.id) === true ? components.hole : undefined
            if (
              renderHole === undefined &&
              pprRequest.holes.some((hole) => serverHoleComponent(hole.render) !== undefined)
            ) {
              throw new Error(
                `[nifra/web] ppr: route "${route.id}" has a hole that shows a server component; list the component under createServerComponents({ holes }) for this route`,
              )
            }
            if (renderHole !== undefined) {
              const loaderCtx = ctx
              pprRequest = {
                ...pprRequest,
                // The owner path's context, but with the hole's signal and no response to change.
                component: (name, component, input, signal) =>
                  renderHole.call(
                    components,
                    route.id,
                    component,
                    name,
                    input,
                    Object.create(
                      c,
                      Object.getOwnPropertyDescriptors({
                        ...loaderCtx,
                        search: effectiveSearch,
                        set: SENT_CONTROLS,
                        signal,
                        data: undefined,
                        layoutData: [],
                      }),
                    ),
                  ),
              }
            }
            // A draft is the editor's alone, so it never reads or fills the shared shell.
            if (!draft && !isDataRequest(c)) {
              const streamed = await ppr.stream(pprRequest, () => controls.documentHeaders())
              if (streamed instanceof Response) return streamed
              wholeHoles = streamed
            }
            // Its holes are one visitor's, so no cache may store the page they render into.
            controls.personalize()
          }
          // Every PPR hole runs through the PPR server, so each has admission and its own deadline.
          const holeStates =
            pprRequest === undefined || ppr === undefined
              ? undefined
              : ppr.server.holeStates(
                  pprRequest,
                  !isDataRequest(c)
                    ? wholeHoles
                    : c.req.headers.get(PREFETCH_HEADER) === null
                      ? "deferred"
                      : "omitted",
                  c.req.signal,
                )
          const boundaryBatch =
            boundaryDefinitions.length === 0 || holeStates !== undefined
              ? undefined
              : startDynamicBoundaries(boundaryDefinitions, {
                  request: c.req,
                  params: c.params,
                  api: requestApi,
                  env: c.env,
                  draft,
                  search: effectiveSearch,
                  signal: c.req.signal,
                  live: NO_LIVE,
                } satisfies BoundaryRequestCtx)
          const staticBoundaryPromise =
            boundaryDefinitions.length === 0
              ? undefined
              : resolveStaticBoundaries(
                  boundaryDefinitions,
                  { phase: "build" },
                  options.staticBoundaryCache,
                )
          const pageResult =
            pprRequest !== undefined && ppr !== undefined
              ? // A key with no shell yet must not build one through its data either.
                draft || wholeHoles === "deferred"
                ? pprRequest.loadShell(c.req.signal)
                : ppr.shellData(pprRequest, c.req.signal)
              : mod.loader === undefined || skipPage
                ? null
                : live === undefined
                  ? mod.loader(forkLoaderContext(ctx, { search: effectiveSearch }))
                  : runLiveLoader(
                      live,
                      `P:${route.id}`,
                      mod.loader,
                      forkLoaderContext(ctx, { search: effectiveSearch }),
                    )
          const [pageData, , staticBoundaries] =
            run.pending === undefined && staticBoundaryPromise === undefined
              ? ([await pageResult, undefined, undefined] as const)
              : staticBoundaryPromise === undefined
                ? await Promise.all([pageResult, run.pending])
                : await Promise.all([pageResult, run.pending, staticBoundaryPromise])
          data = pageData
          // A gate on a PPR route runs for its redirect or refusal only. Its data reaches no response,
          // so a soft navigation renders the layouts exactly as the shared shell did.
          layoutData = pprRequest === undefined ? run.layoutData : undefined
          if (componentOwner) {
            for (let i = 0; i < (layoutData?.length ?? 0); i++) {
              const outcome = layoutData?.[i]
              if (isControlFlow(outcome) || isStatusSignal(outcome))
                throw tagLayoutError(outcome, route.layoutIds[i] as string)
            }
          }
          if (componentRequest !== undefined && (isControlFlow(data) || isStatusSignal(data)))
            return componentRuntime!.failure(data)
          if (componentOwner && !isControlFlow(data) && !isStatusSignal(data)) {
            const componentContext = Object.create(c)
            Object.defineProperties(componentContext, Object.getOwnPropertyDescriptors(ctx))
            Object.defineProperties(componentContext, {
              search: {
                configurable: true,
                enumerable: true,
                writable: true,
                value: effectiveSearch,
              },
              signal: {
                configurable: true,
                enumerable: true,
                writable: true,
                value:
                  c.signal === undefined ? c.req.signal : AbortSignal.any([c.signal, c.req.signal]),
              },
              data: { configurable: true, enumerable: true, writable: true, value: data },
              layoutData: {
                configurable: true,
                enumerable: true,
                writable: true,
                value: layoutData ?? [],
              },
            })
            const nonce = options.nonce === undefined ? undefined : await resolveNonce(c.req, c.env)
            if (componentRequest !== undefined && componentRuntime!.progressive !== undefined) {
              componentAnswer = await componentRuntime!.progressive(
                route.id,
                componentContext,
                componentRequest,
                nonce,
              )
            } else {
              componentState = await componentRuntime!.execute(
                route.id,
                componentContext,
                componentRequest,
                nonce,
              )
            }
          }
          if (holeStates !== undefined) {
            // The static resolver names every boundary, leaving the dynamic ones to the holes.
            boundaryStates = { ...staticBoundaries, ...(await holeStates) }
          } else if (boundaryBatch !== undefined) {
            // Each resolver returns a state for every boundary and marks the other's modes
            // `unresolved`, so a slot takes its state from the resolver of its own mode.
            const streamed = { ...boundaryBatch.initial }
            for (const [name, state] of Object.entries(staticBoundaries ?? {}))
              if (state.mode === "static") streamed[name] = state
            for (const entry of boundaryBatch.pending) {
              const initial = streamed[entry.name]
              if (initial !== undefined)
                streamed[entry.name] = { ...initial, data: defer(entry.promise) }
            }
            boundaryStates = streamed
          } else if (staticBoundaries !== undefined) {
            boundaryStates = staticBoundaries
          }
          // Inside the loader `try`: a header the response cannot carry is a loader error, rendered
          // by the same boundary as one.
          const documentHeaders = controls.documentHeaders() ?? {}
          if (
            componentOwner &&
            (requestHeadersWereRead(c.req) || requestHeadersWereRead(loaderRequest))
          )
            documentHeaders[OWNER_REQUEST_HEADER_DEPENDENCY_HEADER] = "1"
          responseHeaders = documentHeaders
          liveCtx = ctx
        } catch (err) {
          if (componentRequest !== undefined) return componentRuntime!.failure(err)
          return renderRouteFailure(c.req, c.env, route, c.params, err, run, controls.personalized)
        }
        if (componentRequest !== undefined) {
          const answer =
            componentAnswer ??
            (componentState === undefined
              ? undefined
              : componentRuntime!.response(componentState, componentRequest))
          if (answer === undefined) throw new Error("component_contract")
          const headers = new Headers(answer.headers)
          for (const [name, value] of Object.entries(responseHeaders ?? {}))
            if (name !== "cache-control" && name !== "content-type" && name !== "vary")
              headers.set(name, value)
          return new Response(answer.body, { status: answer.status, headers })
        }
        if (isStatusSignal(data)) {
          const nested = await renderRouteNotFound(
            c.req,
            c.env,
            route,
            c.params,
            data,
            run,
            controls.personalized,
          )
          if (nested !== undefined) return nested
        }
        const isData = isDataRequest(c)
        const liveEnvelope =
          live === undefined || (!isData && !seeding) || isStatusSignal(data) || isControlFlow(data)
            ? undefined
            : await liveEnvelopeOf(
                live,
                liveOwners(
                  route,
                  layoutModules,
                  layoutData,
                  layoutRetained,
                  mod,
                  skipPage,
                  liveCtx,
                ),
                holeOwners,
              )
        return handleDataOrDocument(
          c.req,
          isData,
          c.env,
          route,
          c.params,
          mod,
          data,
          layoutData,
          layoutModules ?? (await loadLayoutModules(route)),
          layoutRetained,
          boundaryStates,
          layoutModules === undefined ? undefined : assemblyCacheFor(mod, layoutModules, c.req),
          responseHeaders,
          controls.personalized,
          componentState,
          seeding ? undefined : liveEnvelope,
          seeding && liveEnvelope !== undefined && !("__nifra_deferred" in liveEnvelope)
            ? liveEnvelope
            : undefined,
        )
      }
      return withResponseControls(liveLoadOf === undefined ? page : admitLive(page))
    },

    post: (route) => withResponseControls(actionFor(route)),

    matchRoute: (path) => {
      const matched = matchManifestRoute(path)
      const route = matched === null ? undefined : routeById.get(matched.routeId)
      return route === undefined ? null : { routeId: route.id, layoutIds: route.layoutIds }
    },

    fallback: withResponseControls(async (c, controls) => {
      const match = matchNotFoundScope?.(pathOf(c.req)) ?? null
      const target = match === null ? undefined : notFoundTargets[Number(match.routeId)]
      if (match === null || target === undefined) {
        return renderNotFound(c, controls)
      }
      const params: Record<string, string> = {}
      for (let i = 0; i < target.names.length; i++) {
        params[target.names[i] as string] = match.params[`p${i}`] as string
      }
      const mod = await target.page.load()
      const draft = await draftFlag(c.req)
      if (draft) controls.personalize()
      let run: LayoutRun | undefined
      try {
        const ctx: LoaderContext = {
          params,
          request: c.req,
          req: c.req,
          api: apiFor(c),
          env: c.env,
          draft,
          search: loaderSearch(mod.searchSchema, c.req),
          set: controls.scope(PAGE_SCOPE),
          live: NO_LIVE,
        }
        if (target.route.middlewareIds !== undefined) {
          await runMiddleware(target.route, ctx, controls, c.req)
        }
        run = await runLayoutChain(target.route, ctx, controls)
        await run.pending
      } catch (err) {
        if (isStatusSignal(err)) {
          return renderStatusSignal(
            c.req,
            c.env,
            err,
            controls.personalized,
            leadingLayouts(run, err),
          )
        }
        return renderLoaderFailure(
          target.route,
          c.req,
          c.env,
          params,
          err,
          controls.personalized,
          leadingLayouts(run, err),
        )
      }
      return renderNestedNotFound(
        c.req,
        c.env,
        target.id,
        target.page,
        params,
        run.modules,
        run.layoutData,
        controls.personalized,
      )
    }),
  }
}

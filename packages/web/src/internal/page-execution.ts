import type { ResponseResult } from "@nifrajs/core/server"
import {
  type BoundaryRequestCtx,
  type BoundaryStates,
  boundaryDescriptors,
  resolveStaticBoundaries,
  type StaticBoundaryCache,
  startDynamicBoundaries,
} from "../boundary.ts"
import { type CssLoadingMode, DEFAULT_CSS_LOADING, normalizeCssLoading } from "../css-contract.ts"
import { defer, ndjsonStream, prepareDeferred } from "../deferred.ts"
import { isDraftEnabled } from "../draft.ts"
import type {
  LayoutEntry,
  LoaderContext,
  Manifest,
  Meta,
  MetaArgs,
  RouteEntry,
  RouteModule,
} from "../manifest.ts"
import type { RenderAdapter } from "../render-seam.ts"
import {
  createMatcher,
  DATA_HEADER,
  NAV_FROM_HEADER,
  RETAIN_HEADER,
  REVALIDATE_HEADER,
  STATUS_HEADER,
} from "../router.ts"
import { searchOf, searchOfChain } from "../search.ts"
import { mergeHeads, resolveMeta } from "./head-merge.ts"
import {
  actionResponse,
  EMPTY_RETAIN,
  type HeadersLike,
  isControlFlow,
  isStatusSignal,
  type LoadedLayoutModules,
  layoutErrorId,
  type RenderAssemblyCache,
  type RenderedPage,
  type RevalidateResult,
  renderPageResult,
  STATUS_SIGNAL,
  STATUS_TEXT,
  type StatusSignal,
  scopeParams,
  tagLayoutError,
  withDuplicateInstanceHint,
} from "./render-document.ts"
import { urlPartsFor } from "./request-url.ts"

/** Resolve the CSP nonce for one document request. Return `undefined` to omit nonce attributes. */
export type NonceResolver<Env = unknown> = (ctx: {
  readonly request: Request
  readonly env: Env
}) => string | undefined | Promise<string | undefined>

/** Structural context supplied by the core server to one page route handler. */
export interface PageRouteContext<Env = unknown> {
  readonly params: Record<string, string>
  readonly req: Request
  readonly env: Env
}

export interface PageExecutionOptions<Env = unknown> {
  readonly adapter: RenderAdapter
  readonly manifest: Manifest
  readonly clientEntry: string
  readonly title?: string
  readonly api?: unknown
  readonly draftSecret?: string
  readonly routePreload?: Readonly<Record<string, readonly string[]>>
  readonly styles?: readonly string[]
  readonly routeStyles?: Readonly<Record<string, readonly string[]>>
  readonly cssLoading?: CssLoadingMode
  readonly prerenderedPaths?: readonly string[]
  readonly staticFallbacks?: Readonly<Record<string, "ssr" | "404">>
  readonly staticBoundaryCache?: StaticBoundaryCache
  /** Per-request CSP nonce for framework-owned executable document scripts. */
  readonly nonce?: NonceResolver<Env>
  readonly onLoaderError?: (
    error: unknown,
    ctx: {
      readonly request: Request
      readonly params: Readonly<Record<string, string>>
      readonly route: string
    },
  ) => void
}

type PageResponse = Response | ResponseResult | RenderedPage

export interface PageRequestExecutor<Env = unknown> {
  get(route: RouteEntry): (ctx: PageRouteContext<Env>) => Promise<PageResponse>
  post(route: RouteEntry): (ctx: PageRouteContext<Env>) => Promise<PageResponse>
  notFound(request: Request, env: Env, path?: string): Promise<PageResponse>
}

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
  const { adapter, manifest, clientEntry, api } = options
  const cssLoading = normalizeCssLoading(options.cssLoading ?? DEFAULT_CSS_LOADING)
  const titleOption = options.title === undefined ? {} : { title: options.title }
  const prerenderedSet = new Set(options.prerenderedPaths ?? [])
  const matchManifestRoute = createMatcher(
    manifest.routes.map((route) => ({ routeId: route.id, pattern: route.pattern })),
  )
  const routeById = new Map(manifest.routes.map((route) => [route.id, route]))

  const draftFlag = (req: Request): Promise<boolean> =>
    options.draftSecret === undefined
      ? Promise.resolve(false)
      : isDraftEnabled(req, options.draftSecret)

  const preloadOf = (id: string): { preload?: readonly string[] } => {
    const chunks = options.routePreload?.[id]
    return chunks ? { preload: chunks } : {}
  }

  const resolveNonce = (
    request: Request,
    env: Env,
  ): string | undefined | Promise<string | undefined> =>
    options.nonce === undefined ? undefined : options.nonce({ request, env })

  const stylesOf = (id: string): { styles?: readonly string[]; cssLoading?: CssLoadingMode } => {
    const perRoute = options.routeStyles?.[id]
    const styles = perRoute ?? options.styles
    if (styles === undefined || styles.length === 0) return {}
    return {
      styles,
      ...(cssLoading === "deferred" ? { cssLoading } : {}),
    }
  }

  // Load a route's layout modules once for the current execution. The render path needs each whole
  // module for its component + meta, while the data path also needs loader/gate/boundary declarations.
  const loadLayoutModules = async (route: RouteEntry): Promise<LoadedLayoutModules> => {
    const modules = await Promise.all(
      route.layoutIds.map((id) => (manifest.layouts[id] as LayoutEntry).load()),
    )
    for (let i = 0; i < modules.length; i++) {
      if ((modules[i] as { action?: unknown }).action === undefined) continue
      const id = route.layoutIds[i] as string
      throw new Error(
        `[nifra/web] "${(manifest.layouts[id] as LayoutEntry).file}" exports an \`action\`, but layouts do not run one - only route files do. Move the mutation into the route that submits to it.`,
      )
    }
    return modules
  }

  /** Run layout loaders, awaiting gates before starting the page loader and retaining only safe data. */
  const runLayoutChain = async (
    route: RouteEntry,
    ctx: LoaderContext,
    retain: ReadonlySet<number> = new Set(),
  ): Promise<{
    readonly modules: LoadedLayoutModules
    readonly layoutData: readonly unknown[] | undefined
    readonly retained: readonly number[]
    readonly pending: Promise<unknown>
  }> => {
    const modules = await loadLayoutModules(route)
    if (!modules.some((m) => m.loader !== undefined)) {
      return { modules, layoutData: undefined, retained: [], pending: Promise.resolve() }
    }
    const results: unknown[] = new Array(modules.length).fill(null)
    const retained: number[] = []
    const pending: Array<Promise<void>> = []
    for (let i = 0; i < modules.length; i++) {
      const loader = modules[i]?.loader
      if (loader === undefined) continue
      if (retain.has(i) && modules[i]?.gate !== true) {
        retained.push(i)
        continue
      }
      const scoped: LoaderContext = {
        ...ctx,
        params: scopeParams(ctx.params, route.layoutParams?.[i]),
      }
      if (modules[i]?.gate === true) {
        try {
          results[i] = await loader(scoped)
        } catch (err) {
          throw tagLayoutError(err, route.layoutIds[i] as string)
        }
        continue
      }
      const layoutId = route.layoutIds[i] as string
      const index = i
      pending.push(
        (async () => {
          try {
            results[index] = await loader(scoped)
          } catch (err) {
            throw tagLayoutError(err, layoutId)
          }
        })(),
      )
    }
    return { modules, layoutData: results, retained, pending: Promise.all(pending) }
  }

  /** Run only authorization gates before an action; ordinary layout data runs after a native action. */
  const runLayoutGates = async (
    route: RouteEntry,
    ctx: LoaderContext,
  ): Promise<LoadedLayoutModules> => {
    const modules = await loadLayoutModules(route)
    for (let i = 0; i < modules.length; i++) {
      const mod = modules[i]
      if (mod?.gate !== true || mod.loader === undefined) continue
      try {
        await mod.loader({
          ...ctx,
          params: scopeParams(ctx.params, route.layoutParams?.[i]),
        })
      } catch (err) {
        throw tagLayoutError(err, route.layoutIds[i] as string)
      }
    }
    return modules
  }

  const retainedIndices = (header: string | null): ReadonlySet<number> => {
    if (header === null || header === "") return EMPTY_RETAIN
    const out = new Set<number>()
    for (const part of header.split(",")) {
      if (!/^\d+$/.test(part)) continue
      out.add(Number(part))
    }
    return out
  }

  const validatedRetainedIndices = (
    req: Request,
    route: RouteEntry,
    params: Readonly<Record<string, string>>,
  ): ReadonlySet<number> => {
    if (req.headers.get(DATA_HEADER) === null) return EMPTY_RETAIN
    const requested = retainedIndices(req.headers.get(RETAIN_HEADER))
    const from = req.headers.get(NAV_FROM_HEADER)
    if (requested.size === 0 || from === null) return EMPTY_RETAIN
    let fromPath: string
    try {
      const current = new URL(req.url)
      const source = new URL(from, current)
      if (source.origin !== current.origin) return EMPTY_RETAIN
      fromPath = source.pathname + source.search
    } catch {
      return EMPTY_RETAIN
    }
    const previousMatch = matchManifestRoute(fromPath)
    if (previousMatch === null) return EMPTY_RETAIN
    const previous = routeById.get(previousMatch.routeId)
    if (previous === undefined) return EMPTY_RETAIN
    const valid = new Set<number>()
    for (const index of requested) {
      if (route.layoutIds[index] !== previous.layoutIds[index]) continue
      const owned = route.layoutParams?.[index] ?? []
      const previouslyOwned = previous.layoutParams?.[index] ?? []
      if (
        owned.length !== previouslyOwned.length ||
        owned.some((name, i) => name !== previouslyOwned[i]) ||
        owned.some((name) => params[name] !== previousMatch.params[name])
      ) {
        continue
      }
      valid.add(index)
    }
    return valid
  }

  const loaderSearch = (searchSchema: RouteModule["searchSchema"], request: Request) =>
    searchOf(searchSchema, urlPartsFor(request).search)

  const searchChainOf = (
    layoutMods: LoadedLayoutModules,
    mod: RouteModule,
    request: Request,
  ): Record<string, unknown> =>
    searchOfChain(
      [...layoutMods.map((m) => m.searchSchema), mod.searchSchema],
      urlPartsFor(request).search,
    )

  const resolveChainAndHead = (
    layoutModules: LoadedLayoutModules,
    page: RouteModule,
    metaArgs: MetaArgs,
  ): { chain: unknown[]; head: Meta } => {
    const chain = [...layoutModules.map((m) => m.default), page.default]
    const heads = [
      ...layoutModules.map((m) => resolveMeta(m.meta, metaArgs)),
      resolveMeta(page.meta, metaArgs),
    ]
    return { chain, head: mergeHeads(heads) }
  }

  const dirOfId = (id: string, suffix: string): string =>
    id === suffix ? "" : id.slice(0, id.length - suffix.length - 1)

  const boundaryFor = (route: RouteEntry, err: unknown): string | undefined => {
    const ids = route.errorIds ?? []
    const failing = layoutErrorId(err)
    if (failing === undefined) return ids.at(-1)
    const layoutDir = dirOfId(failing, "_layout")
    for (let i = ids.length - 1; i >= 0; i--) {
      const errDir = dirOfId(ids[i] as string, "_error")
      if (errDir === "" || errDir === layoutDir || layoutDir.startsWith(`${errDir}/`)) return ids[i]
    }
    return undefined
  }

  const originOf = (req: Request): string => {
    try {
      return new URL(req.url).origin
    } catch {
      return ""
    }
  }

  const pathOf = (req: Request): string => {
    try {
      const parts = urlPartsFor(req)
      return parts.pathname + parts.search
    } catch {
      return "/"
    }
  }

  const renderError = async (
    route: RouteEntry,
    errorId: string,
    err: unknown,
    nonce?: string,
  ): Promise<PageResponse> => {
    const errDir = dirOfId(errorId, "_error")
    const keptLayoutIds = route.layoutIds.filter((id) => {
      const ld = dirOfId(id, "_layout")
      return ld === "" || ld === errDir || errDir.startsWith(`${ld}/`)
    })
    const layouts = await Promise.all(
      keptLayoutIds.map((id) =>
        (manifest.layouts[id] as LayoutEntry).load().then((m) => m.default),
      ),
    )
    const { default: errComp } = await (manifest.errors?.[errorId] as LayoutEntry).load()
    const e = err instanceof Error ? err : new Error(String(err))
    return renderPageResult({
      adapter,
      chain: [...layouts, errComp],
      data: { name: e.name, message: e.message },
      clientEntry,
      routeId: errorId,
      status: 500,
      hydrate: false,
      ...(nonce === undefined ? {} : { nonce }),
      ...titleOption,
    })
  }

  const renderTerminalStatus = async (
    status: number,
    path?: string,
    extraHeaders?: HeadersLike,
    nonce?: string,
  ): Promise<PageResponse> => {
    const page = manifest.statusPages?.[String(status)] ?? manifest.notFound
    if (page === undefined) {
      const headers = new Headers(extraHeaders)
      headers.set("content-type", "text/plain; charset=utf-8")
      return new Response(STATUS_TEXT[status] ?? "Error", { status, headers })
    }
    const routeId = manifest.statusPages?.[String(status)] !== undefined ? `_${status}` : "_404"
    const loaded = (await page.load()) as {
      readonly default: unknown
      readonly searchSchema?: RouteModule["searchSchema"]
    }
    return renderPageResult({
      adapter,
      chain: [loaded.default],
      data: null,
      clientEntry,
      routeId,
      ...(path !== undefined
        ? {
            search: searchOf(
              loaded.searchSchema,
              path.includes("?") ? path.slice(path.indexOf("?")) : "",
            ),
          }
        : {}),
      ...(path !== undefined ? { path } : {}),
      status,
      ...(extraHeaders !== undefined ? { headers: extraHeaders } : {}),
      ...(nonce === undefined ? {} : { nonce }),
      ...preloadOf(routeId),
      ...stylesOf(routeId),
      prerenderedPaths: options.prerenderedPaths ?? [],
      ...titleOption,
    })
  }

  const renderStatusSignal = async (
    req: Request,
    env: Env,
    signal: StatusSignal,
  ): Promise<PageResponse> => {
    const { status, headers } = signal[STATUS_SIGNAL]
    if (req.headers.get(DATA_HEADER) !== null) {
      const responseHeaders = new Headers(headers)
      responseHeaders.set(STATUS_HEADER, String(status))
      return new Response(null, { status, headers: responseHeaders })
    }
    return renderTerminalStatus(status, pathOf(req), headers, await resolveNonce(req, env))
  }

  const reportLoaderError = (
    route: RouteEntry,
    req: Request,
    params: Record<string, string>,
    err: unknown,
  ): void => {
    if (options.onLoaderError === undefined) return
    try {
      options.onLoaderError(err, { request: req, params, route: route.pattern })
    } catch {
      // A faulty reporter must never break error rendering.
    }
  }

  const handleDataOrDocument = async (
    req: Request,
    env: Env,
    route: RouteEntry,
    params: Readonly<Record<string, string>>,
    mod: RouteModule,
    data: unknown,
    layoutData: readonly unknown[] | undefined,
    layoutModules: LoadedLayoutModules,
    layoutRetained: readonly number[],
    boundaryStates: BoundaryStates | undefined,
    assemblyCache: RenderAssemblyCache | undefined,
  ): Promise<PageResponse> => {
    if (isStatusSignal(data)) return renderStatusSignal(req, env, data)
    if (isControlFlow(data)) return data
    if (req.headers.get(DATA_HEADER) !== null) {
      const pageSplit = prepareDeferred(data)
      const layoutSplits: Array<ReturnType<typeof prepareDeferred>> = []
      let offset = pageSplit.deferred.length
      for (const entry of layoutData ?? []) {
        const split = prepareDeferred(entry, offset)
        layoutSplits.push(split)
        offset += split.deferred.length
      }
      const deferred = [...pageSplit.deferred, ...layoutSplits.flatMap((split) => split.deferred)]
      const boundarySplit =
        boundaryStates === undefined ? undefined : prepareDeferred(boundaryStates, deferred.length)
      const allDeferred = [
        ...deferred,
        ...(boundarySplit === undefined ? [] : boundarySplit.deferred),
      ]
      const payload =
        layoutData === undefined && boundarySplit === undefined
          ? pageSplit.forClient
          : {
              v: 1 as const,
              data: pageSplit.forClient,
              layoutData: layoutSplits.map((split) => split.forClient),
              retained: layoutRetained,
              ...(boundarySplit === undefined ? {} : { boundaries: boundarySplit.forClient }),
            }
      if (allDeferred.length === 0) return Response.json(payload ?? null)
      return new Response(ndjsonStream(payload, allDeferred), {
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      })
    }

    const { chain, head } = resolveChainAndHead(layoutModules, mod, {
      data,
      params,
      origin: originOf(req),
    })
    const nonce = options.nonce === undefined ? undefined : await resolveNonce(req, env)
    try {
      return await renderPageResult({
        adapter,
        chain,
        data,
        head,
        clientEntry,
        routeId: route.id,
        params,
        path: pathOf(req),
        search: searchChainOf(layoutModules, mod, req),
        hydrate: mod.hydrate !== false,
        ...(layoutData !== undefined ? { layoutData } : {}),
        ...(boundaryStates !== undefined ? { boundaries: boundaryStates } : {}),
        ...preloadOf(route.id),
        ...stylesOf(route.id),
        prerenderedPaths: options.prerenderedPaths ?? [],
        ...(mod.revalidate !== undefined ? { revalidate: mod.revalidate } : {}),
        ...(mod.revalidateTags !== undefined ? { revalidateTags: mod.revalidateTags } : {}),
        ...(mod.islandScripts !== undefined ? { islandScripts: mod.islandScripts } : {}),
        ...(nonce === undefined ? {} : { nonce }),
        ...titleOption,
        ...(assemblyCache === undefined ? {} : { assemblyCache }),
      })
    } catch (err) {
      if (isStatusSignal(err)) return renderStatusSignal(req, env, err)
      if (isControlFlow(err)) throw err
      reportLoaderError(route, req, { ...params }, err)
      const errorId = boundaryFor(route, err)
      if (errorId === undefined) throw err
      return renderError(route, errorId, withDuplicateInstanceHint(err), nonce)
    }
  }

  const renderNotFound = async (
    request: Request,
    env: Env,
    path?: string,
  ): Promise<PageResponse> => {
    const page = manifest.statusPages?.["404"] ?? manifest.notFound
    if (page === undefined) return renderTerminalStatus(404, path)
    return renderTerminalStatus(
      404,
      path,
      undefined,
      options.nonce === undefined ? undefined : await resolveNonce(request, env),
    )
  }

  return {
    get: (route) => {
      const is404Fallback = options.staticFallbacks?.[route.pattern] === "404"
      let assemblySlot: RenderAssemblyCache | undefined
      let assemblySlotMod: unknown
      let assemblySlotLayouts: LoadedLayoutModules | undefined
      const assemblyCacheFor = (
        mod: RouteModule,
        layouts: LoadedLayoutModules,
      ): RenderAssemblyCache | undefined => {
        if (typeof mod.meta === "function") return undefined
        for (const layout of layouts) if (typeof layout.meta === "function") return undefined
        const layoutsUnchanged =
          assemblySlotLayouts !== undefined &&
          assemblySlotLayouts.length === layouts.length &&
          assemblySlotLayouts.every((layout, index) => layout === layouts[index])
        if (assemblySlotMod !== mod || !layoutsUnchanged) {
          assemblySlot = {}
          assemblySlotMod = mod
          assemblySlotLayouts = layouts
        }
        return assemblySlot
      }

      return async (c: PageRouteContext<Env>) => {
        if (is404Fallback && !prerenderedSet.has(urlPartsFor(c.req).pathname)) {
          return renderNotFound(c.req, c.env, pathOf(c.req))
        }
        const mod = await route.load()
        const draft = await draftFlag(c.req)
        let data: unknown
        let layoutData: readonly unknown[] | undefined
        let boundaryStates: BoundaryStates | undefined
        let layoutModules: LoadedLayoutModules | undefined
        let layoutRetained: readonly number[] = []
        try {
          const ctx: LoaderContext = {
            params: c.params,
            request: c.req,
            req: c.req,
            api,
            env: c.env,
            draft,
            search: loaderSearch(mod.searchSchema, c.req),
          }
          const run = await runLayoutChain(
            route,
            ctx,
            validatedRetainedIndices(c.req, route, c.params),
          )
          layoutModules = run.modules
          layoutRetained = run.retained
          const boundaryDefinitions = [
            ...run.modules.flatMap((layout) => layout.boundaries ?? []),
            ...(mod.boundaries ?? []),
          ]
          if (boundaryDefinitions.length > 0) boundaryDescriptors(boundaryDefinitions)
          const effectiveSearch = searchChainOf(run.modules, mod, c.req)
          const boundaryBatch =
            boundaryDefinitions.length === 0
              ? undefined
              : startDynamicBoundaries(boundaryDefinitions, {
                  request: c.req,
                  params: c.params,
                  api,
                  env: c.env,
                  draft,
                  search: effectiveSearch,
                  signal: c.req.signal,
                } satisfies BoundaryRequestCtx)
          const staticBoundaryPromise =
            boundaryDefinitions.length === 0
              ? Promise.resolve(undefined)
              : resolveStaticBoundaries(
                  boundaryDefinitions,
                  { phase: "build", origin: originOf(c.req) },
                  options.staticBoundaryCache,
                )
          const [pageData, , staticBoundaries] = await Promise.all([
            mod.loader ? mod.loader({ ...ctx, search: effectiveSearch }) : null,
            run.pending,
            staticBoundaryPromise,
          ])
          data = pageData
          layoutData = run.layoutData
          if (boundaryBatch !== undefined) {
            const streamed = { ...boundaryBatch.initial, ...(staticBoundaries ?? {}) }
            for (const entry of boundaryBatch.pending) {
              const initial = streamed[entry.name]
              if (initial !== undefined)
                streamed[entry.name] = { ...initial, data: defer(entry.promise) }
            }
            boundaryStates = streamed
          } else if (staticBoundaries !== undefined) {
            boundaryStates = staticBoundaries
          }
        } catch (err) {
          if (isStatusSignal(err)) return renderStatusSignal(c.req, c.env, err)
          if (isControlFlow(err)) throw err
          reportLoaderError(route, c.req, c.params, err)
          const errorId = boundaryFor(route, err)
          if (errorId === undefined) throw err
          if (c.req.headers.get(DATA_HEADER) !== null) {
            return new Response("Internal Server Error", {
              status: 500,
              headers: { "content-type": "text/plain; charset=utf-8" },
            })
          }
          return renderError(
            route,
            errorId,
            withDuplicateInstanceHint(err),
            options.nonce === undefined ? undefined : await resolveNonce(c.req, c.env),
          )
        }
        return handleDataOrDocument(
          c.req,
          c.env,
          route,
          c.params,
          mod,
          data,
          layoutData,
          layoutModules ?? (await loadLayoutModules(route)),
          layoutRetained,
          boundaryStates,
          layoutModules === undefined ? undefined : assemblyCacheFor(mod, layoutModules),
        )
      }
    },

    post: (route) => async (c) => {
      const mod = await route.load()
      const draft = await draftFlag(c.req)
      if (mod.action === undefined) {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
        })
      }
      const actionContext: LoaderContext = {
        params: c.params,
        request: c.req,
        req: c.req,
        api,
        env: c.env,
        draft,
        search: loaderSearch(mod.searchSchema, c.req),
      }
      const isDataRequest = c.req.headers.get(DATA_HEADER) !== null
      let layoutModules: LoadedLayoutModules
      let result: unknown
      try {
        layoutModules = await runLayoutGates(route, actionContext)
        result = await mod.action(actionContext)
      } catch (err) {
        if (isControlFlow(err)) return actionResponse(err, isDataRequest)
        throw err
      }
      const isRevalidate =
        result !== null && typeof result === "object" && "__nifraRevalidate" in result
      const actionResult = isRevalidate ? (result as RevalidateResult<unknown>).data : result
      const revalidateHeader: Record<string, string> = isRevalidate
        ? { [REVALIDATE_HEADER]: (result as RevalidateResult<unknown>).__nifraRevalidate.join(",") }
        : {}
      if (isControlFlow(actionResult)) return actionResponse(actionResult, isDataRequest)
      if (isDataRequest) {
        const { forClient, deferred } = prepareDeferred(actionResult)
        if (deferred.length === 0)
          return Response.json(actionResult ?? null, { headers: revalidateHeader })
        return new Response(ndjsonStream(forClient, deferred), {
          headers: { "content-type": "application/x-ndjson; charset=utf-8", ...revalidateHeader },
        })
      }
      const search = searchChainOf(layoutModules, mod, c.req)
      const data = mod.loader
        ? await mod.loader({
            params: c.params,
            request: c.req,
            req: c.req,
            api,
            env: c.env,
            draft,
            search,
          })
        : null
      const { chain, head } = resolveChainAndHead(layoutModules, mod, {
        data,
        params: c.params,
        origin: originOf(c.req),
      })
      const nonce = options.nonce === undefined ? undefined : await resolveNonce(c.req, c.env)
      return renderPageResult({
        adapter,
        chain,
        data,
        actionData: actionResult,
        head,
        clientEntry,
        routeId: route.id,
        params: c.params,
        path: pathOf(c.req),
        search,
        hydrate: mod.hydrate !== false,
        ...preloadOf(route.id),
        ...stylesOf(route.id),
        prerenderedPaths: options.prerenderedPaths ?? [],
        ...(nonce === undefined ? {} : { nonce }),
        ...titleOption,
      })
    },

    notFound: renderNotFound,
  }
}

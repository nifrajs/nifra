import {
  type BoundaryRegistration,
  type BoundaryStates,
  resolveStaticBoundaries,
  type ShellCtx,
} from "../boundary.ts"
import { type Deferred, ndjsonStream, prepareDeferred } from "../deferred.ts"
import { routeTags } from "../isr.ts"
import type { RouteEntry, RouteModule } from "../manifest.ts"
import { searchOfChain } from "../search.ts"
import type { LiveEnvelope } from "./live-contract.ts"
import type { ExecutionBase } from "./page-execution-base.ts"
import {
  boundaryFor,
  matchChainOf,
  pathOf,
  resolveChainAndHead,
  searchChainOf,
  serverLeafOf,
  settledLayouts,
} from "./page-execution-helpers.ts"
import {
  type DocumentInput,
  type LayoutChainSource,
  type PageResponse,
  type PageRouteContext,
  swapSlotOf,
} from "./page-execution-shared.ts"
import type { StatusRenderer } from "./page-status.ts"
import { isHole, type PprRequest } from "./ppr/contract.ts"
import {
  isControlFlow,
  type LoadedLayoutModules,
  type RenderAssemblyCache,
  renderPageResult,
  withDuplicateInstanceHint,
} from "./render-document.ts"
import { originFor, urlPartsFor } from "./request-url.ts"
import { DATA_RESPONSE_HEADERS } from "./response-controls.ts"
import { isStatusSignal } from "./status-page.ts"

export function createDocumentRenderer<Env = unknown>(
  base: ExecutionBase<Env>,
  status: StatusRenderer<Env>,
  progressiveActionData: WeakMap<Request, unknown>,
) {
  const { options } = base
  const {
    adapter,
    clientEntry,
    api,
    appDocumentOptions,
    i18n,
    localeFor,
    localeOption,
    keepTable,
    slotsFor,
    preloadOf,
    resolveNonce,
    stylesOf,
    deferredLogOf,
  } = base
  const { renderError, renderStatusSignal, reportLoaderError } = status

  const handleDataOrDocument = async (
    req: Request,
    isData: boolean,
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
    responseHeaders: Record<string, string> | undefined,
    personalized: boolean,
    serverComponents?: import("../server-components/types.ts").ComponentState,
    live?: LiveEnvelope | Deferred<LiveEnvelope>,
    liveSeed?: LiveEnvelope,
  ): Promise<PageResponse> => {
    // Every layout loader settled before the page rendered, so a status or error page can reuse them.
    const settled: LayoutChainSource = async (_page, count) =>
      settledLayouts(layoutModules, layoutData, count)
    if (isStatusSignal(data)) return renderStatusSignal(req, env, data, personalized, settled)
    if (isControlFlow(data)) return data
    if (isData) {
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
      // Deferred when holes run: their owners are known only once the last one settles.
      const liveSplit = live === undefined ? undefined : prepareDeferred(live, allDeferred.length)
      if (liveSplit !== undefined) allDeferred.push(...liveSplit.deferred)
      const payload =
        layoutData === undefined &&
        boundarySplit === undefined &&
        serverComponents === undefined &&
        live === undefined
          ? pageSplit.forClient
          : {
              v: 1 as const,
              data: pageSplit.forClient,
              layoutData: layoutSplits.map((split) => split.forClient),
              retained: layoutRetained,
              ...(boundarySplit === undefined ? {} : { boundaries: boundarySplit.forClient }),
              ...(serverComponents === undefined ? {} : { serverComponents }),
              ...(liveSplit === undefined ? {} : { live: liveSplit.forClient }),
            }
      if (allDeferred.length === 0) {
        return Response.json(payload ?? null, { headers: DATA_RESPONSE_HEADERS })
      }
      return new Response(
        ndjsonStream(payload, allDeferred, undefined, req.signal, deferredLogOf(req)),
        {
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            ...DATA_RESPONSE_HEADERS,
          },
        },
      )
    }

    const nonce = options.nonce === undefined ? undefined : await resolveNonce(req, env)
    const { chain, head } = resolveChainAndHead(
      layoutModules,
      layoutData,
      mod,
      {
        data,
        pageData: data,
        params,
        origin: originFor(req),
        ...(nonce === undefined ? {} : { nonce }),
      },
      serverLeafOf(route, mod),
    )
    try {
      // Optional fields are assigned, not spread in: a conditional spread per field cost every
      // document request about 1us on Bun.
      const page: DocumentInput = {
        adapter,
        chain,
        data,
        head,
        clientEntry,
        routeId: route.id,
        params,
        path: pathOf(req),
        search: searchChainOf(layoutModules, mod, req),
        matchChain: matchChainOf(route.layoutIds, layoutModules, route.id, mod),
        hydrate: mod.hydrate !== false,
        signal: req.signal,
        logError: deferredLogOf(req),
        ...preloadOf(route.id),
        ...stylesOf(route.id),
        ...appDocumentOptions,
        ...localeOption(req),
      }
      if (serverComponents !== undefined) page.serverComponents = serverComponents
      if (liveSeed?.grant !== undefined) page.live = liveSeed
      if (progressiveActionData.has(req)) page.actionData = progressiveActionData.get(req)
      const swapSlot = swapSlotOf(req)
      if (swapSlot !== undefined) page.swapSlot = swapSlot
      if (keepTable !== undefined) Object.assign(page, slotsFor(route.layoutIds, route.id))
      if (layoutData !== undefined) page.layoutData = layoutData
      if (boundaryStates !== undefined) page.boundaries = boundaryStates
      if (responseHeaders !== undefined) page.headers = responseHeaders
      // A response that sets a cookie is one visitor's: it never advertises ISR freshness.
      if (!personalized && options.cacheChannel?.enabled === true) {
        if (mod.revalidate !== undefined) page.revalidate = mod.revalidate
        if (mod.revalidateTags !== undefined) {
          page.revalidateTags = routeTags(
            mod.revalidateTags,
            { params, url: new URL(req.url) },
            route.id,
          )
        }
      }
      if (mod.islandScripts !== undefined) page.islandScripts = mod.islandScripts
      if (nonce !== undefined) page.nonce = nonce
      if (assemblyCache !== undefined) page.assemblyCache = assemblyCache
      return await renderPageResult(page)
    } catch (err) {
      if (isStatusSignal(err)) return renderStatusSignal(req, env, err, personalized, settled)
      if (isControlFlow(err)) throw err
      reportLoaderError(route, req, { ...params }, err)
      const errorId = boundaryFor(route, err)
      if (errorId === undefined) throw err
      options.logBoundaryError?.(err, req)
      return renderError(
        req,
        route,
        errorId,
        withDuplicateInstanceHint(err),
        personalized,
        nonce,
        settled,
      )
    }
  }

  const pprRequestFor = (
    c: PageRouteContext<Env>,
    route: RouteEntry,
    mod: RouteModule,
    layouts: LoadedLayoutModules,
    boundaries: readonly BoundaryRegistration[],
    shellLoader: NonNullable<RouteModule["shellLoader"]>,
    requestApi: unknown,
    draft: boolean,
    search: Record<string, unknown>,
  ): PprRequest => {
    const path = urlPartsFor(c.req).pathname
    const locale = i18n?.localeOf(path)
    const params = c.params
    const shellOrigin = options.ppr?.origin
    const variations =
      options.ppr?.variationsOf(mod.shellVariations, urlPartsFor(c.req).search) ?? {}
    const shellSearch = options.ppr?.variationQuery(variations) ?? ""
    // What a shared entry's tags read: its key's parts, never the Host or an undeclared query, which
    // the first visitor of a key could set so a later purge misses the entry.
    const shellUrl = (): URL => {
      const url = new URL(shellOrigin ?? "http://shell.invalid")
      url.pathname = path
      url.search = shellSearch
      return url
    }
    // The unbound `api`: a shell is built for every visitor, so no visitor's platform reaches it.
    const shellContext: Omit<ShellCtx, "signal"> =
      shellOrigin === undefined
        ? { phase: "shell", params, locale, variations, api }
        : { phase: "shell", params, locale, variations, api, origin: shellOrigin }
    return {
      routeId: route.id,
      path,
      locale,
      variations,
      request: c.req,
      holes: boundaries.filter(isHole),
      holeContext: { request: c.req, params, api: requestApi, env: c.env, draft, search },
      shellContext,
      revalidate: mod.revalidate,
      waitUntil: c.waitUntil,
      tags: () =>
        mod.revalidateTags === undefined
          ? []
          : routeTags(mod.revalidateTags, { params, url: shellUrl() }, route.id),
      holeTags: (hole) =>
        hole.revalidateTags === undefined
          ? []
          : routeTags(hole.revalidateTags, { params, url: shellUrl() }, `${route.id}#${hole.name}`),
      loadShell: async (signal) => shellLoader({ ...shellContext, signal }),
      renderShellDocument: async (shellData, states) => {
        // Static and intercepting boundaries both need a state in the document; a hole's comes from `states`.
        const statics = boundaries.some((boundary) => !isHole(boundary))
          ? await resolveStaticBoundaries(
              boundaries,
              { phase: "build" },
              options.staticBoundaryCache,
            )
          : undefined
        const { chain, head } = resolveChainAndHead(
          layouts,
          undefined,
          mod,
          // A Host header is the client's to choose, so a shared shell's meta gets the configured one.
          { data: shellData, pageData: shellData, params, origin: shellOrigin ?? "" },
          serverLeafOf(route, mod),
        )
        // Nothing here reads the request beyond its pathname: no origin, search, nonce or headers.
        const page: DocumentInput = {
          adapter,
          chain,
          data: shellData,
          head,
          clientEntry,
          routeId: route.id,
          params,
          path,
          search: searchOfChain(
            [...layouts.map((m) => m.searchSchema), mod.searchSchema],
            shellSearch === "" ? "" : `?${shellSearch}`,
          ),
          matchChain: matchChainOf(route.layoutIds, layouts, route.id, mod),
          hydrate: mod.hydrate !== false,
          boundaries: { ...statics, ...states },
          ...preloadOf(route.id),
          ...stylesOf(route.id),
          ...appDocumentOptions,
          ...(locale === undefined ? {} : localeFor(locale)),
          ...slotsFor(route.layoutIds, route.id),
        }
        if (mod.islandScripts !== undefined) page.islandScripts = mod.islandScripts
        const result = await renderPageResult(page)
        // A buffered page hands over its string: a Response round trip to read it back cost more.
        const rendered = result.toNodeBody?.() ?? result.toResponse()
        if (rendered.status !== 200) {
          throw new Error(
            `[nifra/web] ppr: the shell of "${route.id}" rendered status ${rendered.status}`,
          )
        }
        if (rendered instanceof Response) return rendered.text()
        return typeof rendered.body === "string"
          ? rendered.body
          : new TextDecoder().decode(rendered.body)
      },
    }
  }

  return { handleDataOrDocument, pprRequestFor }
}

export type DocumentRenderer<Env = unknown> = ReturnType<typeof createDocumentRenderer<Env>>

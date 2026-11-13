import type { LayoutEntry, LoaderContext, Meta, NotFoundEntry, RouteEntry } from "../manifest.ts"
import { DATA_HEADER, STATUS_HEADER } from "../router.ts"
import type { ExecutionBase } from "./page-execution-base.ts"
import {
  boundaryFor,
  dirOfId,
  leadingLayouts,
  loaderSearch,
  matchChainOf,
  pathOf,
  resolveChainAndHead,
  searchChainOf,
  settledLayouts,
  statusMetaArgs,
} from "./page-execution-helpers.ts"
import {
  type LayoutChain,
  type LayoutChainSource,
  type LayoutRun,
  NO_LIVE,
  type PageResponse,
  type PageRouteContext,
} from "./page-execution-shared.ts"
import type { LayoutRunner } from "./page-layouts.ts"
import {
  isControlFlow,
  type LoadedLayoutModules,
  layoutErrorId,
  renderPageResult,
  STATUS_TEXT,
  withDuplicateInstanceHint,
} from "./render-document.ts"
import { originFor } from "./request-url.ts"
import {
  PAGE_SCOPE,
  type PageResponseControls,
  PRIVATE_NO_STORE,
  PRIVATE_PAGE_HEADERS,
  varyOnDataHeader,
} from "./response-controls.ts"
import {
  type HeadersLike,
  isStatusSignal,
  STATUS_SIGNAL,
  type StatusSignal,
} from "./status-page.ts"

export function createStatusRenderer<Env = unknown>(
  base: ExecutionBase<Env>,
  layouts: LayoutRunner<Env>,
) {
  const {
    adapter,
    manifest,
    clientEntry,
    options,
    apiFor,
    titleOption,
    cspOption,
    prerenderedHandover,
    copyOption,
    localeOption,
    draftFlag,
    slotsFor,
    preloadOf,
    resolveNonce,
    stylesFrom,
    stylesOf,
    deferredLogOf,
  } = base
  const { runLayoutChain, runMiddleware } = layouts
  const renderError = async (
    req: Request,
    route: RouteEntry,
    errorId: string,
    err: unknown,
    personalized: boolean,
    nonce?: string,
    layouts?: LayoutChainSource,
  ): Promise<PageResponse> => {
    const errDir = dirOfId(errorId, "_error")
    const keptLayoutIds = route.layoutIds.filter((id) => {
      const ld = dirOfId(id, "_layout")
      return ld === "" || ld === errDir || errDir.startsWith(`${ld}/`)
    })
    const errorEntry = manifest.errors?.[errorId]
    if (errorEntry === undefined) throw new Error(`nifra: no error module for "${errorId}"`)
    const errorModule = await errorEntry.load()
    const e = err instanceof Error ? err : new Error(String(err))
    // An error's text can carry a connection string or a query, so only a run that says it is
    // development or test shows it; an unset NODE_ENV (an unbuilt `bun app.ts`) counts as production.
    const nodeEnv = typeof process === "undefined" ? undefined : process.env.NODE_ENV
    const data =
      nodeEnv === "development" || nodeEnv === "test"
        ? { name: e.name, message: e.message }
        : { name: "Error", message: "Internal Server Error" }
    const inLayouts = errorModule.inLayouts !== false
    const chain =
      inLayouts && layouts !== undefined && keptLayoutIds.length > 0
        ? await layouts(errorModule, keptLayoutIds.length)
        : undefined
    const render = (components: unknown[], wrapped?: { head: Meta; chain: LayoutChain }) => {
      const layoutData = wrapped?.chain.layoutData
      return renderPageResult({
        adapter,
        chain: components,
        data,
        ...(wrapped === undefined ? {} : { head: wrapped.head }),
        ...localeOption(req),
        clientEntry,
        routeId: errorId,
        status: 500,
        hydrate: false,
        signal: req.signal,
        logError: deferredLogOf(req),
        ...(layoutData === undefined ? {} : { layoutData }),
        ...(personalized || layoutData !== undefined ? { headers: PRIVATE_PAGE_HEADERS } : {}),
        ...(nonce === undefined ? {} : { nonce }),
        ...cspOption,
        ...titleOption,
      })
    }
    if (chain !== undefined) {
      try {
        const resolved = resolveChainAndHead(
          chain.modules,
          chain.layoutData,
          errorModule,
          statusMetaArgs(req, data, nonce),
        )
        return await render(resolved.chain, { head: resolved.head, chain })
      } catch {
        // A layout whose meta or render fails leaves the error page alone, never a second error.
        return render([errorModule.default])
      }
    }
    // Layouts whose data did not settle still frame the error page, without their data.
    const layoutComponents = await Promise.all(
      keptLayoutIds.map((id) =>
        (manifest.layouts[id] as LayoutEntry).load().then((m) => m.default),
      ),
    )
    return render([...layoutComponents, errorModule.default])
  }

  const rootLayoutIds: readonly string[] = manifest.layouts._layout === undefined ? [] : ["_layout"]
  const rootMiddlewareIds: readonly string[] =
    manifest.middlewares?._middleware === undefined ? [] : ["_middleware"]
  /**
   * Run the root middleware and layouts for a request no route ran them for (an unmatched URL), as a
   * nested `_404` runs its own. Any refusal or failure renders the page alone.
   */
  const rootLayoutsFor =
    (c: PageRouteContext<Env>, controls: PageResponseControls): LayoutChainSource =>
    async (page) => {
      const entry = manifest.statusPages?.["404"] ?? manifest.notFound
      if (rootLayoutIds.length === 0 || entry === undefined) return undefined
      const layoutsOnly: RouteEntry = {
        id: "_404",
        pattern: "/*",
        layoutIds: rootLayoutIds,
        errorIds: [],
        file: entry.file,
        load: entry.load,
      }
      const route: RouteEntry =
        rootMiddlewareIds.length === 0
          ? layoutsOnly
          : { ...layoutsOnly, middlewareIds: rootMiddlewareIds }
      try {
        const draft = await draftFlag(c.req)
        if (draft) controls.personalize()
        const ctx: LoaderContext = {
          params: {},
          request: c.req,
          req: c.req,
          api: apiFor(c),
          env: c.env,
          draft,
          search: loaderSearch(page.searchSchema, c.req),
          set: controls.scope(PAGE_SCOPE),
          live: NO_LIVE,
        }
        if (route.middlewareIds !== undefined) await runMiddleware(route, ctx, controls, c.req)
        const run = await runLayoutChain(route, ctx, controls)
        await run.pending
        return settledLayouts(run.modules, run.layoutData, rootLayoutIds.length)
      } catch {
        return undefined
      }
    }

  const renderTerminalStatus = async (
    status: number,
    req: Request,
    extraHeaders?: HeadersLike,
    nonce?: string,
    layouts?: LayoutChainSource,
  ): Promise<PageResponse> => {
    const page = manifest.statusPages?.[String(status)] ?? manifest.notFound
    if (page === undefined) {
      const headers = new Headers(extraHeaders)
      headers.set("content-type", "text/plain; charset=utf-8")
      return new Response(STATUS_TEXT[status] ?? "Error", { status, headers })
    }
    const routeId = manifest.statusPages?.[String(status)] !== undefined ? `_${status}` : "_404"
    const loaded = await page.load()
    const wraps = loaded.inLayouts !== false && rootLayoutIds.length > 0
    const chain =
      wraps && layouts !== undefined ? await layouts(loaded, rootLayoutIds.length) : undefined
    const modules = chain?.modules ?? []
    const layoutIds = chain === undefined ? [] : rootLayoutIds
    const layoutData = chain?.layoutData
    let resolved: ReturnType<typeof resolveChainAndHead>
    try {
      resolved = resolveChainAndHead(modules, layoutData, loaded, statusMetaArgs(req, null, nonce))
    } catch (err) {
      // A layout whose meta throws leaves the status page alone, never a second error.
      if (chain === undefined) throw err
      return renderTerminalStatus(status, req, extraHeaders, nonce)
    }
    const { chain: components, head } = resolved
    let headers = extraHeaders
    if (layoutData !== undefined) {
      // The page now shows what a layout loaded for this visitor.
      const privateHeaders = new Headers(extraHeaders)
      privateHeaders.set("cache-control", PRIVATE_NO_STORE)
      headers = privateHeaders
    }
    const statusPage = {
      adapter,
      chain: components,
      data: null,
      head,
      clientEntry,
      routeId,
      matchChain: matchChainOf(layoutIds, modules, routeId, loaded),
      search: searchChainOf(modules, loaded, req),
      path: pathOf(req),
      status,
      signal: req.signal,
      logError: deferredLogOf(req),
      // The browser renders this page inside the root layout, so a page that had to render alone
      // stays server-only, as a nested `_404` does.
      ...(wraps && chain === undefined ? { hydrate: false } : {}),
      ...(layoutData === undefined ? {} : { layoutData }),
      ...(headers !== undefined ? { headers } : {}),
      ...(nonce === undefined ? {} : { nonce }),
      ...cspOption,
      ...preloadOf(routeId),
      // The build keys stylesheets by route, so a page inside the root layout links the whole-app one.
      ...(chain === undefined ? stylesOf(routeId) : stylesFrom(options.styles)),
      ...prerenderedHandover,
      ...copyOption,
      ...localeOption(req),
      ...titleOption,
      ...slotsFor(layoutIds, routeId),
    }
    if (chain === undefined) return renderPageResult(statusPage)
    try {
      return await renderPageResult(statusPage)
    } catch {
      // A layout that fails to render leaves the status page alone, never a second error.
      return renderTerminalStatus(status, req, extraHeaders, nonce)
    }
  }

  const renderStatusSignal = async (
    req: Request,
    env: Env,
    signal: StatusSignal,
    personalized: boolean,
    layouts?: LayoutChainSource,
  ): Promise<PageResponse> => {
    const { status, headers } = signal[STATUS_SIGNAL]
    if (req.headers.get(DATA_HEADER) !== null) {
      // Same URL as the status page, so it is never storable: a cache keyed on the URL alone would
      // otherwise answer a document request with this empty body.
      const responseHeaders = new Headers(headers)
      responseHeaders.set(STATUS_HEADER, String(status))
      responseHeaders.set("cache-control", PRIVATE_NO_STORE)
      responseHeaders.set("vary", varyOnDataHeader(responseHeaders.get("vary")))
      return new Response(null, { status, headers: responseHeaders })
    }
    const nonce = await resolveNonce(req, env)
    if (headers === undefined && !personalized) {
      return renderTerminalStatus(status, req, undefined, nonce, layouts)
    }
    const documentHeaders = new Headers(headers)
    if (headers !== undefined) {
      documentHeaders.set("vary", varyOnDataHeader(documentHeaders.get("vary")))
    }
    // A cookie queued before the signal makes the status page specific to this visitor.
    if (personalized) documentHeaders.set("cache-control", PRIVATE_NO_STORE)
    return renderTerminalStatus(status, req, documentHeaders, nonce, layouts)
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

  /** What a failed loader answers with, once a status signal has been ruled out. */
  const renderLoaderFailure = async (
    route: RouteEntry,
    req: Request,
    env: Env,
    params: Record<string, string>,
    err: unknown,
    personalized: boolean,
    layouts?: LayoutChainSource,
  ): Promise<PageResponse> => {
    if (isControlFlow(err)) throw err
    reportLoaderError(route, req, params, err)
    const errorId = boundaryFor(route, err)
    if (errorId === undefined) throw err
    options.logBoundaryError?.(err, req)
    if (req.headers.get(DATA_HEADER) !== null) {
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }
    return renderError(
      req,
      route,
      errorId,
      withDuplicateInstanceHint(err),
      personalized,
      options.nonce === undefined ? undefined : await resolveNonce(req, env),
      layouts,
    )
  }

  /**
   * Render a nested `_404` inside its layouts. `layoutModules` and `layoutData` are exactly the
   * layouts at or above the page, their gates already passed.
   */
  const renderNestedNotFound = async (
    req: Request,
    env: Env,
    id: string,
    page: NotFoundEntry,
    params: Readonly<Record<string, string>>,
    layoutModules: LoadedLayoutModules,
    layoutData: readonly unknown[] | undefined,
    personalized: boolean,
    signalHeaders?: HeadersLike,
  ): Promise<PageResponse> => {
    // The page can show what a layout loaded for this visitor, and a 404 is storable by default.
    const isPrivate = personalized || layoutData !== undefined
    if (req.headers.get(DATA_HEADER) !== null) {
      // No status header: the page has no client chunk, so the navigation falls back to loading the
      // URL as a document, which renders it here.
      const headers = new Headers(signalHeaders)
      headers.set("cache-control", PRIVATE_NO_STORE)
      headers.set("vary", varyOnDataHeader(headers.get("vary")))
      return new Response(null, { status: 404, headers })
    }
    const mod = await page.load()
    const nonce = options.nonce === undefined ? undefined : await resolveNonce(req, env)
    const { chain, head } = resolveChainAndHead(layoutModules, layoutData, mod, {
      data: null,
      pageData: null,
      params,
      origin: originFor(req),
      ...(nonce === undefined ? {} : { nonce }),
    })
    let headers: Headers | undefined
    if (signalHeaders !== undefined || isPrivate) {
      headers = new Headers(signalHeaders)
      if (signalHeaders !== undefined) headers.set("vary", varyOnDataHeader(headers.get("vary")))
      if (isPrivate) headers.set("cache-control", PRIVATE_NO_STORE)
    }
    return renderPageResult({
      adapter,
      chain,
      data: null,
      head,
      clientEntry,
      routeId: id,
      params,
      path: pathOf(req),
      search: searchChainOf(layoutModules, mod, req),
      matchChain: matchChainOf(page.layoutIds, layoutModules, id, mod),
      status: 404,
      hydrate: false,
      signal: req.signal,
      logError: deferredLogOf(req),
      ...localeOption(req),
      ...(layoutData !== undefined ? { layoutData } : {}),
      ...stylesOf(id),
      ...(headers === undefined ? {} : { headers }),
      ...(nonce === undefined ? {} : { nonce }),
      ...cspOption,
      ...titleOption,
    })
  }

  /** The nearest nested `_404` for the route's own `notFound()`, else `undefined` (root page). */
  const renderRouteNotFound = async (
    req: Request,
    env: Env,
    route: RouteEntry,
    params: Readonly<Record<string, string>>,
    signal: StatusSignal,
    run: LayoutRun | undefined,
    personalized: boolean,
  ): Promise<PageResponse | undefined> => {
    const id = route.notFoundIds?.at(-1)
    if (id === undefined || run === undefined) return undefined
    if (signal[STATUS_SIGNAL].status !== 404 || layoutErrorId(signal) !== undefined) {
      return undefined
    }
    const page = manifest.notFounds?.[id]
    if (page === undefined) return undefined
    try {
      await run.pending
    } catch {
      return undefined
    }
    // The page's layouts are the leading ones of the route's: its directory contains the route.
    const kept = page.layoutIds.length
    return renderNestedNotFound(
      req,
      env,
      id,
      page,
      params,
      run.modules.slice(0, kept),
      run.layoutData?.slice(0, kept),
      personalized,
      signal[STATUS_SIGNAL].headers,
    )
  }

  /** What a page route's failed loaders answer: a status signal's page, else the loader's error boundary. */
  const renderRouteFailure = async (
    req: Request,
    env: Env,
    route: RouteEntry,
    params: Record<string, string>,
    err: unknown,
    run: LayoutRun | undefined,
    personalized: boolean,
  ): Promise<PageResponse> => {
    if (isStatusSignal(err))
      return (
        (await renderRouteNotFound(req, env, route, params, err, run, personalized)) ??
        renderStatusSignal(req, env, err, personalized, leadingLayouts(run, err))
      )
    return renderLoaderFailure(route, req, env, params, err, personalized, leadingLayouts(run, err))
  }

  const renderNotFound = async (
    c: PageRouteContext<Env>,
    controls: PageResponseControls,
  ): Promise<PageResponse> => {
    const page = manifest.statusPages?.["404"] ?? manifest.notFound
    if (page === undefined) return renderTerminalStatus(404, c.req)
    return renderTerminalStatus(
      404,
      c.req,
      undefined,
      options.nonce === undefined ? undefined : await resolveNonce(c.req, c.env),
      rootLayoutsFor(c, controls),
    )
  }

  return {
    renderError,
    renderTerminalStatus,
    renderStatusSignal,
    reportLoaderError,
    renderLoaderFailure,
    renderNestedNotFound,
    renderRouteNotFound,
    renderRouteFailure,
    renderNotFound,
    rootLayoutsFor,
  }
}

export type StatusRenderer<Env = unknown> = ReturnType<typeof createStatusRenderer<Env>>

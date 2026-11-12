import { carryRequestLocals, isSameOriginForm } from "@nifrajs/core/server"
import { ndjsonStream, prepareDeferred } from "../deferred.ts"
import type { LoaderContext, RouteEntry } from "../manifest.ts"
import { DATA_HEADER, NAV_FROM_HEADER, RETAIN_HEADER, REVALIDATE_HEADER } from "../router.ts"
import type { ExecutionBase } from "./page-execution-base.ts"
import {
  leadingLayouts,
  loaderSearch,
  matchChainOf,
  pathOf,
  resolveChainAndHead,
  searchChainOf,
  serverLeafOf,
} from "./page-execution-helpers.ts"
import {
  type DocumentInput,
  type GatedLayouts,
  type LayoutRun,
  NO_LIVE,
  type PageResponse,
  type PageRouteContext,
  swapOption,
} from "./page-execution-shared.ts"
import type { LayoutRunner } from "./page-layouts.ts"
import type { StatusRenderer } from "./page-status.ts"
import { isControlFlow, isRevalidateResult, renderPageResult } from "./render-document.ts"
import { originFor } from "./request-url.ts"
import {
  ACTION_SCOPE,
  DATA_RESPONSE_HEADERS,
  PAGE_SCOPE,
  type PageResponseControls,
  PRIVATE_NO_STORE,
  PRIVATE_PAGE_HEADERS,
} from "./response-controls.ts"
import { isStatusSignal } from "./status-page.ts"

export function createActionHandler<Env = unknown>(
  base: ExecutionBase<Env>,
  layouts: LayoutRunner<Env>,
  status: StatusRenderer<Env>,
  progressiveActionData: WeakMap<Request, unknown>,
) {
  const { options } = base
  const {
    adapter,
    clientEntry,

    cacheModules,
    loadModule,
    apiFor,
    titleOption,
    cspOption,
    prerenderedHandover,
    copyOption,
    localeOption,
    localeGuarded,
    draftFlag,
    slotsFor,
    preloadOf,
    resolveNonce,
    stylesOf,
    deferredLogOf,
  } = base
  const { runLayoutChain, runLayoutGates, runMiddleware } = layouts
  const { renderStatusSignal, renderRouteNotFound, renderRouteFailure } = status

  return (route: RouteEntry) =>
    async (c: PageRouteContext<Env>, controls: PageResponseControls): Promise<PageResponse> => {
      const loaded = loadModule(route)
      const mod = cacheModules && !(loaded instanceof Promise) ? loaded : await loaded
      const draft = await draftFlag(c.req)
      if (draft) controls.personalize()
      if (mod.action === undefined) {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
        })
      }
      const isDataRequest = c.req.headers.get(DATA_HEADER) !== null
      // Before anything runs: a form posts cross-site without a preflight and carries the visitor's
      // cookies, so an action is a CSRF target unless its route names the origins it accepts.
      const origin = c.req.headers.get("origin")
      const allowedOrigins = mod.allowedOrigins
      const sameOrigin =
        origin === null || isSameOriginForm(origin, c.req.headers.get("sec-fetch-site"), c.req)
      const allowed =
        allowedOrigins === undefined
          ? sameOrigin
          : typeof allowedOrigins === "function"
            ? allowedOrigins(origin, sameOrigin) === true
            : origin !== null && allowedOrigins.includes(origin)
      if (!allowed) {
        return isDataRequest
          ? Response.json(
              { ok: false, error: "forbidden_origin" },
              { status: 403, headers: { "cache-control": PRIVATE_NO_STORE } },
            )
          : new Response("Forbidden", {
              status: 403,
              headers: {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": PRIVATE_NO_STORE,
              },
            })
      }
      const requestApi = apiFor(c)
      const actionContext: LoaderContext = {
        params: c.params,
        request: c.req,
        req: c.req,
        api: requestApi,
        env: c.env,
        draft,
        search: loaderSearch(mod.searchSchema, c.req),
        set: controls.scope(ACTION_SCOPE),
        live: NO_LIVE,
      }
      let gated: GatedLayouts
      let result: unknown
      try {
        if (route.middlewareIds !== undefined || localeGuarded(route)) {
          await runMiddleware(route, actionContext, controls, c.req)
        }
        gated = await runLayoutGates(route, actionContext, controls)
        result = await mod.action(actionContext)
      } catch (err) {
        if (isControlFlow(err)) return err
        throw err
      }
      const revalidation = isRevalidateResult(result) ? result : undefined
      const actionResult = revalidation === undefined ? result : revalidation.data
      const revalidateHeader: Record<string, string> =
        revalidation === undefined
          ? {}
          : { [REVALIDATE_HEADER]: revalidation.__nifraRevalidate.join(",") }
      // The write is done, whatever the action answers with (a redirect included): what it made
      // stale is invalidated before the answer leaves.
      const settling =
        revalidation === undefined ? undefined : options.invalidate?.(revalidation, c.req)
      if (settling !== undefined) await settling
      if (isControlFlow(actionResult)) return actionResult
      if (isDataRequest) {
        // Headers shape the document only, but a bad one fails here too, so a navigation and a full
        // page load agree on whether the action's response is valid.
        controls.commit()
        const { forClient, deferred } = prepareDeferred(actionResult)
        if (deferred.length === 0) {
          return Response.json(actionResult ?? null, {
            headers: { ...DATA_RESPONSE_HEADERS, ...revalidateHeader },
          })
        }
        return new Response(
          ndjsonStream(forClient, deferred, undefined, c.req.signal, deferredLogOf(c.req)),
          {
            headers: {
              "content-type": "application/x-ndjson; charset=utf-8",
              ...DATA_RESPONSE_HEADERS,
              ...revalidateHeader,
            },
          },
        )
      }
      if (options.serverComponents?.owns(route.id)) {
        if (options.rerenderOwnerGET === undefined) throw new Error("component_contract")
        const actionHeaders = controls.documentHeaders()
        if (controls.progressiveRedirect(c.req)) {
          // Relative, so a browser behind a TLS terminator stays on its own scheme. A `//` path
          // would read as another host, so that one keeps the absolute URL.
          const { pathname, search } = new URL(c.req.url)
          const location = pathname.startsWith("//") ? c.req.url : pathname + search
          return new Response(null, {
            status: 303,
            headers: { ...actionHeaders, location, "cache-control": PRIVATE_NO_STORE },
          })
        }
        const headers = new Headers(c.req.headers)
        for (const name of [
          DATA_HEADER,
          RETAIN_HEADER,
          NAV_FROM_HEADER,
          "x-nifra-component",
          "content-type",
          "content-length",
          "transfer-encoding",
        ])
          headers.delete(name)
        const cookie = controls.progressiveCookies(c.req)
        if (cookie) headers.set("cookie", cookie)
        else headers.delete("cookie")
        const request = new Request(c.req.url, {
          method: "GET",
          headers,
          signal: c.signal === undefined ? c.req.signal : AbortSignal.any([c.signal, c.req.signal]),
        })
        // The owner page's GET answers the same visitor's action, so it reads the action's locals.
        carryRequestLocals(c.req, request)
        progressiveActionData.set(request, actionResult)
        try {
          const response = await options.rerenderOwnerGET(request, c)
          const merged = new Headers(response.headers)
          for (const [name, value] of Object.entries(actionHeaders ?? {}))
            if (!merged.has(name)) merged.set(name, value)
          merged.set("cache-control", PRIVATE_NO_STORE)
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: merged,
          })
        } finally {
          progressiveActionData.delete(request)
        }
      }
      const layoutModules = gated.modules
      const search = searchChainOf(layoutModules, mod, c.req)
      let run: LayoutRun | undefined
      let data: unknown
      let responseHeaders: Record<string, string> | undefined
      // The ordinary layout loaders run now, after the mutation, as a GET of this page would.
      try {
        run = await runLayoutChain(route, actionContext, controls, undefined, gated)
        const pageResult = mod.loader
          ? mod.loader({
              params: c.params,
              request: c.req,
              req: c.req,
              api: requestApi,
              env: c.env,
              draft,
              search,
              set: controls.scope(PAGE_SCOPE),
              live: NO_LIVE,
            })
          : null
        const [pageData] =
          run.pending === undefined
            ? ([await pageResult] as const)
            : await Promise.all([pageResult, run.pending])
        data = pageData
        responseHeaders = controls.documentHeaders()
      } catch (err) {
        return renderRouteFailure(c.req, c.env, route, c.params, err, run, controls.personalized)
      }
      // The re-render answers a returned redirect or status the way the page's GET does.
      if (isStatusSignal(data))
        return (
          (await renderRouteNotFound(
            c.req,
            c.env,
            route,
            c.params,
            data,
            run,
            controls.personalized,
          )) ??
          renderStatusSignal(c.req, c.env, data, controls.personalized, leadingLayouts(run, data))
        )
      if (isControlFlow(data)) return data
      const layoutData = run.layoutData
      const layoutProps: { layoutData?: Exclude<typeof layoutData, undefined> } = {}
      if (layoutData !== undefined) {
        layoutProps.layoutData = layoutData
        // The page now shows what a layout loaded for this visitor.
        responseHeaders = { ...responseHeaders, ...PRIVATE_PAGE_HEADERS }
      }
      const nonce = options.nonce === undefined ? undefined : await resolveNonce(c.req, c.env)
      const { chain, head } = resolveChainAndHead(
        layoutModules,
        layoutData,
        mod,
        {
          data,
          pageData: data,
          params: c.params,
          origin: originFor(c.req),
          ...(nonce === undefined ? {} : { nonce }),
        },
        serverLeafOf(route, mod),
      )
      const page: DocumentInput = {
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
        matchChain: matchChainOf(route.layoutIds, layoutModules, route.id, mod),
        hydrate: mod.hydrate !== false,
        signal: c.req.signal,
        logError: deferredLogOf(c.req),
        ...layoutProps,
        ...preloadOf(route.id),
        ...stylesOf(route.id),
        ...prerenderedHandover,
        ...copyOption,
        ...localeOption(c.req),
        ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
        ...(nonce === undefined ? {} : { nonce }),
        ...cspOption,
        ...titleOption,
        ...swapOption(c.req),
        ...slotsFor(route.layoutIds, route.id),
      }
      if (mod.islandScripts !== undefined) page.islandScripts = mod.islandScripts
      return renderPageResult(page)
    }
}

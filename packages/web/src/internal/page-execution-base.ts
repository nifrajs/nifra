import type { Platform } from "@nifrajs/core/server"
import { type CssLoadingMode, DEFAULT_CSS_LOADING, normalizeCssLoading } from "../css-contract.ts"
import { isDraftEnabled } from "../draft.ts"
import type { RouteEntry } from "../manifest.ts"
import type { PageLocale, PageLocales } from "../render-seam.ts"
import { createMatcher } from "../router.ts"
import { keepAliveTable, slotDepths } from "./keep-alive-table.ts"
import { prepareModules } from "./module-preparation.ts"
import { pathOf } from "./page-execution-helpers.ts"
import {
  LOCALE_SEGMENTS,
  LoaderPlatform,
  type NotFoundTarget,
  type PageExecutionOptions,
  type PageRouteContext,
  platformBinderOf,
} from "./page-execution-shared.ts"

export function createExecutionBase<Env = unknown>(options: PageExecutionOptions<Env>) {
  const { adapter, manifest, clientEntry, api } = options
  const cacheModules =
    options.cacheRouteModules ??
    (typeof process !== "undefined" && process.env?.NODE_ENV === "production")
  const loadModule = prepareModules(cacheModules)
  // Bound once per render, so every loader, action and boundary in that render shares one view of the
  // in-process client carrying the visitor's platform. An `api` without the seam passes through as-is.
  const bindApi = platformBinderOf(api)
  // One view per render, shared by every loader, action and boundary it runs.
  const apiFor = (c: PageRouteContext<Env>): unknown =>
    bindApi === undefined ? api : bindApi.call(api, new LoaderPlatform(c) as Platform)
  const cssLoading = normalizeCssLoading(options.cssLoading ?? DEFAULT_CSS_LOADING)
  const titleOption = options.title === undefined ? {} : { title: options.title }
  const cspOption = options.csp === undefined ? {} : { csp: options.csp }
  const prerenderedSet = new Set(options.prerenderedPaths ?? [])
  const prerenderedHandover =
    options.prerenderedListUrl === undefined
      ? { prerenderedPaths: options.prerenderedPaths ?? [] }
      : { prerenderedListUrl: options.prerenderedListUrl }
  const copyOption = options.copyChunks === undefined ? {} : { copyChunks: options.copyChunks }
  const appDocumentOptions = { ...prerenderedHandover, ...copyOption, ...cspOption, ...titleOption }
  const { i18n } = options
  const pageLocales = new Map(i18n?.locales.locales.map((locale) => [locale.key, locale]))
  /** The request's locale for a document, with the served locales the client names locales from. */
  const localeFor = (key: string): { locale?: PageLocale; locales?: PageLocales } => {
    if (i18n === undefined) return {}
    const locale = pageLocales.get(key)
    return locale === undefined ? { locales: i18n.locales } : { locale, locales: i18n.locales }
  }
  const localeOption = (req: Request): { locale?: PageLocale; locales?: PageLocales } =>
    i18n === undefined ? {} : localeFor(i18n.localeOf(pathOf(req)))
  /** Whether a route sits under a `[lang]` or `[[lang]]` directory, which the locale routing checks. */
  const localeGuarded = (route: RouteEntry): boolean => {
    if (i18n === undefined) return false
    for (const segment of route.id.split("/")) {
      if (!(segment.startsWith("(") && segment.endsWith(")"))) return LOCALE_SEGMENTS.has(segment)
    }
    return false
  }
  const matchManifestRoute = createMatcher(
    manifest.routes.map((route) => ({ routeId: route.id, pattern: route.pattern })),
  )
  const routeById = new Map(manifest.routes.map((route) => [route.id, route]))

  // A nested `_404` answers an unmatched URL from inside the catch-all, never as a route of its own:
  // a registered `/admin/*` would take URLs from a route the router only reaches by backtracking.
  // Param names are indexed by position, so two directories that name one segment differently share
  // the index; each target keeps its own names to read a match back.
  const notFoundTargets: NotFoundTarget[] = []
  const notFoundPatterns: Array<{ routeId: string; pattern: string }> = []
  for (const [id, page] of Object.entries(manifest.notFounds ?? {})) {
    for (const scope of page.scopes) {
      const names: string[] = []
      const pattern = scope.pattern.replace(
        /([:*])([A-Za-z_][A-Za-z0-9_]*)/g,
        (_match, sigil: string, name: string) => `${sigil}p${names.push(name) - 1}`,
      )
      notFoundPatterns.push({ routeId: String(notFoundTargets.length), pattern })
      notFoundTargets.push({
        id,
        page,
        names,
        route: {
          id,
          pattern: scope.pattern,
          layoutIds: page.layoutIds,
          layoutParams: scope.layoutParams,
          ...(page.middlewareIds === undefined
            ? {}
            : {
                middlewareIds: page.middlewareIds,
                ...(scope.middlewareParams === undefined
                  ? {}
                  : { middlewareParams: scope.middlewareParams }),
              }),
          errorIds: page.errorIds,
          file: page.file,
          load: page.load,
        },
      })
    }
  }
  const matchNotFoundScope =
    notFoundPatterns.length === 0 ? undefined : createMatcher(notFoundPatterns)

  const draftFlag = (req: Request): Promise<boolean> =>
    options.draftSecret === undefined
      ? Promise.resolve(false)
      : isDraftEnabled(req, options.draftSecret)

  // Where the browser's keep-alive view puts slot wrappers, so the document it hydrates has them:
  // nothing outside an app with a `keepAlive` route.
  const keepTable = keepAliveTable(manifest)
  const slotsFor = (
    layoutIds: readonly string[],
    routeId: string,
  ): { slots?: readonly number[] } => {
    // Every page of a keep-alive app renders through the adapter's keep-alive root, wrappers or none,
    // as the browser hydrates it.
    if (keepTable === undefined) return {}
    return { slots: slotDepths(keepTable, layoutIds, routeId) }
  }

  const preloadOf = (id: string): { preload?: readonly string[] } => {
    const chunks = options.routePreload?.[id]
    return chunks ? { preload: chunks } : {}
  }

  const resolveNonce = (
    request: Request,
    env: Env,
  ): string | undefined | Promise<string | undefined> =>
    options.nonce === undefined ? undefined : options.nonce({ request, env })

  const stylesFrom = (
    styles: readonly string[] | undefined,
  ): { styles?: readonly string[]; cssLoading?: CssLoadingMode } => {
    if (styles === undefined || styles.length === 0) return {}
    return {
      styles,
      ...(cssLoading === "deferred" ? { cssLoading } : {}),
    }
  }

  const stylesOf = (id: string): { styles?: readonly string[]; cssLoading?: CssLoadingMode } =>
    stylesFrom(options.routeStyles?.[id] ?? options.styles)

  /** The server's error log for one request, where a rejected `defer()` value is written. */
  const deferredLogOf = (req: Request): ((error: unknown) => void) | undefined => {
    const log = options.logBoundaryError
    return log === undefined ? undefined : (error) => log(error, req)
  }
  return {
    adapter,
    manifest,
    clientEntry,
    api,
    options,
    cacheModules,
    loadModule,
    apiFor,
    cssLoading,
    titleOption,
    cspOption,
    prerenderedSet,
    prerenderedHandover,
    copyOption,
    appDocumentOptions,
    i18n,
    localeFor,
    localeOption,
    localeGuarded,
    matchManifestRoute,
    routeById,
    notFoundTargets,
    matchNotFoundScope,
    draftFlag,
    keepTable,
    slotsFor,
    preloadOf,
    resolveNonce,
    stylesFrom,
    stylesOf,
    deferredLogOf,
  }
}

export type ExecutionBase<Env = unknown> = ReturnType<typeof createExecutionBase<Env>>

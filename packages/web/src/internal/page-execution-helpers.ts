import type {
  LoaderContext,
  Meta,
  MetaArgs,
  RouteEntry,
  RouteModule,
  ShouldRevalidate,
} from "../manifest.ts"
import type { MatchChain } from "../render-seam.ts"
import { searchOf, searchOfChain } from "../search.ts"
import { mergeHeads, resolveChainMeta } from "./head-merge.ts"
import type { LiveFinish } from "./live-contract.ts"
import {
  EMPTY_LEAF,
  type LayoutChain,
  type LayoutChainSource,
  type LayoutRun,
  type RetainContext,
} from "./page-execution-shared.ts"
import {
  EMPTY_RETAIN,
  isControlFlow,
  type LoadedLayoutModules,
  layoutErrorId,
  tagLayoutError,
} from "./render-document.ts"
import { searchOfRequest } from "./request-search.ts"
import { originFor, urlPartsFor } from "./request-url.ts"
import { isStatusSignal } from "./status-page.ts"

/** Which owners a successful live load ran and which it kept, by their wire ids. */
export const liveOwners = (
  route: RouteEntry,
  modules: LoadedLayoutModules | undefined,
  layoutData: readonly unknown[] | undefined,
  retained: readonly number[],
  mod: RouteModule,
  skipPage: boolean,
  ctx: LoaderContext,
): LiveFinish => {
  const fresh: string[] = []
  const kept: string[] = []
  for (let i = 0; i < (modules?.length ?? 0); i++) {
    if (modules?.[i]?.loader === undefined) continue
    const owner = `L:${route.layoutIds[i]}`
    if (retained.includes(i)) kept.push(owner)
    // A layout that answered with a status declared keys for data nobody is shown.
    else if (!isStatusSignal(layoutData?.[i])) fresh.push(owner)
  }
  if (skipPage) kept.push(`P:${route.id}`)
  else if (mod.loader !== undefined) fresh.push(`P:${route.id}`)
  return { fresh, retained: kept, ctx }
}

/**
 * Await one gate. A returned redirect, status or Response refuses the request exactly as a thrown
 * one does: stored as layout data it would let the page loader and the action run.
 */
export const runGate = async (
  route: RouteEntry,
  index: number,
  loader: NonNullable<LoadedLayoutModules[number]["loader"]>,
  ctx: LoaderContext,
): Promise<unknown> => {
  let value: unknown
  try {
    value = await loader(ctx)
  } catch (err) {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The loaded layout array is derived from these same manifest IDs in the same order.
    throw tagLayoutError(err, route.layoutIds[index] as string)
  }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The loaded layout array is derived from these same manifest IDs in the same order.
  if (isControlFlow(value)) throw tagLayoutError(value, route.layoutIds[index] as string)
  return value
}

export const retainedIndices = (header: string | null): ReadonlySet<number> => {
  if (header === null || header === "") return EMPTY_RETAIN
  const out = new Set<number>()
  for (const part of header.split(",")) {
    if (!/^\d+$/.test(part)) continue
    out.add(Number(part))
  }
  return out
}

const sameParams = (
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean => {
  const names = Object.keys(a)
  return names.length === Object.keys(b).length && names.every((name) => a[name] === b[name])
}

/** A query change re-runs layout loaders by default: any can read it, and none declares keys. */
export const keepsLayoutData = (
  route: RouteEntry,
  index: number,
  layout: LoadedLayoutModules[number],
  params: Readonly<Record<string, string>>,
  retain: RetainContext,
): boolean => {
  if (!retain.requested.has(index)) return false
  const previous = retain.from
  if (route.layoutIds[index] !== previous.layoutIds[index]) return false
  const owned = route.layoutParams?.[index]
  const previouslyOwned = previous.layoutParams?.[index]
  // A manifest that does not say which params a layout owns hands its loader all of them, so any
  // change in them is a change the layout can see.
  const paramsChanged =
    owned === undefined || previouslyOwned === undefined
      ? !sameParams(params, retain.fromParams)
      : owned.length !== previouslyOwned.length ||
        owned.some((name, i) => name !== previouslyOwned[i]) ||
        owned.some((name) => params[name] !== retain.fromParams[name])
  const defaultShouldRevalidate = retain.fromUrl.search !== retain.toUrl.search || paramsChanged
  const decide = layout.shouldRevalidate
  if (typeof decide !== "function") return !defaultShouldRevalidate
  // Copies, so a hook that mutates its arguments cannot reach the request's params or the next
  // layout's view of the navigation.
  const answer = (decide as ShouldRevalidate)({
    currentUrl: new URL(retain.fromUrl),
    nextUrl: new URL(retain.toUrl),
    currentParams: { ...retain.fromParams },
    nextParams: { ...params },
    defaultShouldRevalidate,
  })
  return answer === false
}

// A query is parsed and validated once per request; with none there is nothing to share, and the
// plain calls cost less than a memo.
export const loaderSearch = (searchSchema: RouteModule["searchSchema"], request: Request) => {
  const raw = urlPartsFor(request).search
  return raw === "" ? searchOf(searchSchema, raw) : searchOfRequest(request, [searchSchema], raw)
}

export const searchChainOf = (
  layoutMods: LoadedLayoutModules,
  mod: RouteModule,
  request: Request,
): Record<string, unknown> => {
  const raw = urlPartsFor(request).search
  const schemas = [...layoutMods.map((m) => m.searchSchema), mod.searchSchema]
  return raw === "" ? searchOfChain(schemas, raw) : searchOfRequest(request, schemas, raw)
}

// `ssr = false`: the slot holds `HydrateFallback`, which the browser hydrates before the page.
export const serverLeafOf = (route: RouteEntry, mod: RouteModule): unknown => {
  if (mod.ssr !== false) return mod.default
  if (mod.hydrate === false) {
    throw new Error(
      `[nifra/web] route "${route.id}" sets both \`ssr = false\` and \`hydrate = false\`: the ` +
        "server skips its component and no client would ever render it. Remove one of the two.",
    )
  }
  return mod.HydrateFallback ?? EMPTY_LEAF
}

export const resolveChainAndHead = (
  layoutModules: LoadedLayoutModules,
  layoutData: readonly unknown[] | undefined,
  page: RouteModule,
  metaArgs: MetaArgs,
  leaf: unknown = page.default,
): { chain: unknown[]; head: Meta } => {
  const chain = [...layoutModules.map((m) => m.default), leaf]
  const metas = [...layoutModules.map((m) => m.meta), page.meta]
  return { chain, head: mergeHeads(resolveChainMeta(metas, layoutData, metaArgs)) }
}

/** What `useMatches` reports for a chain: the layouts' ids and `handle`s, then the page's. */
export const matchChainOf = (
  layoutIds: readonly string[],
  layoutModules: LoadedLayoutModules,
  pageId: string,
  page: { readonly handle?: unknown },
): MatchChain => ({
  ids: [...layoutIds, pageId],
  handles: [...layoutModules.map((layout) => layout.handle), page.handle],
})

export const dirOfId = (id: string, suffix: string): string =>
  id === suffix ? "" : id.slice(0, id.length - suffix.length - 1)

export const boundaryFor = (route: RouteEntry, err: unknown): string | undefined => {
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

export const pathOf = (req: Request): string => {
  try {
    const parts = urlPartsFor(req)
    return parts.pathname + parts.search
  } catch {
    return "/"
  }
}

/** What a status or error page's `meta` receives: no route params, and its own data. */
export const statusMetaArgs = (req: Request, data: unknown, nonce: string | undefined): MetaArgs =>
  nonce === undefined
    ? { data, pageData: data, params: {}, origin: originFor(req) }
    : { data, pageData: data, params: {}, origin: originFor(req), nonce }

/** The leading `count` layouts of `modules`, unless one of them answered with a status or redirect. */
export const settledLayouts = (
  modules: LoadedLayoutModules,
  layoutData: readonly unknown[] | undefined,
  count: number,
): LayoutChain | undefined => {
  if (modules.length < count) return undefined
  const data = layoutData?.slice(0, count)
  if (data?.some((value) => isControlFlow(value) || isStatusSignal(value))) return undefined
  return { modules: modules.slice(0, count), layoutData: data }
}

/** A run's leading layouts once all of its loaders settle - never when a layout or middleware refused. */
export const leadingLayouts =
  (run: LayoutRun | undefined, err?: unknown): LayoutChainSource =>
  async (_page, count) => {
    if (run === undefined || (err !== undefined && layoutErrorId(err) !== undefined)) {
      return undefined
    }
    try {
      await run.pending
    } catch {
      return undefined
    }
    return settledLayouts(run.modules, run.layoutData, count)
  }

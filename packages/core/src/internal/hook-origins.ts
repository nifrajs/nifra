/**
 * Where each registered hook came from, for `reflectHooks` (`nifra routes --hooks`). Development-only:
 * every write sits behind the inline `process.env.NODE_ENV !== "production"` guard at its call site in
 * `server.ts`, so a production define folds the writes away and this module drops out of the bundle.
 * Reads happen only from reflection, never on the request path.
 */

export type HookKind =
  | "onRequest"
  | "around"
  | "authenticate"
  | "derive"
  | "beforeHandle"
  | "afterHandle"
  | "onError"
  | "onResponse"
  | "responseHeaders"
  | "onResponseFinalized"

export interface HookOrigin {
  readonly kind: HookKind
  /** The server the hook was registered on. */
  readonly owner: object
  /** The plugin being applied when it was registered, if any. */
  readonly plugin: string | undefined
  /** A group's static headers turned into this hook at adoption: report the owner's declarations. */
  readonly statics?: true
}

/** Which requests an adopted hook still runs for: under a group prefix, or a merged server's routes. */
export type HookScopeTag =
  | { readonly inner: unknown; readonly prefix: string }
  | {
      readonly inner: unknown
      readonly routes: readonly { readonly method: string; readonly path: string }[]
    }

/** One `responseHeaders()` declaration that reached a server's static tier. */
export interface StaticHeadersTag {
  readonly owner: object
  readonly names: readonly string[]
  readonly source: unknown
  readonly plugin: string | undefined
}

export interface AdoptionTag {
  readonly source: object
  readonly prefix: string | undefined
}

/** A `merge()` whose routes carry no authentication of their own while the parent authenticates the
 * routes it declares: the parent's order-scoped auth never runs for merged routes. */
export interface MergeAuthGapTag {
  /** The `merge()` call's `file:line:col`, when a frame outside core was found. */
  readonly site: string | undefined
  /** The parent's auth in effect at the merge: `authenticate(<id>)` stages and evidence sources. */
  readonly auth: readonly string[]
  /** `METHOD /path` of each merged route the parent's auth would have covered. */
  readonly routes: readonly string[]
}

const origins = new WeakMap<object, HookOrigin>()
const scopes = new WeakMap<object, HookScopeTag>()
const sources = new WeakMap<object, unknown>()
const statics = new WeakMap<object, StaticHeadersTag[]>()
const adoptions = new WeakMap<object, AdoptionTag[]>()
const mergeAuthGaps = new WeakMap<object, MergeAuthGapTag[]>()
let applying: string | undefined
// A merged server whose static headers are about to become one of the target's response hooks.
let staticsOwner: object | undefined

const isRef = (value: unknown): value is object =>
  (typeof value === "function" || typeof value === "object") && value !== null

/** Record a hook's origin. The first registration wins, so a hook re-adopted elsewhere keeps its site. */
export function tagHook(hook: unknown, kind: HookKind, owner: object, groupStatics?: true): void {
  if (!isRef(hook) || origins.has(hook)) return
  if (kind === "responseHeaders" && staticsOwner !== undefined) {
    origins.set(hook, { kind, owner: staticsOwner, plugin: applying, statics: true })
    staticsOwner = undefined
    return
  }
  origins.set(
    hook,
    groupStatics === true
      ? { kind, owner, plugin: applying, statics: true }
      : { kind, owner, plugin: applying },
  )
}

/**
 * A merge folds the source's static headers into the target: into its static tier, or - once the
 * target has a response hook - into a new hook, which the next `responseHeaders` tag then is.
 */
export function adoptStaticTags(target: object, source: object, becomesHook: boolean): void {
  if (becomesHook) {
    staticsOwner = source
    return
  }
  for (const tag of statics.get(source) ?? []) {
    tagStatic(target, tag.names, tag.source, tag.owner, tag.plugin)
  }
}

/** The author's function (or header record) an internal wrapper adapts, for naming it. */
export function tagSource(wrapper: unknown, source: unknown): void {
  if (isRef(wrapper)) sources.set(wrapper, source)
}

/** Pair each scoped wrapper with the hook it gates and the scope it gates it by. */
export function tagScoped(
  originals: readonly unknown[],
  wrapped: readonly unknown[],
  scope:
    | { readonly prefix: string }
    | { readonly routes: readonly { readonly method: string; readonly path: string }[] },
): void {
  for (let i = 0; i < wrapped.length; i++) {
    const wrapper = wrapped[i]
    if (isRef(wrapper) && wrapper !== originals[i])
      scopes.set(wrapper, { inner: originals[i], ...scope })
  }
}

export function tagStatic(
  server: object,
  names: readonly string[],
  source: unknown,
  owner: object = server,
  plugin: string | undefined = applying,
): void {
  const list = statics.get(server)
  const tag = { owner, names: names.map((name) => name.toLowerCase()), source, plugin }
  if (list === undefined) statics.set(server, [tag])
  else list.push(tag)
}

export function tagAdoption(target: object, source: object, prefix: string | undefined): void {
  const list = adoptions.get(target)
  const tag = { source, prefix }
  if (list === undefined) adoptions.set(target, [tag])
  else list.push(tag)
}

export function tagMergeAuthGap(target: object, gap: MergeAuthGapTag): void {
  const list = mergeAuthGaps.get(target)
  if (list === undefined) mergeAuthGaps.set(target, [gap])
  else list.push(gap)
}

const outer: (string | undefined)[] = []

/** Mark the plugin a `use()` is applying, until the matching {@link leavePlugin}. */
export function enterPlugin(name: string | undefined): void {
  outer.push(applying)
  if (name !== undefined) applying = name
}

export function leavePlugin(): void {
  applying = outer.pop()
}

export const hookOriginOf = (hook: unknown): HookOrigin | undefined =>
  isRef(hook) ? origins.get(hook) : undefined
export const hookScopeOf = (hook: unknown): HookScopeTag | undefined =>
  isRef(hook) ? scopes.get(hook) : undefined
export const hookSourceOf = (hook: unknown): unknown =>
  isRef(hook) ? sources.get(hook) : undefined
export const staticHeadersOf = (server: object): readonly StaticHeadersTag[] =>
  statics.get(server) ?? []
export const adoptionsOf = (server: object): readonly AdoptionTag[] => adoptions.get(server) ?? []
export const mergeAuthGapsOf = (server: object): readonly MergeAuthGapTag[] =>
  mergeAuthGaps.get(server) ?? []

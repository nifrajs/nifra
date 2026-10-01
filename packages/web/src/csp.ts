import { PRE_HYDRATION_GUARD } from "./internal/runtime-contract.ts"
import { createNonceResolver, type NonceResolver } from "./nonce.ts"
import type { RenderAdapter } from "./render-seam.ts"

/** What {@link CreateCspPolicyOptions.header} receives for one document. */
export interface CspHeaderContext {
  /**
   * The `script-src` sources this document needs, space-separated: a `'sha256-…'` hash for each
   * constant inline script nifra writes, plus `'nonce-…'` when the document carries a script that is
   * specific to this request. External scripts (the client entry, route chunks, islands) are not
   * listed: allow their origin, usually `'self'`.
   */
  readonly sources: string
  /** The nonce, when this document carries one. Such a document is `private, no-store`. */
  readonly nonce?: string
}

export interface CreateCspPolicyOptions {
  /**
   * Build the complete Content-Security-Policy value for one document, or `undefined` to send none:
   *
   * ```ts
   * header: ({ sources }) => `default-src 'self'; script-src 'self' ${sources}; object-src 'none'`
   * ```
   */
  readonly header: (context: CspHeaderContext) => string | undefined
  /** Generate the nonce for a document that needs one. Default: 122 random bits, CSP base64-safe. */
  readonly generate?: () => string
}

const CSP_POLICY: unique symbol = Symbol.for("nifra.web.cspPolicy")

/** How a `createWebApp` app's documents meet a CSP: `"nonce"` (every document carries one, so none is
 * cacheable) or `"hash"` (a {@link CspPolicy}). Read by wrappers that cache documents. */
export const DOCUMENT_POLICY: unique symbol = Symbol.for("nifra.web.documentPolicy")

/** The hash sources for one adapter, and the hydration head they were computed from. */
interface AdapterSources {
  readonly head: string
  readonly sources: string
}

interface CspPolicyState {
  readonly header: (context: CspHeaderContext) => string | undefined
  readonly generate: () => string
  readonly adapters: WeakMap<RenderAdapter, AdapterSources | Promise<AdapterSources>>
}

/**
 * A hash-based Content-Security-Policy for nifra documents - see {@link createCspPolicy}. Opaque: pass
 * it to `createWebApp({ csp })` or `renderPage({ csp })`.
 */
export interface CspPolicy {
  readonly [CSP_POLICY]: CspPolicyState
}

/**
 * Create a hash-based Content-Security-Policy for nifra documents, so a page can carry a strict CSP
 * and still be cached.
 *
 * A per-request nonce makes every document unique: nifra marks a nonce-bearing document
 * `private, no-store`, so no shared cache (ISR, a CDN) may store it. Under this policy a document
 * gets a nonce only when it carries a script specific to this request: a page that `defer()`s streams
 * one per settled value, and `unsafeInlineScript` names the nonce. Every other document is nonce-free.
 * Its inline scripts are the constant ones nifra writes, listed by hash, so the CSP header is the
 * same on every request and the page stays cacheable. Page data rides in an inert JSON script, which
 * a CSP does not govern.
 *
 * ```ts
 * const csp = createCspPolicy({
 *   header: ({ sources }) => `default-src 'self'; script-src 'self' ${sources}; object-src 'none'`,
 * })
 * const app = createWebApp({ adapter, manifest, clientEntry, csp })
 * ```
 */
export function createCspPolicy(options: CreateCspPolicyOptions): CspPolicy {
  if (typeof options?.header !== "function") {
    throw new TypeError("[nifra/web] createCspPolicy requires a header function")
  }
  return {
    [CSP_POLICY]: {
      header: options.header,
      // A UUID's hyphens are outside the CSP base64-value grammar; the remaining 122 random bits are
      // plenty for a per-response nonce, on every fetch runtime.
      generate: options.generate ?? (() => crypto.randomUUID().replaceAll("-", "")),
      adapters: new WeakMap(),
    },
  }
}

/** True for a value made by {@link createCspPolicy}. */
export const isCspPolicy = (value: unknown): value is CspPolicy =>
  typeof value === "object" && value !== null && CSP_POLICY in value

const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi

/** The bodies of the executable inline scripts in a fragment of markup (no `src`, no inert type). */
const inlineScriptBodies = (html: string): string[] => {
  const bodies: string[] = []
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const attrs = match[1] ?? ""
    if (/\bsrc\s*=/i.test(attrs) || /\btype\s*=\s*["']?application\/(ld\+)?json/i.test(attrs))
      continue
    bodies.push(match[2] ?? "")
  }
  return bodies
}

const ENCODER = new TextEncoder()

/** A CSP hash source for one inline script body: `'sha256-<base64 of the UTF-8 bytes>'`. */
async function hashSource(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ENCODER.encode(body)))
  let binary = ""
  for (const byte of digest) binary += String.fromCharCode(byte)
  return `'sha256-${btoa(binary)}'`
}

/**
 * The `'sha256-…'` sources for the constant inline scripts nifra writes into a document rendered
 * with `adapter`: the pre-hydration form guard and the adapter's hydration head. For a CSP set outside
 * the app (a proxy, a CDN rule); {@link createCspPolicy} computes the same list itself.
 */
export async function nifraScriptHashes(adapter: RenderAdapter): Promise<readonly string[]> {
  const bodies = [PRE_HYDRATION_GUARD, ...inlineScriptBodies(adapter.hydrationHead())]
  return Promise.all([...new Set(bodies)].map(hashSource))
}

/**
 * Compute (once per adapter) the policy's hash sources. Returns `undefined` once they are ready, so
 * the renderer stays synchronous after the first document.
 */
export function prepareCspPolicy(
  policy: CspPolicy,
  adapter: RenderAdapter,
): Promise<void> | undefined {
  const state = policy[CSP_POLICY]
  const known = state.adapters.get(adapter)
  if (known !== undefined) return known instanceof Promise ? known.then(() => undefined) : undefined
  const head = adapter.hydrationHead()
  const pending = nifraScriptHashes(adapter).then((hashes) => {
    const sources = { head, sources: hashes.join(" ") }
    state.adapters.set(adapter, sources)
    return sources
  })
  state.adapters.set(adapter, pending)
  // A failed digest must not pin a rejected promise: the next document retries.
  pending.catch(() => state.adapters.delete(adapter))
  return pending.then(() => undefined)
}

const preparedSources = (policy: CspPolicy, adapter: RenderAdapter): AdapterSources => {
  const known = policy[CSP_POLICY].adapters.get(adapter)
  if (known === undefined || known instanceof Promise) {
    throw new Error("[nifra/web] CSP policy used before prepareCspPolicy resolved")
  }
  return known
}

/**
 * The nonce one document carries under `policy`: `undefined` unless the document needs one -
 * `needsNonce` (a deferred value or a head tag naming the nonce), or an adapter whose hydration head
 * no longer matches the one the policy hashed. A needed nonce reuses the caller's, else is generated.
 */
export function cspDocumentNonce(
  policy: CspPolicy,
  adapter: RenderAdapter,
  hydrate: boolean,
  needsNonce: boolean,
  requested: string | undefined,
): string | undefined {
  const varies = hydrate && adapter.hydrationHead() !== preparedSources(policy, adapter).head
  if (!needsNonce && !varies) return undefined
  return requested ?? policy[CSP_POLICY].generate()
}

/** The Content-Security-Policy value for one document, or `undefined` when the policy sends none. */
export function cspHeaderValue(
  policy: CspPolicy,
  adapter: RenderAdapter,
  nonce: string | undefined,
): string | undefined {
  const { sources } = preparedSources(policy, adapter)
  const state = policy[CSP_POLICY]
  return nonce === undefined
    ? state.header({ sources })
    : state.header({ sources: `${sources} 'nonce-${nonce}'`, nonce })
}

/** The per-request nonce source for a page executor under `policy`: generated eagerly so `meta` can
 * name it in `unsafeInlineScript`, and dropped by the renderer from documents that do not need it. */
export const cspNonceResolver = (policy: CspPolicy): NonceResolver =>
  createNonceResolver({ generate: () => policy[CSP_POLICY].generate() })

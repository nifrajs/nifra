import {
  type CookieOptions,
  type ResponseResult,
  status as statusResult,
} from "@nifrajs/core/server"
import type { LoaderResponseControls } from "../manifest.ts"
import { DATA_HEADER } from "../router.ts"
import { isResponseResult } from "./render-document.ts"

/** The serving app's response controls - the structural subset of a route handler's `c.set` used here. */
export interface CoreResponseControls {
  readonly headers: Record<string, string>
  cookie(name: string, value: string, options?: CookieOptions): void
  deleteCookie(name: string, options?: Pick<CookieOptions, "path" | "domain">): void
}

export const PRIVATE_NO_STORE = "private, no-store"

/**
 * Headers of a navigation data response. It shares its URL with the document and differs only by a
 * request header, so it must never be stored by a cache keyed on the URL alone: a stored data payload
 * would be served in place of the page.
 */
export const DATA_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": PRIVATE_NO_STORE,
  vary: DATA_HEADER,
})

/** Merge order of the header writers: layouts root to leaf, then the page loader, then the action. */
export const PAGE_SCOPE = 1e9
export const ACTION_SCOPE = PAGE_SCOPE + 1

// RFC 9110 `token` and `field-value` (visible ASCII, space, tab, obs-text). A value outside this set
// could split the header block or be rejected by the transport after the loader already ran.
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/

const FRAMEWORK_PREFIX = "x-nifra-"

const TRANSPORT_OWNED = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

const reservedReason = (name: string): string | undefined => {
  if (name === "set-cookie") return "use ctx.set.cookie(), which applies the secure cookie defaults"
  if (name === "location") return "return redirect() instead"
  if (name === "content-type") return "the framework sets it for the representation it renders"
  if (TRANSPORT_OWNED.has(name)) return "the transport owns it"
  if (name.startsWith(FRAMEWORK_PREFIX)) return "the x-nifra- prefix is reserved for the framework"
  return undefined
}

/** `existing` with the data-request header added, so a cache keeps the document and its data apart. */
export function varyOnDataHeader(existing: string | null | undefined): string {
  if (existing === null || existing === undefined) return DATA_HEADER
  let empty = true
  for (const part of existing.split(",")) {
    const name = part.trim().toLowerCase()
    if (name === "") continue
    if (name === "*" || name === DATA_HEADER) return existing
    empty = false
  }
  return empty ? DATA_HEADER : `${existing}, ${DATA_HEADER}`
}

const CACHE_CONTROL = "cache-control"

/** Headers of a rendered page that carries a cookie queued through `ctx.set`. */
export const PRIVATE_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  [CACHE_CONTROL]: PRIVATE_NO_STORE,
})

/**
 * `outcome` kept out of shared caches, for a request that queued a cookie through `ctx.set`.
 *
 * A rendered page is already private, and a plain render (`redirect()`, `status()`) inherits the
 * serving app's header record. That leaves a hand-built `Response`, which inherits nothing, and a
 * plain render that names its own `cache-control`, which would win over the inherited one.
 */
export function privateOutcome(outcome: unknown): unknown {
  if (outcome instanceof Response) return privateResponse(outcome)
  if (!isResponseResult(outcome)) return outcome
  const plain = outcome.plain
  const own = plain?.headers
  if (plain === undefined || own === undefined) return outcome
  let headers: Record<string, string> | undefined
  for (const name of Object.keys(own)) {
    if (name.toLowerCase() !== CACHE_CONTROL) continue
    headers ??= { ...own }
    delete headers[name]
  }
  if (headers === undefined) return outcome
  headers[CACHE_CONTROL] = PRIVATE_NO_STORE
  return statusResult(plain.status, plain.body, { headers }) satisfies ResponseResult
}

function privateResponse(response: Response): Response {
  if (response.headers.get(CACHE_CONTROL) === PRIVATE_NO_STORE) return response
  try {
    response.headers.set(CACHE_CONTROL, PRIVATE_NO_STORE)
    return response
  } catch {
    // Immutable headers (`Response.redirect()`, a `fetch()` result): answer with a copy.
    const headers = new Headers(response.headers)
    headers.set(CACHE_CONTROL, PRIVATE_NO_STORE)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

interface WrittenHeaders {
  readonly order: number
  readonly headers: Record<string, string>
}

/**
 * One page request's `ctx.set`: the response headers and cookies its loaders and action write.
 *
 * Every loader gets its own header record ({@link scope}), merged in a fixed order when the response
 * is committed, so layout loaders that run in parallel with the page loader cannot race on a name.
 * Cookies go straight to the serving app's own controls, which serialize them with the secure defaults
 * and append them to whatever the request answers with.
 */
export class PageResponseControls {
  readonly #c: { readonly set: CoreResponseControls }
  #written: WrittenHeaders[] | undefined
  #sealed = false
  #personalized = false

  constructor(c: { readonly set: CoreResponseControls }) {
    this.#c = c
  }

  /** True once a cookie was queued through `ctx.set`: the response is specific to this visitor. */
  get personalized(): boolean {
    return this.#personalized
  }

  /** The `ctx.set` of one loader or action. `order` fixes where its headers land in the merge. */
  scope(order: number): LoaderResponseControls {
    return new ScopedResponseControls(this, order)
  }

  /** A scope's header record, created on first use. */
  track(order: number): Record<string, string> {
    const headers = Object.create(null) as Record<string, string>
    this.#written ??= []
    this.#written.push({ order, headers })
    return headers
  }

  /** The serving app's controls, marked as carrying per-visitor state. Throws once sealed. */
  cookies(member: string): CoreResponseControls {
    this.assertOpen(member)
    const set = this.#c.set
    if (!this.#personalized) {
      this.#personalized = true
      // A redirect or status render merges the serving app's header record, so this keeps those
      // outcomes out of shared caches too (a 301 is cacheable by default).
      set.headers["cache-control"] = PRIVATE_NO_STORE
    }
    return set
  }

  assertOpen(member: string): void {
    if (!this.#sealed) return
    throw new Error(
      `[nifra/web] ctx.set.${member} was used after the response was committed. Write response headers and cookies before the loader or action returns - a deferred promise settles too late.`,
    )
  }

  /**
   * Close the controls: the response is decided. A later write - a deferred promise that settles after
   * the loader returned - throws instead of being dropped without a trace.
   */
  seal(): void {
    if (this.#sealed) return
    this.#sealed = true
    if (this.#written === undefined) return
    for (const entry of this.#written) Object.freeze(entry.headers)
  }

  /**
   * Seal, validate, and merge every written header. Returns `undefined` when none was written.
   * Throws on a name or value that cannot be sent, and on a name the framework or transport owns.
   */
  commit(): Record<string, string> | undefined {
    this.seal()
    const written = this.#written
    if (written === undefined) return undefined
    if (written.length > 1) written.sort((a, b) => a.order - b.order)
    let merged: Record<string, string> | undefined
    for (const entry of written) {
      for (const rawName of Object.keys(entry.headers)) {
        const name = validHeaderName(rawName)
        merged ??= Object.create(null) as Record<string, string>
        merged[name] = validHeaderValue(name, entry.headers[rawName])
      }
    }
    return merged
  }

  /**
   * The committed headers for the document. Written headers make the document vary on the
   * data-request header; a queued cookie makes it private, whatever a loader asked for.
   */
  documentHeaders(): Record<string, string> | undefined {
    const written = this.commit()
    if (written !== undefined) written.vary = varyOnDataHeader(written.vary)
    if (!this.#personalized) return written
    const headers = written ?? (Object.create(null) as Record<string, string>)
    headers["cache-control"] = PRIVATE_NO_STORE
    return headers
  }
}

class ScopedResponseControls implements LoaderResponseControls {
  readonly #owner: PageResponseControls
  readonly #order: number
  #headers: Record<string, string> | undefined

  constructor(owner: PageResponseControls, order: number) {
    this.#owner = owner
    this.#order = order
  }

  get headers(): Record<string, string> {
    this.#owner.assertOpen("headers")
    this.#headers ??= this.#owner.track(this.#order)
    return this.#headers
  }

  cookie(name: string, value: string, options?: CookieOptions): void {
    this.#owner.cookies("cookie()").cookie(name, value, options)
  }

  deleteCookie(name: string, options?: Pick<CookieOptions, "path" | "domain">): void {
    this.#owner.cookies("deleteCookie()").deleteCookie(name, options)
  }
}

function validHeaderName(rawName: string): string {
  if (!TOKEN.test(rawName)) {
    throw new Error(
      `[nifra/web] ctx.set.headers: ${JSON.stringify(rawName)} is not a valid header name`,
    )
  }
  const name = rawName.toLowerCase()
  const reason = reservedReason(name)
  if (reason !== undefined) {
    throw new Error(`[nifra/web] ctx.set.headers: "${name}" is reserved - ${reason}`)
  }
  return name
}

// The message names the header only: a value can carry a token or a visitor's data.
function validHeaderValue(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`[nifra/web] ctx.set.headers: the value of "${name}" must be a string`)
  }
  if (!FIELD_VALUE.test(value)) {
    throw new Error(
      `[nifra/web] ctx.set.headers: the value of "${name}" contains a character a header cannot carry (a line break, a control character, or one outside Latin-1)`,
    )
  }
  return value
}

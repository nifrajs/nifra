/**
 * Live data refresh, server side. Loaders declare what their data depends on with `ctx.live(...keys)`;
 * a live load returns an encrypted grant for those keys, and the client reloads through the same
 * authorized path whenever one of them changes. Data never travels with a change notice.
 *
 * ```ts
 * import { live } from "@nifrajs/web/live"
 *
 * const liveRuntime = live({ secret: process.env.LIVE_SECRET, subject: (ctx) => sessionUserId(ctx.request) })
 * createWebApp({ ...options, live: liveRuntime })
 * ```
 *
 * Every live load is a `POST` to the load endpoint that runs the target page as a `GET` through the
 * whole app: every hook, middleware, gate and loader sees the target path, exactly as a navigation.
 */
import { isSameOriginForm, replacedRequestOf } from "@nifrajs/core/server"
import {
  LIVE_ATTACH,
  type LiveAttachInput,
  type LiveAttachment,
  type LiveEnvelope,
  type LiveFinish,
  type LiveLoad,
  type LiveRuntimeHandle,
} from "./internal/live-contract.ts"
import {
  assertLiveSecrets,
  createKeyring,
  type GrantClaims,
  type GrantOwner,
  KEY_PATTERN,
  type Keyring,
  MAX_GRANT_CHARS,
  MAX_KEYS_PER_FRAME,
  type OpenedGrant,
  SID_PATTERN,
  toBase64Url,
} from "./live/keyring.ts"
import type { LoaderContext } from "./manifest.ts"
import { DATA_HEADER, NAV_FROM_HEADER, RETAIN_HEADER } from "./router.ts"

export interface LiveOptions {
  /**
   * The grant secret, or a rotation list with the newest first (at most 3, each at least 32 bytes).
   * Required in production; development falls back to a random per-process secret.
   */
  readonly secret?: string | readonly string[] | undefined
  /**
   * Who the viewer is: a stable id, or `null` for an anonymous viewer. Called once per live load,
   * after middleware. A grant is only honored for the subject it was issued to.
   */
  readonly subject: (ctx: LoaderContext) => string | null | Promise<string | null>
  /** Separates this app's tags from another app's that shares a secret. Default `"nifra"`. */
  readonly appId?: string
  /** Grant lifetime in seconds. Default 600. */
  readonly grantTtl?: number
  /** The live load endpoint. Default `/_nifra/live/load`. */
  readonly loadPath?: string
  /** Origins besides the app's own that may call the load endpoint. */
  readonly trustedOrigins?: readonly string[]
  /** Live loads running at once in this process; past it the endpoint answers 503. Default 64. */
  readonly maxConcurrentLoads?: number
  /**
   * Re-check the keys of owners a load keeps without running their loaders. With it, `renew`
   * re-signs a grant without loaders; without it, `renew` runs a full load. `false` issues no grant.
   */
  readonly authorize?: (keys: readonly string[], ctx: LoaderContext) => boolean | Promise<boolean>
}

/** A live runtime: pass it to `createWebApp({ live })`. */
export interface Live extends LiveRuntimeHandle {
  /** Resolves once the secrets are derived; rejects when two of them share a secret id. */
  readonly ready: Promise<void>
  /** Refuse every grant issued to `subject` before now. */
  revoke(subject: string): Promise<void>
  /** Refuse every grant issued before now. */
  revokeAll(): Promise<void>
  /**
   * Access to `key` was removed (for everyone, or for one subject): no grant issued before now keeps or
   * re-signs it, so the next load runs that owner's loader, which decides again.
   */
  revokeKey(key: string, subject?: string): Promise<void>
}

const DEFAULT_LOAD_PATH = "/_nifra/live/load"
const DEFAULT_TTL_SECONDS = 600
const DEFAULT_MAX_LOADS = 64
const DEFAULT_APP_ID = "nifra"
const MAX_BODY_BYTES = 65_536
const MAX_PATH_CHARS = 2048
const MAX_GRANTS = 3
const MAX_RETAIN = 64
const MAX_OWNER_CHARS = 512
const PAGE_FRAME = "page"

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]
const BODY_HEADERS = ["content-length", "content-type", "content-encoding"]
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const NO_STORE = "private, no-store"

interface LoadBody {
  readonly path: string
  readonly sid: string
  readonly frame: string
  readonly mode: "load" | "renew"
  readonly retain: readonly string[]
  readonly grants: readonly string[]
}

interface Stamp {
  readonly seq: number
  readonly at: number
}

/** Create the live runtime for one app. */
export function live(options: LiveOptions): Live {
  if (typeof options.subject !== "function") {
    throw new TypeError("[nifra/web] live: `subject` must be a function returning a string or null")
  }
  const ttl = options.grantTtl ?? DEFAULT_TTL_SECONDS
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 86_400) {
    throw new TypeError(
      "[nifra/web] live: `grantTtl` must be a whole number of seconds from 60 to 86400",
    )
  }
  const maxLoads = options.maxConcurrentLoads ?? DEFAULT_MAX_LOADS
  if (!Number.isSafeInteger(maxLoads) || maxLoads < 1) {
    throw new TypeError("[nifra/web] live: `maxConcurrentLoads` must be a positive whole number")
  }
  const loadPath = options.loadPath ?? DEFAULT_LOAD_PATH
  if (!loadPath.startsWith("/") || loadPath.startsWith("//") || /[?#\s]/.test(loadPath)) {
    throw new TypeError("[nifra/web] live: `loadPath` must be an absolute path with no query")
  }
  const appId = options.appId ?? DEFAULT_APP_ID
  if (typeof appId !== "string" || appId === "" || appId.length > 128) {
    throw new TypeError(
      "[nifra/web] live: `appId` must be a non-empty string of at most 128 characters",
    )
  }
  const secrets = secretsOf(options.secret)
  assertLiveSecrets(secrets)
  const keyring = createKeyring({ secrets, appId, ttl })
  const trusted = new Set(options.trustedOrigins ?? [])
  const authorize = options.authorize
  const subjectOf = options.subject
  const production = isProduction()

  // In-process sequence and revocation log. Phase 3 replaces both with the bus.
  let seq = 0
  let revokedAll: Stamp | undefined
  const revokedSubjects = new Map<string, Stamp>()
  const revokedKeys = new Map<string, Stamp>()
  const revokedSubjectKeys = new Map<string, Map<string, Stamp>>()
  const stamp = (): Stamp => {
    seq++
    const at = Date.now()
    // A revocation older than one grant lifetime can refuse nothing: every grant issued before it
    // has expired.
    const horizon = at - ttl * 1000
    for (const map of [revokedSubjects, revokedKeys]) {
      for (const [name, entry] of map) if (entry.at < horizon) map.delete(name)
    }
    for (const [key, subjects] of revokedSubjectKeys) {
      for (const [name, entry] of subjects) if (entry.at < horizon) subjects.delete(name)
      if (subjects.size === 0) revokedSubjectKeys.delete(key)
    }
    return { seq, at }
  }
  const above = (entry: Stamp | undefined, s: number): boolean =>
    entry !== undefined && entry.seq > s
  const grantRevoked = (claims: GrantClaims): boolean =>
    above(revokedAll, claims.s) ||
    (claims.sub !== null && above(revokedSubjects.get(claims.sub), claims.s))
  const keyRevoked = (key: string, claims: GrantClaims): boolean =>
    above(revokedKeys.get(key), claims.s) ||
    (claims.sub !== null && above(revokedSubjectKeys.get(key)?.get(claims.sub), claims.s))

  let inflight = 0
  let entering = 0

  const attach = (input: LiveAttachInput): LiveAttachment => {
    const loads = new WeakMap<Request, LoadState>()

    const admitLoad = async (req: Request): Promise<Request | Response> => {
      const origin = req.headers.get("origin")
      if (
        origin === null ||
        !(trusted.has(origin) || isSameOriginForm(origin, req.headers.get("sec-fetch-site"), req))
      ) {
        return refusal(403, "forbidden_origin")
      }
      const type = req.headers.get("content-type")
      if (type === null || mediaType(type) !== "application/json") {
        return refusal(415, "unsupported_media_type")
      }
      if (inflight + entering >= maxLoads) return busy()
      // Reading the body and opening grants count too: forged grants cannot buy unbounded key
      // derivation.
      entering++
      try {
        return await prepareLoad(req)
      } finally {
        entering--
      }
    }

    const prepareLoad = async (req: Request): Promise<Request | Response> => {
      const text = await readCapped(req, MAX_BODY_BYTES)
      if (typeof text === "number") return refusal(text, text === 413 ? "too_large" : "bad_request")
      const body = parseBody(text)
      if (body === undefined) return refusal(400, "bad_request")
      const path = canonicalPath(body.path, req.url)
      if (path === undefined) return refusal(400, "bad_path")
      const ring = await keyring
      // Read before any hook, middleware or loader runs: every owner loaded fresh is at least this new.
      const loadSeq = seq
      const match = input.matchRoute(path)
      const now = Date.now()
      let grant: OpenedGrant | undefined
      for (const token of body.grants) {
        const opened = await ring.open(token, now)
        if (opened === undefined) continue
        const claims = opened.claims
        if (claims.sid !== body.sid || claims.path !== path || claims.frame !== body.frame) continue
        if (grantRevoked(claims)) continue
        grant = opened
        break
      }
      const requested =
        grant === undefined
          ? []
          : body.mode === "load"
            ? body.retain
            : authorize === undefined
              ? []
              : Object.keys(grant.claims.owners)
      const layouts: number[] = []
      let retainPage = false
      if (grant !== undefined && match !== null) {
        const claims = grant.claims
        for (const owner of requested) {
          const held = Object.hasOwn(claims.owners, owner) ? claims.owners[owner] : undefined
          if (held === undefined) continue
          // A key revoked since issuance is never kept or re-signed: its loader runs and decides again.
          if (held.k.some((key) => keyRevoked(key, claims))) continue
          if (owner.startsWith("L:")) {
            const index = match.layoutIds.indexOf(owner.slice(2))
            if (index !== -1 && !layouts.includes(index)) layouts.push(index)
          } else if (owner === `P:${match.routeId}`) {
            retainPage = true
          }
        }
      }
      const headers = internalHeaders(req.headers)
      if (layouts.length > 0) {
        headers.set(RETAIN_HEADER, layouts.sort((a, b) => a - b).join(","))
        headers.set(NAV_FROM_HEADER, path)
      }
      const target = new Request(new URL(path, req.url), {
        method: "GET",
        headers,
        signal: req.signal,
      })
      loads.set(
        target,
        new LoadState(ring, body, path, loadSeq, grant, match?.routeId ?? "", retainPage),
      )
      return target
    }

    return {
      onRequest: (req) =>
        req.method === "POST" && pathnameOf(req.url) === loadPath ? admitLoad(req) : undefined,
      loadOf: (req) => {
        // An app hook after the endpoint may hand on a replacement; the load is its original's.
        let current: Request | undefined = req
        for (let hops = 0; current !== undefined && hops < 16; hops++) {
          const load = loads.get(current)
          if (load !== undefined) return load
          current = replacedRequestOf(current)
        }
        return undefined
      },
    }
  }

  class LoadState implements LiveLoad {
    retainPage: boolean
    private subject: string | null = null
    private admitted = false
    private released = false
    private declared = 0
    /** Keys past the frame budget: counted for the log, never stored. */
    private dropped = 0
    private readonly collectors = new Map<string, { keys: Set<string>; sealed: boolean }>()

    constructor(
      private readonly ring: Keyring,
      private readonly body: LoadBody,
      private readonly path: string,
      private readonly seq: number,
      private readonly grant: OpenedGrant | undefined,
      readonly routeId: string,
      retainPage: boolean,
    ) {
      this.retainPage = retainPage
    }

    admit(): Response | undefined {
      if (inflight >= maxLoads) return busy()
      inflight++
      this.admitted = true
      return undefined
    }

    release(): void {
      if (!this.admitted || this.released) return
      this.released = true
      inflight--
    }

    settle(response: Response): Response {
      if (
        response.body !== null &&
        mediaType(response.headers.get("content-type") ?? "") === "application/x-ndjson"
      ) {
        // Deferred values are still loading while the body streams: the slot is held until it ends.
        return new Response(
          releasing(response.body, () => this.release()),
          response,
        )
      }
      this.release()
      return response
    }

    async bind(ctx: LoaderContext): Promise<boolean> {
      const subject = await subjectOf(ctx)
      if (subject !== null && typeof subject !== "string") {
        throw new TypeError("[nifra/web] live: `subject` must return a string or null")
      }
      this.subject = subject
      if (this.grant === undefined || this.grant.claims.sub === subject) return true
      this.retainPage = false
      return false
    }

    collector(owner: string): (...keys: string[]) => void {
      let entry = this.collectors.get(owner)
      if (entry === undefined) {
        entry = { keys: new Set(), sealed: false }
        this.collectors.set(owner, entry)
      }
      const collected = entry
      return (...keys) => {
        if (collected.sealed) {
          throw new TypeError(
            `[nifra/web] ctx.live() was called after the loader of "${owner}" settled; declare keys before the loader returns`,
          )
        }
        for (const key of keys) {
          if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
            throw new TypeError(
              "[nifra/web] ctx.live() keys are a letter followed by up to 127 of A-Z a-z 0-9 . _ : / -",
            )
          }
          if (collected.keys.has(key)) continue
          if (this.declared >= MAX_KEYS_PER_FRAME) {
            if (!production) {
              throw new RangeError(
                `[nifra/web] a live frame holds at most ${MAX_KEYS_PER_FRAME} keys; "${owner}" declared one more`,
              )
            }
            this.dropped++
            continue
          }
          collected.keys.add(key)
          this.declared++
        }
      }
    }

    seal(owner: string): void {
      const entry = this.collectors.get(owner)
      if (entry !== undefined) entry.sealed = true
    }

    async finish(input: LiveFinish): Promise<LiveEnvelope> {
      for (const entry of this.collectors.values()) entry.sealed = true
      const subject = await this.ring.subjectTag(this.subject)
      const pageRetained = input.retained.some((owner) => owner.startsWith("P:"))
      const bare: LiveEnvelope = pageRetained ? { subject, page: "retained" } : { subject }
      const owners: Record<string, GrantOwner> = {}
      const carried = new Set<string>()
      for (const owner of input.retained) {
        const held =
          this.grant !== undefined && Object.hasOwn(this.grant.claims.owners, owner)
            ? this.grant.claims.owners[owner]
            : undefined
        // Kept data with no grant behind it cannot be vouched for.
        if (held === undefined) return bare
        owners[owner] = { k: held.k, w: held.w }
        for (const key of held.k) carried.add(key)
      }
      if (
        carried.size > 0 &&
        authorize !== undefined &&
        !(await authorize([...carried], input.ctx))
      ) {
        return bare
      }
      let count = this.dropped
      for (const owner of input.fresh) {
        const keys = [...(this.collectors.get(owner)?.keys ?? [])]
        owners[owner] = { k: keys, w: this.seq }
      }
      for (const owner of Object.values(owners)) count += owner.k.length
      if (count > MAX_KEYS_PER_FRAME) {
        if (!production) {
          throw new RangeError(
            `[nifra/web] a live frame holds at most ${MAX_KEYS_PER_FRAME} keys; route "${this.routeId}" declared ${count}`,
          )
        }
        console.error(
          `[nifra/web] live: route "${this.routeId}" declared ${count} keys, over the ${MAX_KEYS_PER_FRAME}-key frame budget; no grant issued, the client polls`,
        )
        return bare
      }
      const grant = await this.ring.seal(
        {
          sid: this.body.sid,
          sub: this.subject,
          path: this.path,
          frame: this.body.frame,
          owners,
          s: this.seq,
        },
        Date.now(),
      )
      if (grant === undefined) {
        console.error(
          `[nifra/web] live: the grant for route "${this.routeId}" exceeds ${MAX_GRANT_CHARS} characters; no grant issued, the client polls`,
        )
        return bare
      }
      const keys = [...new Set(Object.values(owners).flatMap((owner) => owner.k))]
      const tags: Record<string, string[]> = {}
      for (const key of keys) {
        const owning: string[] = []
        for (const [name, owner] of Object.entries(owners))
          if (owner.k.includes(key)) owning.push(name)
        tags[await this.ring.tag(key)] = owning
      }
      return { ...bare, grant, tags }
    }
  }

  return {
    ready: keyring.then(() => undefined),
    async revoke(subject) {
      if (typeof subject !== "string")
        throw new TypeError("[nifra/web] live.revoke takes a subject")
      revokedSubjects.set(subject, stamp())
    },
    async revokeAll() {
      revokedAll = stamp()
    },
    async revokeKey(key, subject) {
      if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
        throw new TypeError("[nifra/web] live.revokeKey takes a key in the ctx.live() charset")
      }
      const entry = stamp()
      if (subject === undefined) {
        revokedKeys.set(key, entry)
        return
      }
      let subjects = revokedSubjectKeys.get(key)
      if (subjects === undefined) {
        subjects = new Map()
        revokedSubjectKeys.set(key, subjects)
      }
      subjects.set(subject, entry)
    },
    [LIVE_ATTACH]: attach,
  }
}

function secretsOf(secret: LiveOptions["secret"]): readonly unknown[] {
  if (secret === undefined || (Array.isArray(secret) && secret.length === 0) || secret === "") {
    if (isProduction()) {
      throw new TypeError(
        "[nifra/web] live: `secret` is required in production. Generate one with: openssl rand -base64 32",
      )
    }
    return [toBase64Url(crypto.getRandomValues(new Uint8Array(32)))]
  }
  return typeof secret === "string" ? [secret] : secret
}

const isProduction = (): boolean =>
  typeof process !== "undefined" && process.env?.NODE_ENV === "production"

const mediaType = (value: string): string => {
  const end = value.indexOf(";")
  return (end === -1 ? value : value.slice(0, end)).trim().toLowerCase()
}

function pathnameOf(url: string): string {
  const start = url.indexOf("/", url.indexOf("//") + 2)
  if (start === -1) return "/"
  const query = url.indexOf("?", start)
  return query === -1 ? url.slice(start) : url.slice(start, query)
}

function refusal(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "cache-control": NO_STORE } })
}

function busy(): Response {
  return Response.json(
    { error: "live_load_busy" },
    {
      status: 503,
      headers: {
        "cache-control": NO_STORE,
        "retry-after": String(1 + Math.floor(Math.random() * 3)),
      },
    },
  )
}

/** The body as text, or the status to refuse it with. */
async function readCapped(req: Request, max: number): Promise<string | 400 | 413> {
  const declared = req.headers.get("content-length")
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return 400
    if (Number(declared) > max) return 413
  }
  if (req.body === null) return ""
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await Promise.allSettled([reader.cancel()])
      return 413
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return 400
  }
}

function parseBody(text: string): LoadBody | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const { path, sid, frame, mode, retain = [], grants = [] } = value
  if (typeof path !== "string" || typeof sid !== "string" || !SID_PATTERN.test(sid))
    return undefined
  // Phase 2 serves the page frame; boundary frames arrive with the client's frame support.
  if (frame !== PAGE_FRAME || (mode !== "load" && mode !== "renew")) return undefined
  if (!isStringList(retain, MAX_RETAIN, MAX_OWNER_CHARS)) return undefined
  if (!isStringList(grants, MAX_GRANTS, MAX_GRANT_CHARS)) return undefined
  return { path, sid, frame, mode, retain, grants }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isStringList = (value: unknown, max: number, chars: number): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((item) => typeof item === "string" && item.length <= chars)

/** `path` when it is already the canonical same-origin `pathname + search`; anything else is refused. */
function canonicalPath(path: string, base: string): string | undefined {
  if (path.length > MAX_PATH_CHARS || !path.startsWith("/") || path.startsWith("//"))
    return undefined
  // An absolute path against a request URL always parses: the parser normalises, it never throws.
  const url = new URL(path, base)
  const canonical = url.pathname + url.search
  return url.origin === new URL(base).origin && canonical === path ? canonical : undefined
}

/**
 * The headers the router's own data request for the target would carry: the POST's, without the
 * hop-by-hop, body and `origin` headers a same-origin GET does not send, and without any `x-nifra-*`
 * the client sent. `sec-fetch-*` pass through: a browser's fetch sends the same values for both.
 */
function internalHeaders(post: Headers): Headers {
  const headers = new Headers(post)
  const nominated = headers.get("connection")
  if (nominated !== null) {
    for (const name of nominated.split(",")) {
      const trimmed = name.trim()
      if (TOKEN.test(trimmed)) headers.delete(trimmed)
    }
  }
  for (const name of HOP_BY_HOP) headers.delete(name)
  for (const name of BODY_HEADERS) headers.delete(name)
  headers.delete("origin")
  const own: string[] = []
  headers.forEach((_value, name) => {
    if (name.startsWith("x-nifra-")) own.push(name)
  })
  for (const name of own) headers.delete(name)
  headers.set(DATA_HEADER, "1")
  return headers
}

function releasing(body: ReadableStream<Uint8Array>, done: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Released on the last chunk and on a read that throws: only an enqueue keeps the slot.
      let finished = true
      try {
        const chunk = await reader.read()
        if (chunk.done) controller.close()
        else {
          finished = false
          controller.enqueue(chunk.value)
        }
      } finally {
        if (finished) done()
      }
    },
    cancel(reason) {
      done()
      return reader.cancel(reason)
    },
  })
}

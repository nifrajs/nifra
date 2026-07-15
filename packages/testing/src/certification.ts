/**
 * Profile-based adapter certification. Profiles are structural and dependency-free: an adapter package
 * uses this only in its test/CI surface, while the resulting capability matrix is portable JSON evidence.
 */

export interface CertificationContext {
  /** Deterministic per-check key safe for shared test backends and stable re-runs. */
  readonly key: (suffix: string) => string
}

export interface CertificationCheck<Adapter> {
  readonly id: string
  readonly capability: string
  readonly run: (adapter: Adapter, context: CertificationContext) => void | Promise<void>
}

export interface AdapterCertificationProfile<Adapter> {
  readonly id: string
  readonly version: number
  readonly capabilities: readonly string[]
  readonly checks: readonly CertificationCheck<Adapter>[]
}

export interface CertificationCheckEvidence {
  readonly id: string
  readonly capability: string
  readonly ok: boolean
  /** Error class only. Messages may contain credentials/provider payloads and are never evidence. */
  readonly errorName?: string
}

export interface CertificationCapabilityEvidence {
  readonly capability: string
  readonly status: "passed" | "failed"
  readonly checks: readonly string[]
}

export interface AdapterCertificationReport {
  readonly schemaVersion: 1
  readonly ok: boolean
  readonly profile: { readonly id: string; readonly version: number }
  readonly adapterId: string
  readonly checks: readonly CertificationCheckEvidence[]
  readonly capabilities: readonly CertificationCapabilityEvidence[]
  readonly evidenceHash: string
}

export class AdapterCertificationError extends Error {
  constructor(readonly report: AdapterCertificationReport) {
    const failed = report.checks.filter((check) => !check.ok).map((check) => check.id)
    super(`adapter ${report.adapterId} failed ${report.profile.id}: ${failed.join(", ")}`)
    this.name = "AdapterCertificationError"
  }
}

const TOKEN = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const MAX_CHECKS = 128

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value)
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function validateProfile<Adapter>(profile: AdapterCertificationProfile<Adapter>): void {
  if (!TOKEN.test(profile.id))
    throw new TypeError("certification profile id must be a bounded token")
  if (!Number.isInteger(profile.version) || profile.version < 1)
    throw new TypeError("certification profile version must be a positive integer")
  if (profile.checks.length < 1 || profile.checks.length > MAX_CHECKS)
    throw new RangeError(`certification profile must contain 1-${MAX_CHECKS} checks`)
  const capabilities = new Set(profile.capabilities)
  if (capabilities.size !== profile.capabilities.length)
    throw new TypeError("certification profile capability names must be unique")
  const ids = new Set<string>()
  for (const capability of capabilities) {
    if (!TOKEN.test(capability))
      throw new TypeError("certification capability must be a bounded token")
  }
  for (const check of profile.checks) {
    if (!TOKEN.test(check.id) || ids.has(check.id))
      throw new TypeError("certification check ids must be unique bounded tokens")
    if (!capabilities.has(check.capability))
      throw new TypeError(
        `certification check ${check.id} names undeclared capability ${check.capability}`,
      )
    ids.add(check.id)
  }
  for (const capability of capabilities) {
    if (!profile.checks.some((check) => check.capability === capability))
      throw new TypeError(`certification capability has no checks: ${capability}`)
  }
}

/** Define and validate a custom domain/provider profile at module initialization. */
export function defineCertificationProfile<Adapter>(
  profile: AdapterCertificationProfile<Adapter>,
): AdapterCertificationProfile<Adapter> {
  validateProfile(profile)
  return profile
}

export async function certifyAdapter<Adapter>(options: {
  readonly profile: AdapterCertificationProfile<Adapter>
  readonly adapterId: string
  /** A fresh adapter per check prevents one failed check from contaminating the next. */
  readonly createAdapter: () => Adapter | Promise<Adapter>
  readonly cleanup?: (adapter: Adapter) => void | Promise<void>
}): Promise<AdapterCertificationReport> {
  validateProfile(options.profile)
  if (!TOKEN.test(options.adapterId)) throw new TypeError("adapter id must be a bounded token")
  const checks: CertificationCheckEvidence[] = []
  for (const check of options.profile.checks) {
    let adapter: Adapter | undefined
    try {
      adapter = await options.createAdapter()
      await check.run(adapter, {
        key: (suffix) =>
          `nifra-cert:${options.profile.id}:${options.adapterId}:${check.id}:${suffix}`,
      })
      checks.push({ id: check.id, capability: check.capability, ok: true })
    } catch (error) {
      checks.push({
        id: check.id,
        capability: check.capability,
        ok: false,
        errorName:
          error instanceof Error && TOKEN.test(error.name.toLowerCase())
            ? error.name
            : "AdapterError",
      })
    } finally {
      if (adapter !== undefined && options.cleanup !== undefined) {
        try {
          await options.cleanup(adapter)
        } catch {
          // Cleanup cannot turn a failed functional check into success, and provider messages are not
          // persisted. Adapter suites should make cleanup idempotent and observable separately.
        }
      }
    }
  }
  const capabilities = options.profile.capabilities.map((capability) => {
    const ids = checks.filter((check) => check.capability === capability)
    return {
      capability,
      status: ids.every((check) => check.ok) ? ("passed" as const) : ("failed" as const),
      checks: ids.map((check) => check.id),
    }
  })
  const body = {
    schemaVersion: 1 as const,
    ok: checks.every((check) => check.ok),
    profile: { id: options.profile.id, version: options.profile.version },
    adapterId: options.adapterId,
    checks,
    capabilities,
  }
  return { ...body, evidenceHash: await sha256(canonical(body)) }
}

export function assertAdapterCertification(report: AdapterCertificationReport): void {
  if (!report.ok) throw new AdapterCertificationError(report)
}

/** Recompute the portable evidence hash. Consumers should verify before trusting a stored report. */
export async function verifyAdapterCertification(
  report: AdapterCertificationReport,
): Promise<boolean> {
  const { evidenceHash, ...body } = report
  return evidenceHash === (await sha256(canonical(body)))
}

// ── Standard profiles ───────────────────────────────────────────────────────────────────────────

export interface CertifiableCacheEntry {
  readonly value: unknown
  readonly staleAt: number
  readonly expiresAt: number
}

export interface CertifiableCacheStore {
  get(key: string): CertifiableCacheEntry | undefined | Promise<CertifiableCacheEntry | undefined>
  set(key: string, entry: CertifiableCacheEntry, tags: readonly string[]): void | Promise<void>
  delete(key: string): void | Promise<void>
  invalidateTag(tag: string): void | Promise<void>
  clear(): void | Promise<void>
}

export function cacheStoreCertificationProfile(): AdapterCertificationProfile<CertifiableCacheStore> {
  const entry = (value: unknown): CertifiableCacheEntry => ({
    value,
    staleAt: 5_000_000,
    expiresAt: 6_000_000,
  })
  return {
    id: "cache-store",
    version: 1,
    capabilities: ["roundtrip", "tag-invalidation", "clear"],
    checks: [
      {
        id: "set-get-delete",
        capability: "roundtrip",
        async run(store, context) {
          const key = context.key("roundtrip")
          await store.set(key, entry({ answer: 42 }), [])
          const found = await store.get(key)
          if (JSON.stringify(found?.value) !== '{"answer":42}') throw new Error("CacheRoundtrip")
          await store.delete(key)
          if ((await store.get(key)) !== undefined) throw new Error("CacheDelete")
        },
      },
      {
        id: "invalidate-tag",
        capability: "tag-invalidation",
        async run(store, context) {
          const tagged = context.key("tagged")
          const other = context.key("other")
          const tag = context.key("tag")
          await store.set(tagged, entry(1), [tag])
          await store.set(other, entry(2), [context.key("other-tag")])
          await store.invalidateTag(tag)
          if ((await store.get(tagged)) !== undefined || (await store.get(other))?.value !== 2)
            throw new Error("CacheTagInvalidation")
        },
      },
      {
        id: "clear",
        capability: "clear",
        async run(store, context) {
          const key = context.key("clear")
          await store.set(key, entry(1), [])
          await store.clear()
          if ((await store.get(key)) !== undefined) throw new Error("CacheClear")
        },
      },
    ],
  }
}

export interface CertifiableStoredJob {
  readonly id: string
  readonly name: string
  readonly payload: unknown
  readonly attempt: number
  readonly maxAttempts: number
}

export interface CertifiableJobStore {
  enqueue(job: {
    name: string
    payload: unknown
    runAt: number
    maxAttempts: number
  }): string | Promise<string>
  lease(
    now: number,
    limit: number,
    leaseMs: number,
  ): CertifiableStoredJob[] | Promise<CertifiableStoredJob[]>
  complete(id: string): void | Promise<void>
  retry(id: string, runAt: number): void | Promise<void>
  deadLetter(id: string, error: string): void | Promise<void>
  counts():
    | { pending: number; active: number; dead: number }
    | Promise<{
        pending: number
        active: number
        dead: number
      }>
}

export function jobStoreCertificationProfile(): AdapterCertificationProfile<CertifiableJobStore> {
  return {
    id: "job-store",
    version: 1,
    capabilities: ["lease-complete", "retry-schedule", "dead-letter"],
    checks: [
      {
        id: "lease-complete",
        capability: "lease-complete",
        async run(store) {
          const id = await store.enqueue({
            name: "cert",
            payload: { n: 1 },
            runAt: 10,
            maxAttempts: 3,
          })
          if ((await store.lease(9, 1, 100)).length !== 0) throw new Error("JobEarlyLease")
          const leased = await store.lease(10, 1, 100)
          if (leased.length !== 1 || leased[0]?.id !== id || leased[0]?.attempt !== 0)
            throw new Error("JobLease")
          await store.complete(id)
          if ((await store.counts()).pending !== 0) throw new Error("JobComplete")
        },
      },
      {
        id: "retry-schedule",
        capability: "retry-schedule",
        async run(store) {
          const id = await store.enqueue({ name: "cert", payload: null, runAt: 0, maxAttempts: 3 })
          await store.lease(0, 1, 10)
          await store.retry(id, 20)
          if ((await store.lease(19, 1, 10)).length !== 0) throw new Error("JobRetryEarly")
          const retried = await store.lease(20, 1, 10)
          if (retried[0]?.attempt !== 1) throw new Error("JobRetryAttempt")
        },
      },
      {
        id: "dead-letter",
        capability: "dead-letter",
        async run(store) {
          const id = await store.enqueue({ name: "cert", payload: null, runAt: 0, maxAttempts: 1 })
          await store.deadLetter(id, "bounded-code")
          const counts = await store.counts()
          if (counts.dead !== 1 || counts.pending !== 0) throw new Error("JobDeadLetter")
        },
      },
    ],
  }
}

export interface CertifiableStorageObject {
  readonly body: Uint8Array
  readonly size: number
  readonly contentType?: string
  readonly metadata?: Readonly<Record<string, string>>
}

export interface CertifiableStorageAdapter {
  put(
    key: string,
    data: Uint8Array | ArrayBuffer | string,
    options?: {
      readonly contentType?: string
      readonly metadata?: Readonly<Record<string, string>>
    },
  ): Promise<void>
  get(key: string): Promise<CertifiableStorageObject | null>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
  list(options?: { readonly prefix?: string; readonly limit?: number }): Promise<string[]>
  listPage?(options?: {
    readonly prefix?: string
    readonly limit?: number
    readonly cursor?: string
  }): Promise<{ readonly keys: readonly string[]; readonly cursor?: string }>
  presign?(
    key: string,
    operation: "get" | "put",
    options?: {
      readonly expiresInSeconds?: number
      readonly contentType?: string
      readonly contentLength?: number
    },
  ): Promise<{ readonly url: string; readonly expiresAt?: Date }>
  copy?(sourceKey: string, destinationKey: string): Promise<void>
  move?(sourceKey: string, destinationKey: string): Promise<void>
}

export function storageAdapterCertificationProfile(
  options: { readonly paging?: boolean; readonly presign?: boolean; readonly move?: boolean } = {},
): AdapterCertificationProfile<CertifiableStorageAdapter> {
  const capabilities = ["object-roundtrip", "overwrite", "list-delete"]
  const checks: CertificationCheck<CertifiableStorageAdapter>[] = [
    {
      id: "object-roundtrip",
      capability: "object-roundtrip",
      async run(store, context) {
        const key = context.key("object")
        await store.put(key, "hello", { contentType: "text/plain", metadata: { owner: "cert" } })
        const object = await store.get(key)
        if (
          object === null ||
          new TextDecoder().decode(object.body) !== "hello" ||
          object.size !== 5 ||
          object.contentType !== "text/plain" ||
          object.metadata?.owner !== "cert"
        )
          throw new Error("StorageRoundtrip")
      },
    },
    {
      id: "overwrite",
      capability: "overwrite",
      async run(store, context) {
        const key = context.key("overwrite")
        await store.put(key, "before")
        await store.put(key, "after")
        const object = await store.get(key)
        if (object === null || new TextDecoder().decode(object.body) !== "after")
          throw new Error("StorageOverwrite")
      },
    },
    {
      id: "list-delete",
      capability: "list-delete",
      async run(store, context) {
        const prefix = `${context.key("prefix")}/`
        const key = `${prefix}a`
        await store.put(key, "x")
        await store.put(context.key("outside"), "x")
        const listed = await store.list({ prefix, limit: 1 })
        if (listed.length !== 1 || listed[0] !== key || !(await store.exists(key)))
          throw new Error("StorageList")
        await store.delete(key)
        if ((await store.exists(key)) || (await store.get(key)) !== null)
          throw new Error("StorageDelete")
      },
    },
  ]
  if (options.paging === true) {
    capabilities.push("cursor-paging")
    checks.push({
      id: "cursor-paging",
      capability: "cursor-paging",
      async run(store, context) {
        if (store.listPage === undefined) throw new Error("StoragePagingMissing")
        const prefix = `${context.key("page")}/`
        await store.put(`${prefix}a`, "a")
        await store.put(`${prefix}b`, "b")
        const first = await store.listPage({ prefix, limit: 1 })
        if (first.keys.length !== 1 || first.cursor === undefined)
          throw new Error("StoragePagingFirst")
        const second = await store.listPage({ prefix, limit: 1, cursor: first.cursor })
        if (second.keys.length !== 1 || second.keys[0] === first.keys[0])
          throw new Error("StoragePagingSecond")
      },
    })
  }
  if (options.presign === true) {
    capabilities.push("presign")
    checks.push({
      id: "presign",
      capability: "presign",
      async run(store, context) {
        if (store.presign === undefined) throw new Error("StoragePresignMissing")
        const signed = await store.presign(context.key("signed"), "put", {
          expiresInSeconds: 60,
          contentType: "text/plain",
          contentLength: 1,
        })
        const url = new URL(signed.url)
        if (url.protocol !== "https:" && url.protocol !== "http:")
          throw new Error("StoragePresignUrl")
      },
    })
  }
  if (options.move === true) {
    capabilities.push("copy-move")
    checks.push({
      id: "copy-move",
      capability: "copy-move",
      async run(store, context) {
        if (store.copy === undefined || store.move === undefined)
          throw new Error("StorageMoveMissing")
        const source = context.key("source")
        const copy = context.key("copy")
        const moved = context.key("moved")
        await store.put(source, "x")
        await store.copy(source, copy)
        await store.move(copy, moved)
        if (
          !(await store.exists(source)) ||
          (await store.exists(copy)) ||
          !(await store.exists(moved))
        )
          throw new Error("StorageMove")
      },
    })
  }
  return {
    id: "storage-adapter",
    version: 1,
    capabilities,
    checks,
  }
}

export interface CertifiableRuntimeServer {
  readonly origin: string
  stop(): void | Promise<void>
}

export interface CertifiableRuntimeAdapter {
  start(app: {
    fetch(request: Request): Response | Promise<Response>
  }): CertifiableRuntimeServer | Promise<CertifiableRuntimeServer>
}

export function runtimeAdapterCertificationProfile(): AdapterCertificationProfile<CertifiableRuntimeAdapter> {
  return {
    id: "runtime-adapter",
    version: 1,
    capabilities: ["request-bridge", "response-bridge", "lifecycle"],
    checks: [
      {
        id: "request-bridge",
        capability: "request-bridge",
        async run(adapter) {
          const server = await adapter.start({
            async fetch(request) {
              return Response.json({
                method: request.method,
                path: new URL(request.url).pathname,
                header: request.headers.get("x-cert"),
                body: await request.text(),
              })
            },
          })
          try {
            const response = await fetch(`${server.origin}/cert/path`, {
              method: "POST",
              headers: { "x-cert": "yes" },
              body: "payload",
            })
            const value = (await response.json()) as Record<string, unknown>
            if (
              value.method !== "POST" ||
              value.path !== "/cert/path" ||
              value.header !== "yes" ||
              value.body !== "payload"
            )
              throw new Error("RuntimeRequestBridge")
          } finally {
            await server.stop()
          }
        },
      },
      {
        id: "response-bridge",
        capability: "response-bridge",
        async run(adapter) {
          const server = await adapter.start({
            fetch: () => new Response("certified", { status: 201, headers: { "x-cert": "yes" } }),
          })
          try {
            const response = await fetch(`${server.origin}/`)
            if (
              response.status !== 201 ||
              response.headers.get("x-cert") !== "yes" ||
              (await response.text()) !== "certified"
            )
              throw new Error("RuntimeResponseBridge")
          } finally {
            await server.stop()
          }
        },
      },
      {
        id: "idempotent-stop",
        capability: "lifecycle",
        async run(adapter) {
          const server = await adapter.start({ fetch: () => new Response(null, { status: 204 }) })
          if (!/^https?:\/\//.test(server.origin)) throw new Error("RuntimeOrigin")
          await server.stop()
          await server.stop()
        },
      },
    ],
  }
}

export interface CertifiableDomainEvent {
  readonly id: string
  readonly type: string
  readonly version?: number
  readonly aggregateId: string
  readonly payload: unknown
  readonly timestamp: string
}

export interface CertifiableEventRecord {
  readonly position: string
  readonly event: CertifiableDomainEvent
  readonly claimId: string | null
}

export interface CertifiableEventDeliveryAdapter {
  append(event: CertifiableDomainEvent): Promise<void>
  claimPending(limit: number, now: string): Promise<CertifiableEventRecord[]>
  markDelivered(id: string, claimId: string, at: string): Promise<boolean>
  readPage(options?: { readonly after?: string; readonly limit?: number }): Promise<{
    readonly records: readonly CertifiableEventRecord[]
    readonly nextPosition: string | null
    readonly hasMore: boolean
  }>
}

const certEvent = (id: string, order: number): CertifiableDomainEvent => ({
  id,
  type: "nifra.certified",
  version: 1,
  aggregateId: "certification",
  payload: { order },
  timestamp: new Date(order * 1_000).toISOString(),
})

export function eventDeliveryCertificationProfile(): AdapterCertificationProfile<CertifiableEventDeliveryAdapter> {
  return {
    id: "event-delivery",
    version: 1,
    capabilities: ["idempotent-append", "claim-ownership", "ordered-replay"],
    checks: [
      {
        id: "idempotent-append",
        capability: "idempotent-append",
        async run(store, context) {
          const event = certEvent(context.key("event"), 1)
          await store.append(event)
          await store.append(event)
          const page = await store.readPage({ limit: 10 })
          if (page.records.filter((record) => record.event.id === event.id).length !== 1)
            throw new Error("EventAppendIdempotency")
        },
      },
      {
        id: "claim-ownership",
        capability: "claim-ownership",
        async run(store, context) {
          const event = certEvent(context.key("claim"), 1)
          await store.append(event)
          const claimed = await store.claimPending(1, "2026-01-01T00:00:00.000Z")
          const claimId = claimed[0]?.claimId
          if (claimed[0]?.event.id !== event.id || claimId === null || claimId === undefined)
            throw new Error("EventClaim")
          if (await store.markDelivered(event.id, "wrong-claim", "2026-01-01T00:00:01.000Z"))
            throw new Error("EventClaimFence")
          if (!(await store.markDelivered(event.id, claimId, "2026-01-01T00:00:01.000Z")))
            throw new Error("EventSettlement")
          if ((await store.claimPending(1, "2026-01-01T00:00:02.000Z")).length !== 0)
            throw new Error("EventRedelivery")
        },
      },
      {
        id: "ordered-replay",
        capability: "ordered-replay",
        async run(store, context) {
          const first = certEvent(context.key("first"), 1)
          const second = certEvent(context.key("second"), 2)
          await store.append(first)
          await store.append(second)
          const pageOne = await store.readPage({ limit: 1 })
          if (
            pageOne.records[0]?.event.id !== first.id ||
            pageOne.nextPosition === null ||
            !pageOne.hasMore
          )
            throw new Error("EventReplayPageOne")
          const pageTwo = await store.readPage({ after: pageOne.nextPosition, limit: 1 })
          if (pageTwo.records[0]?.event.id !== second.id || pageTwo.hasMore)
            throw new Error("EventReplayPageTwo")
        },
      },
    ],
  }
}

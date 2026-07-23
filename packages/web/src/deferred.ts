/**
 * Deferred loader data (`defer()`). A loader may mark slow values as deferred: the critical data
 * renders in the shell, the deferred data streams in behind a `<Suspense>` (the adapter's `<Await>`
 * consumes it) and resolves on the client **without a re-fetch**. This module owns the agnostic
 * protocol — the marker, the resolved/deferred split, and the tiny client registry that streamed
 * resolution scripts settle. The per-adapter `<Await>` lives in `@nifrajs/web-{solid,react}/client`.
 */
import { plainJsonCodec, type TransportCodec } from "@nifrajs/core/transport-codec"

/**
 * A loader value marked to stream in after the shell. The component consumes it with the adapter's
 * `<Await resolve={...}>`; until the promise settles the shell shows the `<Suspense>` fallback.
 * `id` is assigned by the server at serialization time — the streamed resolve script keys off it.
 */
export interface Deferred<T> {
  readonly __nifra_deferred: true
  readonly id: number
  readonly promise: Promise<T>
}

/**
 * Mark a loader value as deferred — it streams in after the shell instead of blocking it. Works
 * **anywhere** in the loader's returned data — a top-level key, or nested in objects/arrays:
 *
 *   return { user: await api.user.get(), feed: defer(api.user.feed()),
 *            panels: [{ chart: defer(api.metrics()) }] }
 *
 * `LoaderData<typeof loader>` surfaces each deferred value as `Deferred<…>` (not awaited), so the
 * component knows to `<Await>` it. The `id` is a placeholder until the server assigns the real one.
 */
export function defer<T>(promise: Promise<T>): Deferred<T> {
  // Claim the promise immediately: an eager rejection may otherwise be reported as unhandled before
  // the SSR/NDJSON consumer attaches. Keep the original promise so consumers observe its rejection.
  void promise.catch(() => {})
  return { __nifra_deferred: true, id: -1, promise }
}

/** A loader value is a deferred marker (vs. a serialized `{__nifra_deferred: <number>}` placeholder,
 * whose field is a number, not `true`). */
function isDeferred(value: unknown): value is Deferred<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __nifra_deferred?: unknown }).__nifra_deferred === true
  )
}

/**
 * Split a loader (or action) result into the **component-facing** data (deferred values carry their
 * assigned `id` + promise, for `<Await>`) and the **client-serializable** data (deferred values
 * replaced with a `{__nifra_deferred: id}` placeholder — promises don't serialize). Walks the tree
 * **recursively** — `defer()` works at any depth, inside nested objects and arrays — assigning ids in
 * walk order. `idOffset` continues the id space when a page splits two results (loader data **and**
 * action data) into one shared client registry, so their ids don't collide. `deferred` lists the
 * promises for callers that await them. Recurses plain objects + arrays only; the data is expected to
 * be plain JSON-serializable values.
 */
export function prepareDeferred(
  data: unknown,
  idOffset = 0,
): {
  readonly forComponent: unknown
  readonly forClient: unknown
  readonly deferred: ReadonlyArray<{ readonly id: number; readonly promise: Promise<unknown> }>
} {
  const deferred: Array<{ id: number; promise: Promise<unknown> }> = []
  // Structural sharing: a subtree with no deferred value returns the ORIGINAL node for
  // both sides (`fc`/`cl` identical to the input), so a deferred-free result — the common case — is
  // returned by reference with no persisted clone, no downstream copy, and no throwaway clone
  // allocations. Only the path to a `defer()` marker is rebuilt; unchanged siblings are shared by
  // reference.
  const split = (value: unknown): { fc: unknown; cl: unknown } | undefined => {
    if (isDeferred(value)) {
      const id = idOffset + deferred.length
      deferred.push({ id, promise: value.promise })
      return {
        fc: { __nifra_deferred: true, id, promise: value.promise },
        cl: { __nifra_deferred: id },
      }
    }
    if (Array.isArray(value)) {
      let fc: unknown[] | undefined
      let cl: unknown[] | undefined
      for (let i = 0; i < value.length; i++) {
        const v = value[i]
        const r = split(v)
        if (r === undefined) {
          if (fc !== undefined && cl !== undefined) {
            fc[i] = v
            cl[i] = v
          }
          continue
        }
        if (fc === undefined || cl === undefined) {
          fc = value.slice(0, i)
          cl = value.slice(0, i)
        }
        fc[i] = r.fc
        cl[i] = r.cl
      }
      return fc === undefined || cl === undefined ? undefined : { fc, cl }
    }
    if (value !== null && typeof value === "object") {
      const input = value as Record<string, unknown>
      let fc: Record<string, unknown> | undefined
      let cl: Record<string, unknown> | undefined
      for (const k in input) {
        if (!Object.hasOwn(input, k)) continue
        const v = input[k]
        const r = split(v)
        if (r === undefined) {
          if (fc !== undefined && cl !== undefined) {
            fc[k] = v
            cl[k] = v
          }
          continue
        }
        if (fc === undefined || cl === undefined) {
          fc = {}
          cl = {}
          for (const prev in input) {
            if (!Object.hasOwn(input, prev)) continue
            if (prev === k) break
            const prevValue = input[prev]
            fc[prev] = prevValue
            cl[prev] = prevValue
          }
        }
        fc[k] = r.fc
        cl[k] = r.cl
      }
      return fc === undefined || cl === undefined ? undefined : { fc, cl }
    }
    return undefined
  }
  const result = split(data)
  return result === undefined
    ? { forComponent: data, forClient: data, deferred }
    : { forComponent: result.fc, forClient: result.cl, deferred }
}

/**
 * Stable, non-leaking payload streamed to the client when a deferred value rejects — never the raw
 * error text. The real reason is logged server-side; `<Await>`'s `errorFallback` receives
 * this code. (A future typed `DeferredError` could opt into a public, intentional message.) Shared by
 * the NDJSON soft-nav transport and the full-document SSR path (`renderPage`'s `streamDocument`).
 */
export const DEFERRED_ERROR_CODE = "deferred_error"
// Shared, stateless — allocated once at module load, not per stream.
const NDJSON_ENCODER = new TextEncoder()

/**
 * Stream a loader result as NDJSON for a client (soft) navigation: line 1 is the critical data with
 * `{__nifra_deferred: id}` placeholders (`forClient`), then one line per deferred as its promise
 * settles — `{"i": id, "v": value}` on resolve, `{"i": id, "e": "deferred_error"}` on reject (a
 * rejection is data, not a stream error; the opaque code never leaks the raw reason). Closes when all
 * settle. The client (`defaultFetchData`) returns the
 * data after line 1 and settles `<Await>`'s markers as the resolution lines arrive. `JSON.stringify`
 * escapes newlines in values, so each line is NDJSON-safe; no HTML escaping (this is a fetch body,
 * parsed with `JSON.parse`, never injected into markup).
 */
export function ndjsonStream(
  forClient: unknown,
  deferred: ReadonlyArray<{ readonly id: number; readonly promise: Promise<unknown> }>,
  codec: TransportCodec = plainJsonCodec,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(NDJSON_ENCODER.encode(`${codec.encode(forClient)}\n`))
      await Promise.all(
        deferred.map(async (d) => {
          try {
            const value = await d.promise
            controller.enqueue(NDJSON_ENCODER.encode(`${codec.encode({ i: d.id, v: value })}\n`))
          } catch (err) {
            // Redact: stream a stable opaque code, never the raw error text; log the real reason
            // server-side. The client's <Await> errorFallback receives this code.
            console.error("[nifra/web] deferred value rejected:", err)
            controller.enqueue(
              NDJSON_ENCODER.encode(`${codec.encode({ i: d.id, e: DEFERRED_ERROR_CODE })}\n`),
            )
          }
        }),
      )
      controller.close()
    },
  })
}

/**
 * Inline client runtime injected into the shell `<head>` when a page has deferred data: a per-id
 * promise registry that streamed `__nifraResolve(id, value)` / `__nifraReject(id, err)` scripts settle
 * (created lazily, so a resolve script that arrives before the client maps the placeholder still
 * works), plus `__nifraDeferred(id)` to read the promise. A plain inline script (not the deferred
 * module entry), so it runs before any streamed resolve script.
 */
export const DEFERRED_RUNTIME = `(() => {
  const reg = new Map();
  const get = (id) => {
    let e = reg.get(id);
    if (!e) {
      let r, j;
      const p = new Promise((a, b) => { r = a; j = b; });
      // <Await> reads the tagged status/reason synchronously (it never .then()s a rejected promise),
      // so attach a no-op catch to keep a rejection from surfacing as an unhandled rejection.
      p.catch(() => {});
      e = { p, r, j };
      reg.set(id, e);
    }
    return e;
  };
  window.__nifraDeferred = (id) => get(id).p;
  // Tag the promise (status/value/reason) — React's use() reads them and returns SYNCHRONOUSLY at
  // hydration, so it renders the resolved content directly into the <Suspense> boundary the server
  // streamed (no re-suspend, no fallback flash). r/j also wake awaiters (Solid uses its own _$HY).
  window.__nifraResolve = (id, v) => { const e = get(id); e.p.status = "fulfilled"; e.p.value = v; e.r(v); };
  window.__nifraReject = (id, x) => { const e = get(id); e.p.status = "rejected"; e.p.reason = x; e.j(x); };
})();`

/**
 * Source emitted into the generated client entry: maps serialized `{__nifra_deferred: id}` placeholders
 * (at any depth — nested objects/arrays) to the registry's promises, so the component receives real
 * promises to `<Await>`. A no-op for data without placeholders (so non-deferred pages are unchanged).
 */
export const MAP_DEFERRED_SOURCE = `const mapDeferred = (d) => {
  if (!d || typeof d !== "object") return d
  if (typeof d.__nifra_deferred === "number") return { __nifra_deferred: true, id: d.__nifra_deferred, promise: window.__nifraDeferred(d.__nifra_deferred) }
  if (Array.isArray(d)) return d.map(mapDeferred)
  const out = {}
  for (const k in d) out[k] = mapDeferred(d[k])
  return out
}`

type Pending = Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>

/** Replace `{__nifra_deferred: <number>}` placeholders (at any depth — nested objects/arrays) with
 * `Deferred` markers whose promises are held open in `pending` (settled later by
 * {@link parseNdjsonData}'s drain). Mirrors `prepareDeferred`'s recursive walk. */
function markersFromPlaceholders(data: unknown, pending: Pending): unknown {
  // Markers already created in THIS parse, keyed by id — so a repeated id aliases the first marker.
  const byId = new Map<number, Deferred<unknown>>()
  const walk = (value: unknown): unknown => {
    const id = (value as { __nifra_deferred?: unknown } | null)?.__nifra_deferred
    if (value !== null && typeof value === "object" && typeof id === "number") {
      // The NDJSON stream is a trust boundary; the server assigns unique ids, but a corrupt/crafted
      // line-1 could repeat one. Alias a duplicate id to the first marker (same promise) instead of
      // overwriting its resolver in `pending` — otherwise the first marker would never settle (a
      // permanently-pending promise that leaks on abort). One resolve line then settles both.
      const seen = byId.get(id)
      if (seen !== undefined) return seen
      let resolve!: (v: unknown) => void
      let reject!: (e: unknown) => void
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res
        reject = rej
      })
      promise.catch(() => {}) // no unhandled rejection (<Await> drives the actual handling)
      pending.set(id, { resolve, reject })
      const marker = { __nifra_deferred: true, id, promise } satisfies Deferred<unknown>
      byId.set(id, marker)
      return marker
    }
    if (Array.isArray(value)) return value.map(walk)
    if (
      value !== null &&
      typeof value === "object" &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ) {
      const out: Record<string, unknown> = {}
      for (const [key, v] of Object.entries(value)) out[key] = walk(v)
      return out
    }
    return value
  }
  return walk(data)
}

/**
 * Client side of {@link ndjsonStream} (used by the router's `defaultFetchData` on a soft nav): read
 * the NDJSON body into a data object whose deferred markers settle as resolution lines arrive.
 * Returns after **line 1** so the router can apply the critical data + render immediately; the
 * markers' promises settle/reject in the background. If the stream ends (or `signal` aborts) with
 * markers unsettled, they reject — so `<Await>` never hangs.
 */
export async function parseNdjsonData(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  codec: TransportCodec = plainJsonCodec,
): Promise<unknown> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buffer = ""
  // `{ once: true }` + explicit removal in the drain's `finally` so a reused long-lived signal doesn't
  // accumulate listeners across navigations (a per-nav signal would be GC'd, but don't rely on it).
  const onAbort = (): void => void reader.cancel()
  if (signal) signal.addEventListener("abort", onAbort, { once: true })

  const readLine = async (): Promise<string | null> => {
    for (;;) {
      const nl = buffer.indexOf("\n")
      if (nl !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        return line
      }
      const { done, value } = await reader.read()
      if (done) {
        const rest = buffer
        buffer = ""
        return rest === "" ? null : rest
      }
      buffer += dec.decode(value, { stream: true })
    }
  }

  const pending: Pending = new Map()
  const first = await readLine()
  const data = markersFromPlaceholders(first === null ? null : codec.decode(first), pending)

  void (async () => {
    try {
      for (;;) {
        const line = await readLine()
        if (line === null) break
        if (line === "") continue
        const msg = codec.decode(line) as { i: number; v?: unknown; e?: string }
        const entry = pending.get(msg.i)
        if (entry === undefined) continue
        pending.delete(msg.i)
        if ("e" in msg) entry.reject(new Error(msg.e))
        else entry.resolve(msg.v)
      }
    } catch {
      // stream errored — leftovers are rejected below (unless this was an abort)
    } finally {
      signal?.removeEventListener("abort", onAbort) // no-op if it already fired ({ once: true })
      // A natural stream end with markers unsettled = truncation → reject (so `<Await>` shows its
      // error). An `abort` = a superseded navigation → leave them pending: the markers are detached
      // (their data was never applied), so rejecting would only risk an error flash mid-transition.
      if (!signal?.aborted) {
        for (const [, entry] of pending) {
          entry.reject(new Error("[nifra/web] deferred stream ended before this value resolved"))
        }
      }
    }
  })()

  return data
}

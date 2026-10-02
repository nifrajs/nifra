/**
 * `nifra cdn-check <url>` - is a deployed page actually served by the CDN the way `withCdn` intends?
 *
 * Read-only: two GETs of the page and one shaped like a soft navigation (`x-nifra-data: 1`). It names
 * the CDN from its status header, and fails when nifra's internal headers reach the visitor or when
 * the CDN answers a navigation data request with the cached document (Cloudflare's zone cache ignores
 * `Vary`, so it needs a rule that bypasses the cache for that header). CLI only: an agent-facing tool
 * that fetches arbitrary URLs from this machine could reach its private network.
 */
import type { CommandSpec } from "./command-catalog.ts"

export interface CdnCheckInput {
  readonly url: string
  readonly json?: boolean
}

export type CdnName = "cloudflare" | "vercel" | "fastly" | "unknown"

export interface CdnCheckRequest {
  readonly kind: "first" | "second" | "data"
  readonly status: number
  readonly cache?: string | undefined
  readonly age?: string | undefined
  readonly contentType?: string | undefined
  readonly cacheControl?: string | undefined
}

export interface CdnCheckFinding {
  readonly level: "fail" | "warn" | "info"
  readonly code: string
  readonly message: string
}

export interface CdnCheckOutput {
  readonly url: string
  readonly cdn: CdnName
  readonly requests: readonly CdnCheckRequest[]
  readonly findings: readonly CdnCheckFinding[]
}

const TIMEOUT_MS = 10_000
const INTERNAL = ["x-nifra-isr-revalidate", "x-nifra-isr-tags"]
const CDN_ONLY = [
  "cache-tag",
  "cloudflare-cdn-cache-control",
  "vercel-cache-tag",
  "vercel-cdn-cache-control",
  "surrogate-key",
  "surrogate-control",
]

function parseInput(value: unknown): CdnCheckInput {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>
  const url = raw.url
  if (typeof url !== "string" || url === "") throw new TypeError("cdn-check needs a page URL")
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new TypeError(`cdn-check: ${JSON.stringify(url)} is not a URL`)
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("cdn-check: the URL must be http or https")
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("cdn-check: leave credentials out of the URL")
  }
  return { url: parsed.href, ...(raw.json === true ? { json: true } : {}) }
}

/** The CDN a response came through, from the status header each one sets. */
export function detectCdn(headers: Headers): CdnName {
  if (headers.has("cf-cache-status") || headers.has("cf-ray")) return "cloudflare"
  if (headers.has("x-vercel-cache") || headers.has("x-vercel-id")) return "vercel"
  if (/\bcache-[a-z0-9]+/i.test(headers.get("x-served-by") ?? "")) return "fastly"
  return "unknown"
}

function cacheStatus(cdn: CdnName, headers: Headers): string | undefined {
  const value =
    cdn === "cloudflare"
      ? headers.get("cf-cache-status")
      : cdn === "vercel"
        ? headers.get("x-vercel-cache")
        : headers.get("x-cache")
  return value ?? undefined
}

const isHit = (status: string | undefined): boolean =>
  status !== undefined && /\b(HIT|STALE|UPDATING|REVALIDATED)\b/i.test(status)

async function get(
  url: string,
  extra: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  return fetch(url, {
    headers: { "user-agent": "nifra-cdn-check", ...extra },
    redirect: "manual",
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
}

export async function runCdnCheck(
  input: CdnCheckInput,
  ctx: { readonly signal?: AbortSignal } = {},
): Promise<CdnCheckOutput> {
  const findings: CdnCheckFinding[] = []
  const requests: CdnCheckRequest[] = []
  const record = async (extra: Record<string, string> = {}) => {
    const res = await get(input.url, extra, ctx.signal)
    await res.body?.cancel()
    return res
  }
  const first = await record()
  const cdn = detectCdn(first.headers)
  const summarize = (kind: CdnCheckRequest["kind"], res: Response): CdnCheckRequest => ({
    kind,
    status: res.status,
    cache: cacheStatus(cdn, res.headers),
    age: res.headers.get("age") ?? undefined,
    contentType: res.headers.get("content-type") ?? undefined,
    cacheControl: res.headers.get("cache-control") ?? undefined,
  })
  requests.push(summarize("first", first))
  if (first.status >= 300 && first.status < 400) {
    findings.push({
      level: "info",
      code: "redirect",
      message: `the URL redirects (${first.status}) to ${first.headers.get("location") ?? "?"}; check the page it lands on`,
    })
    return { url: input.url, cdn, requests, findings }
  }
  const second = await record()
  requests.push(summarize("second", second))
  const data = await record({ "x-nifra-data": "1" })
  requests.push(summarize("data", data))

  for (const res of [first, second, data]) {
    const leaked = INTERNAL.filter((name) => res.headers.has(name))
    if (leaked.length > 0) {
      findings.push({
        level: "fail",
        code: "internal-headers",
        message: `${leaked.join(", ")} reached the visitor: the app's cache channel is open without withISR or withCdn removing it`,
      })
      break
    }
  }
  const cdnOnly = CDN_ONLY.filter((name) => second.headers.has(name))
  if (cdnOnly.length > 0) {
    findings.push({
      level: "warn",
      code: "cdn-headers-visible",
      message: `${cdnOnly.join(", ")} reached the visitor: the response did not pass through the CDN these headers are for${cdn === "unknown" ? "" : `, or ${cdn} is not consuming them`}`,
    })
  }
  if (cdn === "unknown") {
    findings.push({
      level: "warn",
      code: "no-cdn",
      message:
        "no CDN status header (cf-cache-status, x-vercel-cache, x-served-by): the page does not seem to pass through Cloudflare, Vercel or Fastly",
    })
  } else if (!isHit(summarize("second", second).cache)) {
    findings.push({
      level: "warn",
      code: "not-cached",
      message:
        cdn === "cloudflare"
          ? `the second request was not served from cache (${second.headers.get("cf-cache-status") ?? "no status"}). Cloudflare caches HTML only under a Cache Rule that makes it eligible for cache`
          : `the second request was not served from cache (${summarize("second", second).cache ?? "no status"}); a personalized or no-store page is expected to stay uncached`,
    })
  }
  const browser = second.headers.get("cache-control") ?? ""
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(browser)?.[1]
  if (
    (second.headers.get("content-type") ?? "").includes("text/html") &&
    maxAge !== undefined &&
    Number(maxAge) > 0
  ) {
    findings.push({
      level: "warn",
      code: "browser-holds-html",
      message: `browsers may keep this page for ${maxAge}s (cache-control: ${browser}); a CDN purge cannot reach them`,
    })
  }
  const dataType = data.headers.get("content-type") ?? ""
  if (dataType.includes("text/html") || isHit(cacheStatus(cdn, data.headers))) {
    findings.push({
      level: "fail",
      code: "data-served-from-cache",
      message:
        cdn === "cloudflare"
          ? "a soft navigation (x-nifra-data: 1) got the cached document. The zone cache ignores Vary: add a Cache Rule that bypasses the cache when the request has an x-nifra-data header"
          : "a soft navigation (x-nifra-data: 1) got the cached document instead of the page data; the CDN is not honoring Vary: x-nifra-data",
    })
  }
  return { url: input.url, cdn, requests, findings }
}

function renderCdnCheck(out: CdnCheckOutput): readonly string[] {
  const lines = [`cdn-check ${out.url}  (cdn: ${out.cdn})`]
  for (const r of out.requests) {
    lines.push(
      `  ${r.kind.padEnd(6)} ${r.status}  cache=${r.cache ?? "-"}  age=${r.age ?? "-"}  ${r.contentType ?? ""}`,
    )
  }
  if (out.findings.length === 0) lines.push("ok - nothing to fix")
  for (const f of out.findings) lines.push(`${f.level.toUpperCase()} ${f.code}: ${f.message}`)
  return lines
}

export const cdnCheckSpec: CommandSpec<CdnCheckInput, CdnCheckOutput> = {
  name: "cdn-check",
  summary:
    "Check a deployed page behind a CDN: is it served from cache, do internal or CDN-only headers reach the visitor, and does a soft navigation get page data rather than the cached document.",
  input: {
    jsonSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The deployed page to check (http or https)." },
        json: { type: "boolean" },
      },
      required: ["url"],
    },
    parse: parseInput,
  },
  output: {
    version: 1,
    jsonSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        cdn: { type: "string", enum: ["cloudflare", "vercel", "fastly", "unknown"] },
        requests: { type: "array" },
        findings: { type: "array" },
      },
      required: ["url", "cdn", "requests", "findings"],
    },
    parse: (value) => {
      const out = value as Partial<CdnCheckOutput> | null
      if (
        typeof out?.url !== "string" ||
        !Array.isArray(out.requests) ||
        !Array.isArray(out.findings)
      ) {
        throw new TypeError("cdn-check output must carry url, cdn, requests and findings")
      }
      return out as CdnCheckOutput
    },
  },
  transports: ["cli"],
  stability: "experimental",
  argv: {
    positionals: ["url"],
    flags: [{ name: "json", field: "json", type: "boolean" }],
  },
  run: (input, ctx) => runCdnCheck(input, ctx),
  render: renderCdnCheck,
  exitCode: (out) => (out.findings.some((f) => f.level === "fail") ? 1 : 0),
  json: (out) => out,
}

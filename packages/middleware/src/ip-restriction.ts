import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import type { Middleware, Platform } from "@nifrajs/core/server"
import { type ParsedIp, parseIp } from "./_ip.ts"
import { jsonError, type MaybePromise } from "./_utils.ts"

export type IpMatcher = string | ((ip: string, request: Request) => MaybePromise<boolean>)

export interface IpRestrictionOptions {
  readonly allow?: readonly IpMatcher[]
  readonly deny?: readonly IpMatcher[]
  /**
   * Custom extraction hook. Without it (and without `trustedProxies`/`header`), the caller is
   * `platform.clientIp`: the socket peer, or the app's `clientIp` trust declaration applied to it.
   */
  readonly clientIp?: (
    request: Request,
    platform?: Platform,
  ) => MaybePromise<string | null | undefined>
  /** Trusted proxy count for `X-Forwarded-For` extraction. Default: 0, so XFF is ignored. Prefer the
   * app-level `server({ clientIp: { trustedHops } })` declaration, which the default honors. */
  readonly trustedProxies?: number
  /** Exact trusted single-IP header, e.g. an infra-set `x-real-ip`. Not used unless configured. */
  readonly header?: string
  readonly error?: string
}

interface Range {
  readonly version: 4 | 6
  readonly network: bigint
  readonly mask: bigint
}

function parseRange(input: string): Range {
  const slash = input.indexOf("/")
  const address = slash < 0 ? input : input.slice(0, slash)
  const ip = parseIp(address)
  if (ip === null) throw new Error(`ipRestriction: invalid IP/CIDR ${JSON.stringify(input)}`)
  const bits = ip.version === 4 ? 32 : 128
  // `::ffff:10.0.0.0/104` is matched as IPv4, so its prefix counts past the 96 mapping bits.
  const mapped = ip.version === 4 && address.includes(":") ? 96 : 0
  const prefix =
    slash < 0
      ? bits
      : /^\d+$/.test(input.slice(slash + 1))
        ? Number(input.slice(slash + 1)) - mapped
        : -1
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw new Error(`ipRestriction: invalid CIDR prefix ${JSON.stringify(input)}`)
  }
  const full = (1n << BigInt(bits)) - 1n
  const mask = prefix === 0 ? 0n : full ^ ((1n << BigInt(bits - prefix)) - 1n)
  return { version: ip.version, network: ip.value & mask, mask }
}

function matchRange(ip: ParsedIp, range: Range): boolean {
  return ip.version === range.version && (ip.value & range.mask) === range.network
}

function xForwardedClient(req: Request, trustedProxies: number): string | null {
  if (trustedProxies <= 0) return null
  const xff = req.headers.get("x-forwarded-for")
  if (xff === null) return null
  const parts = xff.split(",")
  return parts[parts.length - trustedProxies]?.trim() || null
}

async function resolveClientIp(
  req: Request,
  platform: Platform | undefined,
  options: IpRestrictionOptions,
): Promise<string | null> {
  const custom = await options.clientIp?.(req, platform)
  if (custom !== undefined && custom !== null) return custom
  // Explicit proxy options fail closed on their own: falling back to the socket peer there would
  // judge the proxy's address whenever the forwarded header went missing.
  if (
    options.clientIp === undefined &&
    (options.trustedProxies ?? 0) === 0 &&
    options.header === undefined
  ) {
    return platform?.clientIp || null
  }
  const fromXff = xForwardedClient(req, options.trustedProxies ?? 0)
  if (fromXff !== null) return fromXff
  if (options.header !== undefined) {
    const value = req.headers.get(options.header)
    if (value !== null && !value.includes(",")) return value.trim()
  }
  return null
}

function compile(matchers: readonly IpMatcher[] | undefined): {
  readonly ranges: readonly Range[]
  readonly fns: readonly ((ip: string, req: Request) => MaybePromise<boolean>)[]
} {
  const ranges: Range[] = []
  const fns: ((ip: string, req: Request) => MaybePromise<boolean>)[] = []
  for (const matcher of matchers ?? []) {
    if (typeof matcher === "string") ranges.push(parseRange(matcher))
    else fns.push(matcher)
  }
  return { ranges, fns }
}

async function matches(
  ipText: string,
  ip: ParsedIp,
  compiled: ReturnType<typeof compile>,
  req: Request,
): Promise<boolean> {
  if (compiled.ranges.some((range) => matchRange(ip, range))) return true
  for (const fn of compiled.fns) if (await fn(ipText, req)) return true
  return false
}

/**
 * IP allow/deny middleware. It fails closed when no trustworthy client IP can be derived. By default the
 * caller is the server-resolved `platform.clientIp` (socket peer, or the app's `clientIp` trust
 * declaration); `clientIp`, `trustedProxies`, or a trusted single-IP `header` override it. Unconfigured
 * X-Forwarded-For is never trusted.
 */
export function ipRestriction(options: IpRestrictionOptions): Middleware {
  const trustedProxies = options.trustedProxies ?? 0
  if (!Number.isInteger(trustedProxies) || trustedProxies < 0) {
    throw new Error("ipRestriction: trustedProxies must be a non-negative integer")
  }
  if (options.header !== undefined && options.header.trim() === "") {
    throw new Error("ipRestriction: header must not be empty")
  }
  const allow = compile(options.allow)
  const deny = compile(options.deny)
  if (allow.ranges.length + allow.fns.length + deny.ranges.length + deny.fns.length === 0) {
    throw new Error("ipRestriction: configure at least one allow or deny matcher")
  }
  const error = options.error ?? "ip_forbidden"

  return withRouteAssurance<Middleware>(
    {
      name: "ip-restriction",
      async onRequest(req, platform) {
        const ipText = await resolveClientIp(req, platform, options)
        if (ipText === null) return jsonError(403, error)
        const ip = parseIp(ipText)
        if (ip === null) return jsonError(403, error)
        if (await matches(ipText, ip, deny, req)) return jsonError(403, error)
        if (
          allow.ranges.length + allow.fns.length > 0 &&
          !(await matches(ipText, ip, allow, req))
        ) {
          return jsonError(403, error)
        }
        return undefined
      },
    },
    {
      id: NIFRA_ASSURANCE.IP_RESTRICTED,
      source: "ip-restriction",
      scope: "global",
    },
  )
}

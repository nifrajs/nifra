import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import type { Middleware } from "@nifrajs/core/server"
import { jsonError, type MaybePromise } from "./_utils.ts"

export type IpMatcher = string | ((ip: string, request: Request) => MaybePromise<boolean>)

export interface IpRestrictionOptions {
  readonly allow?: readonly IpMatcher[]
  readonly deny?: readonly IpMatcher[]
  /** Preferred extraction hook when the adapter/app knows the peer address. */
  readonly clientIp?: (request: Request) => MaybePromise<string | null | undefined>
  /** Trusted proxy count for `X-Forwarded-For` extraction. Default: 0, so XFF is ignored. */
  readonly trustedProxies?: number
  /** Exact trusted single-IP header, e.g. an infra-set `x-real-ip`. Not used unless configured. */
  readonly header?: string
  readonly error?: string
}

interface ParsedIp {
  readonly version: 4 | 6
  readonly value: bigint
}

interface Range {
  readonly version: 4 | 6
  readonly network: bigint
  readonly mask: bigint
}

function parseIPv4(input: string): bigint | null {
  const parts = input.split(".")
  if (parts.length !== 4) return null
  let out = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    out = (out << 8n) | BigInt(n)
  }
  return out
}

function parseIPv6(input: string): bigint | null {
  if (input.includes("%")) return null
  let source = input.toLowerCase()
  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":")
    if (lastColon < 0) return null
    const ipv4 = parseIPv4(source.slice(lastColon + 1))
    if (ipv4 === null) return null
    const hi = Number((ipv4 >> 16n) & 0xffffn).toString(16)
    const lo = Number(ipv4 & 0xffffn).toString(16)
    source = `${source.slice(0, lastColon)}:${hi}:${lo}`
  }

  const halves = source.split("::")
  if (halves.length > 2) return null
  const left = halves[0] === "" ? [] : halves[0]!.split(":")
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":")
  const groups = [...left, ...right]
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null

  const missing = 8 - groups.length
  if (halves.length === 1) {
    if (missing !== 0) return null
  } else if (missing < 1) return null

  const expanded =
    halves.length === 1
      ? groups
      : [...left, ...Array.from({ length: missing }, () => "0"), ...right]
  let out = 0n
  for (const group of expanded) out = (out << 16n) | BigInt(Number.parseInt(group, 16))
  return out
}

function parseIp(input: string): ParsedIp | null {
  const trimmed = input.trim()
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed
  const v4 = parseIPv4(unbracketed)
  if (v4 !== null) return { version: 4, value: v4 }
  const v6 = parseIPv6(unbracketed)
  return v6 === null ? null : { version: 6, value: v6 }
}

function parseRange(input: string): Range {
  const slash = input.indexOf("/")
  const address = slash < 0 ? input : input.slice(0, slash)
  const ip = parseIp(address)
  if (ip === null) throw new Error(`ipRestriction: invalid IP/CIDR ${JSON.stringify(input)}`)
  const bits = ip.version === 4 ? 32 : 128
  const prefix =
    slash < 0 ? bits : /^\d+$/.test(input.slice(slash + 1)) ? Number(input.slice(slash + 1)) : -1
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
  options: IpRestrictionOptions,
): Promise<string | null> {
  const custom = await options.clientIp?.(req)
  if (custom !== undefined && custom !== null) return custom
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
 * IP allow/deny middleware. It fails closed when no trustworthy client IP can be derived. Configure
 * `clientIp`, `trustedProxies`, or a trusted single-IP `header`; unconfigured X-Forwarded-For is never
 * trusted.
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
      async onRequest(req) {
        const ipText = await resolveClientIp(req, options)
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

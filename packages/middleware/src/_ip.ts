export interface ParsedIp {
  readonly version: 4 | 6
  readonly value: bigint
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

/**
 * An IPv4 or IPv6 address, bracketed or not. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is the
 * IPv4 address it carries: Bun and Node report every IPv4 peer that way on their default dual-stack
 * listener, and IPv4 rules must still match it.
 */
export function parseIp(input: string): ParsedIp | null {
  const trimmed = input.trim()
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed
  const v4 = parseIPv4(unbracketed)
  if (v4 !== null) return { version: 4, value: v4 }
  const v6 = parseIPv6(unbracketed)
  if (v6 === null) return null
  return v6 >> 32n === 0xffffn ? { version: 4, value: v6 & 0xffffffffn } : { version: 6, value: v6 }
}

/**
 * The rate-limit bucket for a client address: an IPv4 address as itself (unmapped), an IPv6 address
 * as its /64. One subscriber is routinely assigned a whole /64 and can send every request from a new
 * address inside it, so a per-address bucket never fills. Anything that is not an address is kept.
 */
export function ipBucket(ip: string): string {
  if (!ip.includes(":")) return ip
  // Every IPv4 peer of a default Bun or Node listener: skip the full parse on that per-request path.
  if (ip.startsWith("::ffff:") && ip.includes(".", 7) && ip.indexOf(":", 7) === -1)
    return ip.slice(7)
  const parsed = parseIp(ip)
  if (parsed === null) return ip
  const value = parsed.value
  if (parsed.version === 4) {
    return `${(value >> 24n) & 255n}.${(value >> 16n) & 255n}.${(value >> 8n) & 255n}.${value & 255n}`
  }
  const prefix = (value >> 64n).toString(16).padStart(16, "0")
  return `${prefix.slice(0, 4)}:${prefix.slice(4, 8)}:${prefix.slice(8, 12)}:${prefix.slice(12)}::/64`
}

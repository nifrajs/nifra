/**
 * Checks for the path-segment codec that need no test runner, so the Bun, Node and Deno lanes run the
 * same ones. Each returns the mismatches it found; an empty array is a pass.
 */
import net from "node:net"
import { browserPathSegment, encodePathSegment } from "../src/router/path-codec.ts"

type Encode = (value: string) => string

/** `canonical` is {@link encodePathSegment}; `browser` is {@link browserPathSegment}. */
export type SegmentMode = "canonical" | "browser"

const hex = (code: number): string => code.toString(16).toUpperCase().padStart(2, "0")

/** The characters that cannot stand in a segment as written. */
const STRUCTURAL = /[/?#\\]/

/** Characters a path never carries raw in the canonical form but a browser does. */
const BROWSER_ONLY = ";[]|"

/** The URL parser deletes these from its input, so it has no spelling of them to compare with. */
const STRIPPED_BY_PARSER = new Set([0x09, 0x0a, 0x0d])

const SAMPLES = [
  "é",
  "日本語",
  "😀",
  "a😀b",
  "é",
  "a b",
  "100%",
  "%2F",
  "%2E%2E",
  "a%2Fb",
  "...",
  ".a",
  "a.",
  "file[1].png",
  "a;b=c",
  "x,y+z$w@v:u&t",
  "\u0000",
  "\u007f",
  " ",
  "�",
]

/** What RFC 3986 normalization does to one segment: decode unreserved escapes, upper-case the rest. */
function rfc3986Segment(segment: string): string {
  return segment.replace(/%([0-9a-fA-F]{2})/g, (_match, digits: string) => {
    const char = String.fromCharCode(Number.parseInt(digits, 16))
    return /[A-Za-z0-9\-._~]/.test(char) ? char : `%${digits.toUpperCase()}`
  })
}

/** Every ASCII character and a set of hard samples, through `encode`, against the properties the codec promises. */
export function segmentMismatches(encode: Encode, mode: SegmentMode): string[] {
  const found: string[] = []
  const check = (value: string, label: string): void => {
    let encoded: string
    try {
      encoded = encode(value)
    } catch (error) {
      found.push(`${label}: threw ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (STRUCTURAL.test(encoded))
      found.push(`${label}: structural character left raw in ${encoded}`)
    if (/%(?![0-9A-F]{2})/.test(encoded))
      found.push(`${label}: malformed or lower-case escape in ${encoded}`)
    if (/[^\x21-\x7e]/.test(encoded))
      found.push(`${label}: byte outside printable ASCII in ${encoded}`)
    let decoded: string | undefined
    try {
      decoded = decodeURIComponent(encoded)
    } catch {
      decoded = undefined
    }
    if (decoded !== value) found.push(`${label}: ${encoded} does not decode back`)
    const parsed = new URL(`http://x/${encoded}`).pathname
    if (parsed !== `/${encoded}`)
      found.push(`${label}: a URL parser rewrites ${encoded} to ${parsed}`)
    const normalized = rfc3986Segment(encoded)
    if (normalized !== encoded)
      found.push(`${label}: RFC 3986 normalization rewrites ${encoded} to ${normalized}`)
    if (normalized === "." || normalized === "..")
      found.push(`${label}: ${encoded} is a dot segment`)
  }
  for (let code = 0; code < 128; code++) {
    const char = String.fromCharCode(code)
    const value = `a${char}b`
    const label = `U+00${hex(code)}`
    check(value, label)
    if (STRUCTURAL.test(char) || char === "%" || STRIPPED_BY_PARSER.has(code)) continue
    // The parser's own spelling of the raw text; the codec agrees with it except where it must not.
    const own = new URL(`http://x/${value}`).pathname.slice(1)
    const expected = mode === "canonical" && BROWSER_ONLY.includes(char) ? `a%${hex(code)}b` : own
    let encoded: string | undefined
    try {
      encoded = encode(value)
    } catch {
      continue
    }
    // Deno leaves `^` as written where Node and Bun encode it; the codec always encodes it.
    if (encoded !== expected && !(char === "^" && encoded === "a%5Eb")) {
      found.push(`${label}: ${encoded} where ${expected} is expected`)
    }
  }
  for (const sample of SAMPLES) check(sample, JSON.stringify(sample))
  return found
}

/** Values no segment can carry must throw; near misses must not. */
export function refusalMismatches(encode: Encode): string[] {
  const found: string[] = []
  for (const value of [".", "..", "\ud800", "a\udc00b", "a\ud83d"]) {
    try {
      encode(value)
      found.push(`${JSON.stringify(value)}: did not throw`)
    } catch (error) {
      if (!(error instanceof RangeError))
        found.push(`${JSON.stringify(value)}: threw a non-RangeError`)
    }
  }
  for (const value of ["", "...", ".a", "a.", "..a"]) {
    try {
      encode(value)
    } catch {
      found.push(`${JSON.stringify(value)}: threw`)
    }
  }
  return found
}

/** The characters `encode` leaves as written, among printable ASCII, in code order. */
export function rawCharacters(encode: Encode): string {
  let raw = ""
  for (let code = 0x21; code <= 0x7e; code++) {
    const char = String.fromCharCode(code)
    if (encode(`a${char}b`) === `a${char}b`) raw += char
  }
  return raw
}

/** Both spellings of every printable ASCII character and the samples that make a valid request target. */
export function spellings(): string[] {
  const out = new Set<string>()
  for (let code = 0x21; code <= 0x7e; code++) {
    const value = `a${String.fromCharCode(code)}b`
    out.add(`/${encodePathSegment(value)}`)
    out.add(`/${browserPathSegment(value)}`)
  }
  for (const sample of SAMPLES) {
    out.add(`/${encodePathSegment(sample)}`)
    out.add(`/${browserPathSegment(sample)}`)
  }
  return [...out].filter((path) => !/^\/(?:\.|%2[Ee]){1,2}$/.test(path)).sort()
}

function rawRequest(port: number, target: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
    })
    let text = ""
    socket.on("data", (chunk) => {
      text += chunk
    })
    socket.on("error", (error) => resolve(`ERR ${error.message}`))
    socket.on("close", () => {
      const at = text.indexOf("\r\n\r\n")
      resolve(at === -1 ? text.split("\r\n")[0]! : text.slice(at + 4))
    })
  })
}

/**
 * Send every spelling as a raw request target to a server that answers with the path it received, and
 * return those it altered. The server is the runtime's own listener, so this is the runtime's parsing.
 */
export async function passThroughMismatches(port: number): Promise<string[]> {
  const found: string[] = []
  for (const target of spellings()) {
    const answer = await rawRequest(port, target)
    if (answer !== target) found.push(`${target} reached the handler as ${answer}`)
  }
  return found
}

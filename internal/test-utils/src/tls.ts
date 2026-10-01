/**
 * A throwaway self-signed TLS certificate for `localhost` and `127.0.0.1`, minted in memory with Web
 * Crypto. TLS tests then run the same way on Bun, Node and Deno: no `openssl` on the PATH, no extra
 * permissions, and no private key committed to the repository.
 *
 * The certificate is an X.509 v3 end-entity certificate with an ECDSA P-256 key, valid from a day ago
 * to a day from now, naming both hosts in its subjectAltName. It has no basicConstraints, so verifiers
 * that refuse a CA certificate as a server's own (rustls, Deno's client) accept it as a trust anchor
 * for itself.
 */

/** A PEM certificate and its PKCS #8 private key. */
export interface SelfSignedCertificate {
  readonly cert: string
  readonly key: string
}

const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2"
const COMMON_NAME = "2.5.4.3"
const SUBJECT_ALT_NAME = "2.5.29.17"

/** One DER element: tag, definite length, then the concatenated contents. */
function der(tag: number, ...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const head =
    length < 0x80
      ? [tag, length]
      : length < 0x100
        ? [tag, 0x81, length]
        : [tag, 0x82, length >> 8, length & 0xff]
  const out = new Uint8Array(head.length + length)
  out.set(head)
  let offset = head.length
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const sequence = (...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => der(0x30, ...parts)
const text = (value: string): Uint8Array => new TextEncoder().encode(value)

function objectId(dotted: string): Uint8Array {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number)
  const bytes = [first * 40 + second]
  for (const arc of rest) {
    const groups = [arc & 0x7f]
    for (let value = arc >> 7; value > 0; value >>= 7) groups.unshift((value & 0x7f) | 0x80)
    bytes.push(...groups)
  }
  return der(0x06, new Uint8Array(bytes))
}

/** A non-negative INTEGER from big-endian magnitude bytes: no redundant leading zeros, and one zero
 * prepended when the top bit would otherwise read as a sign. */
function integer(magnitude: Uint8Array): Uint8Array {
  let start = 0
  while (start < magnitude.length - 1 && magnitude[start] === 0) start += 1
  const trimmed = magnitude.subarray(start)
  return (trimmed[0] ?? 0) >= 0x80 ? der(0x02, new Uint8Array([0]), trimmed) : der(0x02, trimmed)
}

function utcTime(date: Date): Uint8Array {
  const two = (value: number): string => String(value).padStart(2, "0")
  return der(
    0x17,
    text(
      `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}` +
        `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`,
    ),
  )
}

const name = (commonName: string): Uint8Array =>
  sequence(der(0x31, sequence(objectId(COMMON_NAME), der(0x0c, text(commonName)))))

function pem(label: string, bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const lines = btoa(binary).match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

/** Mint a fresh certificate and key. Each call uses a new key pair and serial number. */
export async function selfSignedCertificate(): Promise<SelfSignedCertificate> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey))
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey))
  const serial = crypto.getRandomValues(new Uint8Array(16))
  serial[0] = (serial[0] ?? 0) & 0x7f
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const signatureAlgorithm = sequence(objectId(ECDSA_WITH_SHA256))
  const altNames = sequence(der(0x82, text("localhost")), der(0x87, new Uint8Array([127, 0, 0, 1])))
  const tbs = sequence(
    der(0xa0, integer(new Uint8Array([2]))),
    integer(serial),
    signatureAlgorithm,
    name("localhost"),
    sequence(utcTime(new Date(now - day)), utcTime(new Date(now + day))),
    name("localhost"),
    spki,
    der(0xa3, sequence(sequence(objectId(SUBJECT_ALT_NAME), der(0x04, altNames)))),
  )
  // Web Crypto signs ECDSA as raw r || s; X.509 carries it as a DER SEQUENCE of two INTEGERs.
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, tbs),
  )
  const signature = sequence(integer(raw.subarray(0, 32)), integer(raw.subarray(32)))
  const certificate = sequence(tbs, signatureAlgorithm, der(0x03, new Uint8Array([0]), signature))
  return { cert: pem("CERTIFICATE", certificate), key: pem("PRIVATE KEY", pkcs8) }
}

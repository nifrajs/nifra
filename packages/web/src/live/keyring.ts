/**
 * The live keyring: AES-256-GCM grants under hourly per-process subkeys, and the HMAC tags and subject
 * tags derived from the same secrets. Everything here is WebCrypto, so it runs unchanged on Bun, Node,
 * Deno and Workers.
 *
 * Token: `base64url(kid || nonce || AES-256-GCM(JSON claims))`, with the 16-byte `kid` authenticated as
 * associated data. `kid = secretId (4) || processId (8) || hour (4)`.
 */

const TEXT = new TextEncoder()
const UTF8 = new TextDecoder("utf-8", { fatal: true })

export const MIN_SECRET_BYTES = 32
export const MAX_SECRETS = 3
/** A grant token longer than this is refused before decoding, and never issued. */
export const MAX_GRANT_CHARS = 10_240
export const MAX_KEYS_PER_FRAME = 64
/** The cache-tag charset: a letter, then up to 127 of `A-Z a-z 0-9 . _ : / -`. */
export const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/
export const SID_PATTERN = /^[0-9a-f]{32}$/

const KID_BYTES = 16
const NONCE_BYTES = 12
const GCM_TAG_BYTES = 16
const HOUR_MS = 3_600_000
const HOUR_SECONDS = 3600
const IAT_SKEW_SECONDS = 60
const SUBKEY_CACHE_SIZE = 1024
const TAG_BYTES = 16
/**
 * Seals under one subkey before it refuses more. Random 96-bit nonces stay safe for about 2^32
 * encryptions per key; an hourly per-process subkey at 10,000 grants a second sees 3.6e7.
 */
export const MAX_SEALS_PER_SUBKEY = 2 ** 31

const INFO_SECRET_ID = TEXT.encode("nifra live secret id v1")
const INFO_GRANT = TEXT.encode("nifra live grant v1")
const INFO_TAG = TEXT.encode("nifra live tag v1")
const INFO_SUBJECT = TEXT.encode("nifra live subject v1")
const NO_SALT = new Uint8Array(0)

export interface GrantOwner {
  /** The keys the owner's loader declared. */
  readonly k: readonly string[]
  /** The bus seq read before the owner's data was loaded. */
  readonly w: number
}

export interface GrantClaims {
  readonly v: 1
  readonly sid: string
  readonly sub: string | null
  readonly path: string
  readonly frame: string
  readonly owners: Readonly<Record<string, GrantOwner>>
  /** The seq read at issuance: revocations above it refuse the grant. */
  readonly s: number
  /** Renewals re-signed without loaders since the last load that ran them all. */
  readonly r: number
  readonly iat: number
  readonly exp: number
  readonly aud: string
}

export type GrantInput = Omit<GrantClaims, "v" | "iat" | "exp" | "aud">

export interface OpenedGrant {
  readonly claims: GrantClaims
  /** Index of the secret that decrypted it; that secret also derives the grant's tags. */
  readonly secret: number
}

export interface Keyring {
  readonly appId: string
  /** Grant lifetime in seconds. */
  readonly ttl: number
  readonly secretCount: number
  /**
   * Encrypt under the first secret; `undefined` when the token would exceed {@link MAX_GRANT_CHARS} or
   * the hour's subkey reached {@link MAX_SEALS_PER_SUBKEY}.
   */
  seal(input: GrantInput, nowMs: number): Promise<string | undefined>
  /** Authenticate and decrypt, or `undefined` for anything not issued by this keyring and still valid. */
  open(token: unknown, nowMs: number): Promise<OpenedGrant | undefined>
  /** The 128-bit wire tag of a key under one secret (default: the first). */
  tag(key: string, secret?: number): Promise<string>
  /** A stable opaque tag for the subject, under the first secret. */
  subjectTag(subject: string | null): Promise<string>
}

/** A rotation list: newest first, never empty. */
export type LiveSecrets = readonly [string, ...string[]]

export interface KeyringOptions {
  readonly secrets: LiveSecrets
  readonly appId: string
  readonly ttl: number
  /** Fixed per process; random when omitted. Tests pin it. */
  readonly processId?: Uint8Array
  /** Tests lower it; see {@link MAX_SEALS_PER_SUBKEY}. */
  readonly maxSealsPerSubkey?: number
}

interface SecretEntry {
  readonly index: number
  readonly base: CryptoKey
  readonly id: Uint8Array<ArrayBuffer>
  readonly idKey: number
  readonly tagKey: CryptoKey
}

/** Synchronous boot checks: count and strength. Duplicate ids need derivation, see {@link createKeyring}. */
export function assertLiveSecrets(secrets: readonly unknown[]): asserts secrets is LiveSecrets {
  if (secrets.length === 0) throw new TypeError("[nifra/web] live: `secret` lists no secret")
  if (secrets.length > MAX_SECRETS) {
    throw new TypeError(
      `[nifra/web] live: \`secret\` lists ${secrets.length} secrets; at most ${MAX_SECRETS} are allowed, since every publish goes out under each one. Remove a demoted secret once grantTtl plus the renewal window has passed.`,
    )
  }
  for (const secret of secrets) {
    const length = typeof secret === "string" ? TEXT.encode(secret).length : -1
    if (length < MIN_SECRET_BYTES) {
      throw new TypeError(
        `[nifra/web] live: every secret must be a string of at least ${MIN_SECRET_BYTES} bytes (256-bit). Generate one with: openssl rand -base64 32`,
      )
    }
  }
}

/** Derive every key a secret needs. Rejects when two secrets share a `secretId`. */
export async function createKeyring(options: KeyringOptions): Promise<Keyring> {
  assertLiveSecrets(options.secrets)
  const appSalt = TEXT.encode(options.appId)
  const processId = options.processId ?? crypto.getRandomValues(new Uint8Array(8))
  if (processId.length !== 8) throw new TypeError("[nifra/web] live: processId must be 8 bytes")
  const derive = async (secret: string, index: number): Promise<SecretEntry> => {
    const base = await crypto.subtle.importKey("raw", TEXT.encode(secret), "HKDF", false, [
      "deriveBits",
      "deriveKey",
    ])
    const id = new Uint8Array(await hkdf(base, NO_SALT, INFO_SECRET_ID, 32)).slice(0, 4)
    const tagKey = await hmacKey(new Uint8Array(await hkdf(base, appSalt, INFO_TAG, 32)))
    return { index, base, id, idKey: readU32(id, 0), tagKey }
  }
  const [head, ...rest] = options.secrets
  const first = await derive(head, 0)
  const entries = [first, ...(await Promise.all(rest.map((secret, i) => derive(secret, i + 1))))]
  const byId = new Map<number, SecretEntry>()
  for (const entry of entries) {
    if (byId.has(entry.idKey)) {
      throw new TypeError(
        "[nifra/web] live: two configured secrets share a secret id; replace one of them (a repeated secret does this too)",
      )
    }
    byId.set(entry.idKey, entry)
  }
  const subjectKey = await hmacKey(
    new Uint8Array(await hkdf(first.base, appSalt, INFO_SUBJECT, 32)),
  )

  // Least recently used first: a hit is moved to the end.
  const subkeys = new Map<string, Promise<CryptoKey>>()
  const subkey = (entry: SecretEntry, kid: Uint8Array<ArrayBuffer>): Promise<CryptoKey> => {
    const name = latin1(kid)
    const cached = subkeys.get(name)
    if (cached !== undefined) {
      subkeys.delete(name)
      subkeys.set(name, cached)
      return cached
    }
    if (subkeys.size >= SUBKEY_CACHE_SIZE) {
      const oldest = subkeys.keys().next().value
      if (oldest !== undefined) subkeys.delete(oldest)
    }
    const derived = crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: kid, info: INFO_GRANT },
      entry.base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    )
    subkeys.set(name, derived)
    return derived
  }

  const ttl = options.ttl
  const appId = options.appId
  const maxSeals = options.maxSealsPerSubkey ?? MAX_SEALS_PER_SUBKEY
  // The subkey `seal` uses changes with the hour, and only `seal` encrypts.
  let sealHour = -1
  let seals = 0

  return {
    appId,
    ttl,
    secretCount: entries.length,
    async seal(input, nowMs) {
      const iat = Math.floor(nowMs / 1000)
      const hour = Math.floor(iat / HOUR_SECONDS)
      if (hour !== sealHour) {
        sealHour = hour
        seals = 0
      }
      if (seals >= maxSeals) return undefined
      seals++
      const claims: GrantClaims = { v: 1, ...input, iat, exp: iat + ttl, aud: appId }
      const kid = new Uint8Array(KID_BYTES)
      kid.set(first.id, 0)
      kid.set(processId, 4)
      writeU32(kid, 12, hour)
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: kid, tagLength: GCM_TAG_BYTES * 8 },
          await subkey(first, kid),
          TEXT.encode(JSON.stringify(claims)),
        ),
      )
      const token = new Uint8Array(KID_BYTES + NONCE_BYTES + sealed.length)
      token.set(kid, 0)
      token.set(nonce, KID_BYTES)
      token.set(sealed, KID_BYTES + NONCE_BYTES)
      const encoded = toBase64Url(token)
      return encoded.length > MAX_GRANT_CHARS ? undefined : encoded
    },
    async open(token, nowMs) {
      // Size and framing first, then the secret id and hour: none of these refusals costs any crypto.
      if (typeof token !== "string" || token.length > MAX_GRANT_CHARS) return undefined
      const bytes = fromBase64Url(token)
      if (bytes === null || bytes.length < KID_BYTES + NONCE_BYTES + GCM_TAG_BYTES) return undefined
      const entry = byId.get(readU32(bytes, 0))
      if (entry === undefined) return undefined
      const hour = readU32(bytes, 12)
      const nowHour = Math.floor(nowMs / HOUR_MS)
      if (hour !== nowHour && hour !== nowHour - 1) return undefined
      const kid = bytes.slice(0, KID_BYTES)
      let plain: ArrayBuffer
      try {
        plain = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: bytes.slice(KID_BYTES, KID_BYTES + NONCE_BYTES),
            additionalData: kid,
            tagLength: GCM_TAG_BYTES * 8,
          },
          await subkey(entry, kid),
          bytes.slice(KID_BYTES + NONCE_BYTES),
        )
      } catch {
        return undefined
      }
      let claims: unknown
      try {
        claims = JSON.parse(UTF8.decode(plain))
      } catch {
        return undefined
      }
      return validClaims(claims, appId, ttl, hour, Math.floor(nowMs / 1000))
        ? { claims, secret: entry.index }
        : undefined
    },
    async tag(key, secret = 0) {
      const tagKey = (entries[secret] ?? first).tagKey
      const mac = await crypto.subtle.sign("HMAC", tagKey, TEXT.encode(key))
      return toBase64Url(new Uint8Array(mac).slice(0, TAG_BYTES))
    },
    async subjectTag(subject) {
      // A prefix per kind: no subject string can collide with the anonymous viewer's input.
      const input = subject === null ? "a" : `s${subject}`
      const mac = await crypto.subtle.sign("HMAC", subjectKey, TEXT.encode(input))
      return toBase64Url(new Uint8Array(mac).slice(0, TAG_BYTES))
    },
  }
}

function validClaims(
  value: unknown,
  appId: string,
  ttl: number,
  hour: number,
  nowSeconds: number,
): value is GrantClaims {
  if (!isRecord(value)) return false
  const { v, sid, sub, path, frame, owners, s, r, iat, exp, aud } = value
  if (v !== 1 || aud !== appId) return false
  if (typeof sid !== "string" || !SID_PATTERN.test(sid)) return false
  if (sub !== null && typeof sub !== "string") return false
  if (typeof path !== "string" || typeof frame !== "string") return false
  if (!isCount(s) || !isCount(r) || !isInteger(iat) || !isInteger(exp)) return false
  if (iat > nowSeconds + IAT_SKEW_SECONDS) return false
  if (Math.floor(iat / HOUR_SECONDS) !== hour) return false
  if (exp - iat !== ttl || exp <= nowSeconds) return false
  if (!isRecord(owners)) return false
  let keys = 0
  for (const owner of Object.values(owners)) {
    if (!isRecord(owner) || !isCount(owner.w) || !Array.isArray(owner.k)) return false
    for (const key of owner.k) if (typeof key !== "string" || !KEY_PATTERN.test(key)) return false
    keys += owner.k.length
  }
  return keys <= MAX_KEYS_PER_FRAME
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value)

const isCount = (value: unknown): value is number => isInteger(value) && value >= 0

const hkdf = (
  base: CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<ArrayBuffer> =>
  crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, base, bytes * 8)

const hmacKey = (raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const readU32 = (bytes: Uint8Array, at: number): number => view(bytes).getUint32(at)

const writeU32 = (bytes: Uint8Array, at: number, value: number): void =>
  view(bytes).setUint32(at, value)

const latin1 = (bytes: Uint8Array): string => {
  let out = ""
  for (const byte of bytes) out += String.fromCharCode(byte)
  return out
}

export const toBase64Url = (bytes: Uint8Array): string =>
  btoa(latin1(bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

/** Canonical encodings only: a second spelling of the same bytes is refused. */
function fromBase64Url(s: string): Uint8Array<ArrayBuffer> | null {
  if (s.length === 0 || s.length % 4 === 1 || !BASE64URL_PATTERN.test(s)) return null
  const remainder = s.length % 4
  const last = BASE64URL_ALPHABET.indexOf(s.charAt(s.length - 1))
  if ((remainder === 2 && (last & 0x0f) !== 0) || (remainder === 3 && (last & 0x03) !== 0))
    return null
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - remainder) % 4))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

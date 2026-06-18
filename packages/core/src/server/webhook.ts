/**
 * Webhook signature verification — **read the raw body, verify the HMAC, *then* parse**. A handler
 * that `JSON.parse`s a webhook before checking the signature is trusting an unauthenticated payload;
 * this reads the body bounded (DoS guard, shared with `c.boundedBody`) and verifies before handing
 * back the raw text for the handler to parse with its own schema.
 *
 * Verification is **constant-time**: the provider's signature is fed to `crypto.subtle.verify`
 * (WebCrypto), which checks the HMAC without a byte-by-byte string compare — so a wrong signature
 * can't be discovered through timing. WebCrypto-only, so it runs on Bun / Node / Deno / workerd.
 *
 * Presets cover Stripe (`t=…,v1=…` with a replay-window check) and GitHub (`sha256=…`); `generic`
 * takes an explicit header + encoding for any other provider.
 */
import { requireSecretBytes } from "../internal/secret.ts"
import { readBoundedBytes } from "./body.ts"

const TEXT = new TextEncoder()
const DEFAULT_MAX_BYTES = 1024 * 1024 // 1 MiB — webhook payloads are small; cap the raw read.
const DEFAULT_TOLERANCE_SECONDS = 300 // 5-min replay window for timestamped schemes (Stripe's default).

export type WebhookProvider = "stripe" | "github" | "generic"
export type SignatureEncoding = "hex" | "base64"

export interface VerifyWebhookOptions {
  /** Known-provider preset. Default `"generic"` (which requires {@link header}). */
  readonly provider?: WebhookProvider
  /** Header carrying the signature. Required for `generic`; overrides the preset otherwise. */
  readonly header?: string
  /** How the signature is encoded in the header. Default `"hex"`. */
  readonly encoding?: SignatureEncoding
  /** A prefix stripped from the header value before decoding, e.g. `"sha256="`. */
  readonly prefix?: string
  /** Max raw body bytes to read before rejecting (`payload_too_large`). Default 1 MiB. */
  readonly maxBytes?: number
  /** Replay window in seconds for timestamped schemes (Stripe). Default 300. */
  readonly toleranceSeconds?: number
  /** Current unix time (seconds); defaults to `Date.now()/1000`. Injectable for tests. */
  readonly now?: number
}

export type WebhookFailureReason =
  | "missing_signature"
  | "invalid_signature"
  | "timestamp_out_of_tolerance"
  | "malformed_signature"
  | "payload_too_large"
  | "invalid_content_length"

/** Verified ⇒ the raw `payload` text (parse it with your schema). Rejected ⇒ a stable `reason`. */
export type WebhookResult =
  | { readonly ok: true; readonly payload: string }
  | { readonly ok: false; readonly reason: WebhookFailureReason }

interface Preset {
  readonly header: string
  readonly encoding: SignatureEncoding
  readonly prefix: string
  readonly timestamped: boolean
}

const PRESETS: Record<WebhookProvider, Preset> = {
  stripe: { header: "stripe-signature", encoding: "hex", prefix: "", timestamped: true },
  github: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=", timestamped: false },
  generic: { header: "", encoding: "hex", prefix: "", timestamped: false },
}

const importHmacKey = (secret: string): Promise<CryptoKey> => {
  requireSecretBytes(secret, "webhook")
  return crypto.subtle.importKey(
    "raw",
    TEXT.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  )
}

// Decoders return `Uint8Array<ArrayBuffer>` (not the generic `Uint8Array<ArrayBufferLike>`) so they
// satisfy WebCrypto's `BufferSource` parameter under TS 5.7+'s typed-array generics. `null` = the
// header value wasn't valid for the declared encoding (treated as a malformed signature, never a 500).
const fromHex = (hex: string): Uint8Array<ArrayBuffer> | null => {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const fromBase64 = (value: string): Uint8Array<ArrayBuffer> | null => {
  try {
    const bin = atob(value)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

const decodeSignature = (
  value: string,
  encoding: SignatureEncoding,
): Uint8Array<ArrayBuffer> | null => (encoding === "hex" ? fromHex(value) : fromBase64(value))

/** True iff `sig` is a valid HMAC-SHA256 of `payload` under any of `keys` (constant-time per check). */
async function verifyAny(
  keys: readonly CryptoKey[],
  sig: Uint8Array<ArrayBuffer>,
  payload: Uint8Array,
): Promise<boolean> {
  for (const key of keys) {
    if (await crypto.subtle.verify("HMAC", key, sig, payload as Uint8Array<ArrayBuffer>))
      return true
  }
  return false
}

// Parse a Stripe `Stripe-Signature` header: `t=<unix>,v1=<hex>[,v1=<hex>…]` (other schemes ignored).
function parseStripeHeader(value: string): { t: number; v1: string[] } | null {
  let t: number | null = null
  const v1: string[] = []
  for (const part of value.split(",")) {
    const eq = part.indexOf("=")
    if (eq < 1) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k === "t") {
      if (!/^\d+$/.test(v)) return null
      t = Number(v)
    } else if (k === "v1") {
      v1.push(v)
    }
  }
  if (t === null || v1.length === 0) return null
  return { t, v1 }
}

/**
 * Verify a webhook request's signature and return its raw payload. Reads `req.body` (bounded), so the
 * body is consumed — parse the returned `payload`, don't re-read the request.
 *
 * @param secret the signing secret (or an array, to accept either during a secret rotation).
 *
 * @example
 * ```ts
 * const r = await verifyWebhook(c.req, env.STRIPE_WEBHOOK_SECRET, { provider: "stripe" })
 * if (!r.ok) return c.json({ ok: false, error: r.reason }, 400)
 * const event = StripeEvent.parse(JSON.parse(r.payload)) // validate at the trust boundary
 * ```
 */
export async function verifyWebhook(
  req: Request,
  secret: string | readonly string[],
  options: VerifyWebhookOptions = {},
): Promise<WebhookResult> {
  const provider = options.provider ?? "generic"
  const preset = PRESETS[provider]
  const headerName = (options.header ?? preset.header).toLowerCase()
  if (headerName === "") {
    throw new Error('[nifra] verifyWebhook: a `header` is required for provider "generic"')
  }
  const encoding = options.encoding ?? preset.encoding
  const prefix = options.prefix ?? preset.prefix

  const read = await readBoundedBytes(req, options.maxBytes ?? DEFAULT_MAX_BYTES)
  if (!read.ok) {
    return {
      ok: false,
      reason: read.status === 413 ? "payload_too_large" : "invalid_content_length",
    }
  }
  const payload = new TextDecoder().decode(read.bytes)

  const headerValue = req.headers.get(headerName)
  if (headerValue === null || headerValue === "") return { ok: false, reason: "missing_signature" }

  const secrets = typeof secret === "string" ? [secret] : secret
  const keys = await Promise.all(secrets.map(importHmacKey))

  if (preset.timestamped) {
    const parsed = parseStripeHeader(headerValue)
    if (parsed === null) return { ok: false, reason: "malformed_signature" }
    const signedPayload = TEXT.encode(`${parsed.t}.${payload}`)
    let matched = false
    for (const v1 of parsed.v1) {
      const sig = decodeSignature(v1, encoding)
      if (sig !== null && (await verifyAny(keys, sig, signedPayload))) {
        matched = true
        break
      }
    }
    if (!matched) return { ok: false, reason: "invalid_signature" }
    // The signature covers `t`, so `t` is authentic once matched — now enforce the replay window.
    const now = options.now ?? Math.floor(Date.now() / 1000)
    const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
    if (Math.abs(now - parsed.t) > tolerance) {
      return { ok: false, reason: "timestamp_out_of_tolerance" }
    }
    return { ok: true, payload }
  }

  const raw =
    prefix !== "" && headerValue.startsWith(prefix) ? headerValue.slice(prefix.length) : headerValue
  const sig = decodeSignature(raw, encoding)
  if (sig === null) return { ok: false, reason: "malformed_signature" }
  if (await verifyAny(keys, sig, read.bytes)) return { ok: true, payload }
  return { ok: false, reason: "invalid_signature" }
}

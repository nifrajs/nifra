import { FRAMEWORK_NAME } from "./brand.ts"

/** Minimum HMAC secret strength: 256 bits, matching the SHA-256 block the framework signs with.
 * A shorter key weakens every signature it backs (cookies, sessions, webhooks, signed URLs). */
const MIN_SECRET_BYTES = 32

const SECRET_ENCODER = new TextEncoder()

/**
 * Boot-time guard: reject an HMAC secret under 256 bits, loudly, at construction — never at the
 * first request. UTF-8 byte length (not char count), so a multibyte secret is measured honestly.
 * The single source of truth for the framework's secret-strength floor; every HMAC entry point
 * (signed cookies, `@nifrajs/auth` sessions, webhook verification, signed upload/image URLs) routes
 * its secret through here so the bar can't drift between them.
 */
export function requireSecretBytes(secret: string | Uint8Array, label: string): void {
  const length =
    typeof secret === "string" ? SECRET_ENCODER.encode(secret).length : secret.byteLength
  if (length < MIN_SECRET_BYTES) {
    throw new Error(
      `[${FRAMEWORK_NAME}] ${label} secret must be at least ${MIN_SECRET_BYTES} bytes (256-bit); got ${length}. Generate one with: openssl rand -base64 32`,
    )
  }
}

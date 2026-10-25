/**
 * The digest a live load gives each granted key for query hooks: HMAC-SHA-256 under a salt fresh per
 * load, the first 16 bytes in base64url. A page's queries name the keys they read and find the load's
 * tag for each one without the load ever sending key text. Shared by the server and the browser.
 */

const TEXT = new TextEncoder()
const DIGEST_BYTES = 16
const SALT_BYTES = 16

export function querySalt(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(SALT_BYTES)))
}

/** Digests keys under one salt, importing the salt once. */
export async function queryDigester(salt: string): Promise<(key: string) => Promise<string>> {
  const secret = await crypto.subtle.importKey(
    "raw",
    TEXT.encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return async (key) =>
    base64url(
      new Uint8Array(await crypto.subtle.sign("HMAC", secret, TEXT.encode(key)), 0, DIGEST_BYTES),
    )
}

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/={1,2}$/, "")
}

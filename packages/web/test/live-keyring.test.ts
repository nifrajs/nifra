import { afterEach, expect, spyOn, test } from "bun:test"
import {
  assertLiveSecrets,
  createKeyring,
  type GrantClaims,
  type GrantInput,
  type LiveSecrets,
  MAX_GRANT_CHARS,
  toBase64Url,
} from "../src/live/keyring.ts"
import { grantTtlOf } from "../src/live/settings.ts"

const TEXT = new TextEncoder()
const SECRET_A = "a".repeat(32)
const SECRET_B = "b".repeat(32)
const SECRET_C = "c".repeat(32)
const APP = "test-app"
const TTL = 600
const HOUR_MS = 3_600_000
// Mid-hour, so a grant sealed now opens in the same hour.
const NOW = 1_800_000_000_000 + HOUR_MS / 2
const SID = "0123456789abcdef0123456789abcdef"

const input = (overrides: Partial<GrantInput> = {}): GrantInput => ({
  sid: SID,
  sub: "user-1",
  path: "/posts/42",
  frame: "page",
  owners: { "L:_layout": { k: ["site:nav"], w: 3 }, "P:posts/[id]": { k: ["post:42"], w: 3 } },
  s: 3,
  r: 0,
  ...overrides,
})

const ring = (secrets: LiveSecrets = [SECRET_A], appId = APP) =>
  createKeyring({ secrets, appId, ttl: TTL })

const must = (token: string | undefined): string => {
  if (token === undefined) throw new Error("expected a sealed token")
  return token
}

const hkdf = async (secret: string, salt: Uint8Array<ArrayBuffer>, info: string, bytes = 32) => {
  const base = await crypto.subtle.importKey("raw", TEXT.encode(secret), "HKDF", false, [
    "deriveBits",
  ])
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: TEXT.encode(info) },
      base,
      bytes * 8,
    ),
  )
}

/**
 * Builds a token by the spec's wire format, independently of the keyring: `kid = secretId || processId
 * || hour`, subkey by HKDF(secret, kid, "nifra live grant v1"), AES-256-GCM with `kid` as AAD. Forging
 * claims the keyring would never seal is how the post-decryption checks are reached.
 */
const forge = async (
  secret: string,
  claims: Record<string, unknown>,
  hour: number,
  processId: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8],
): Promise<string> => {
  const kid = new Uint8Array(16)
  kid.set((await hkdf(secret, new Uint8Array(0), "nifra live secret id v1")).slice(0, 4), 0)
  kid.set(processId, 4)
  new DataView(kid.buffer).setUint32(12, hour)
  const subkey = await crypto.subtle.importKey(
    "raw",
    await hkdf(secret, kid, "nifra live grant v1"),
    "AES-GCM",
    false,
    ["encrypt"],
  )
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: kid },
      subkey,
      TEXT.encode(JSON.stringify(claims)),
    ),
  )
  return toBase64Url(new Uint8Array([...kid, ...nonce, ...sealed]))
}

const nowSeconds = Math.floor(NOW / 1000)
const nowHour = Math.floor(NOW / HOUR_MS)
const claimsAt = (
  iat: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  v: 1,
  ...input(),
  iat,
  exp: iat + TTL,
  aud: APP,
  ...overrides,
})

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

test("a sealed grant opens to the same claims under the secret that sealed it", async () => {
  const keyring = await ring()
  const token = await keyring.seal(input(), NOW)
  expect(typeof token).toBe("string")
  const opened = await keyring.open(token, NOW)
  expect(opened?.secret).toBe(0)
  expect(opened?.claims).toEqual({
    v: 1,
    ...input(),
    iat: nowSeconds,
    exp: nowSeconds + TTL,
    aud: APP,
  } satisfies GrantClaims)
})

test("the token is opaque: no subject, key, path or watermark reads out of it", async () => {
  const keyring = await ring()
  const token = must(await keyring.seal(input({ sub: "alice@example.com" }), NOW))
  const raw = atob(token.replace(/-/g, "+").replace(/_/g, "/"))
  for (const text of ["alice", "post:42", "/posts/42", "site:nav", '"w"']) {
    expect(raw.includes(text)).toBe(false)
  }
})

test("a forged token by the spec's own derivation opens: the wire format is the spec's", async () => {
  const keyring = await ring()
  const token = await forge(SECRET_A, claimsAt(nowSeconds), nowHour)
  expect((await keyring.open(token, NOW))?.claims.sub).toBe("user-1")
})

test("tampering anywhere in the token is refused: kid, nonce, ciphertext, tag", async () => {
  const keyring = await ring()
  const token = must(await keyring.seal(input(), NOW))
  const bytes = Uint8Array.from(atob(token.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  )
  // processId byte (authenticated as AAD), a nonce byte, a ciphertext byte, the last tag byte.
  for (const at of [6, 20, 30, bytes.length - 1]) {
    const flipped = bytes.slice()
    flipped[at] = (flipped[at] ?? 0) ^ 1
    expect(await keyring.open(toBase64Url(flipped), NOW)).toBeUndefined()
  }
  expect(await keyring.open(token.slice(0, -4), NOW)).toBeUndefined()
  expect(await keyring.open(`${token}A`, NOW)).toBeUndefined()
  expect(await keyring.open("", NOW)).toBeUndefined()
  expect(await keyring.open(42, NOW)).toBeUndefined()
  expect(await keyring.open("not base64!", NOW)).toBeUndefined()
})

test("a non-canonical base64url spelling of a valid token is refused", async () => {
  const keyring = await ring()
  // A length that leaves unused bits in the last character: vary the subject until it does.
  let token = ""
  for (let pad = 0; token.length % 4 === 0; pad++) {
    token = must(await keyring.seal(input({ sub: "u".repeat(pad) }), NOW))
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  const last = alphabet.indexOf(token.charAt(token.length - 1))
  const remainder = token.length % 4
  expect(remainder === 2 || remainder === 3).toBe(true)
  // Set an unused low bit: the same bytes, spelled differently.
  const respelled = token.slice(0, -1) + alphabet.charAt(last | 1)
  expect(await keyring.open(respelled, NOW)).toBeUndefined()
})

test("a grant past its expiry is refused, one second before it is not", async () => {
  const keyring = await ring()
  const token = must(await keyring.seal(input(), NOW))
  expect(await keyring.open(token, NOW + (TTL - 1) * 1000)).toBeDefined()
  expect(await keyring.open(token, NOW + TTL * 1000)).toBeUndefined()
})

test("rotation: a grant sealed under a demoted secret opens with that secret's index", async () => {
  const before = await ring([SECRET_A])
  const token = must(await before.seal(input(), NOW))
  const rotated = await ring([SECRET_B, SECRET_A])
  const opened = await rotated.open(token, NOW)
  expect(opened?.secret).toBe(1)
  // The grant's own secret derives its tags, so its subscriptions match what it was issued with.
  expect(await rotated.tag("post:42", 1)).toBe(await before.tag("post:42"))
  expect(await rotated.tag("post:42")).not.toBe(await before.tag("post:42"))
  // New grants seal under the new first secret.
  expect((await rotated.open(await rotated.seal(input(), NOW), NOW))?.secret).toBe(0)
  // A secret removed from the list: its grants no longer open.
  expect(await (await ring([SECRET_B])).open(token, NOW)).toBeUndefined()
})

test("an unknown secret id is refused before any crypto runs", async () => {
  const keyring = await ring()
  const foreign = must(await (await ring([SECRET_C])).seal(input(), NOW))
  spies.push(
    spyOn(crypto.subtle, "decrypt"),
    spyOn(crypto.subtle, "deriveKey"),
    spyOn(crypto.subtle, "deriveBits"),
    spyOn(crypto.subtle, "importKey"),
  )
  expect(await keyring.open(foreign, NOW)).toBeUndefined()
  for (const spy of spies) expect(spy).not.toHaveBeenCalled()
})

test("an oversized token is refused before decoding or crypto", async () => {
  const keyring = await ring()
  const decrypt = spyOn(crypto.subtle, "decrypt")
  spies.push(decrypt)
  const atobSpy = spyOn(globalThis, "atob")
  spies.push(atobSpy)
  expect(await keyring.open("A".repeat(MAX_GRANT_CHARS + 1), NOW)).toBeUndefined()
  expect(atobSpy).not.toHaveBeenCalled()
  expect(decrypt).not.toHaveBeenCalled()
})

test("a kid hour in the future, or older than the previous hour, is refused before derivation", async () => {
  const keyring = await ring()
  const future = await forge(SECRET_A, claimsAt(nowSeconds), nowHour + 1)
  const stale = await forge(SECRET_A, claimsAt(nowSeconds), nowHour - 2)
  const derive = spyOn(crypto.subtle, "deriveKey")
  spies.push(derive)
  expect(await keyring.open(future, NOW)).toBeUndefined()
  expect(await keyring.open(stale, NOW)).toBeUndefined()
  expect(derive).not.toHaveBeenCalled()
})

test("the previous hour's kid still opens: a grant issued at the end of an hour", async () => {
  const keyring = await ring()
  const lastHour = Math.floor((NOW - HOUR_MS) / 1000)
  const longTtl = await createKeyring({ secrets: [SECRET_A], appId: APP, ttl: 7200 })
  const token = await forge(SECRET_A, { ...claimsAt(lastHour), exp: lastHour + 7200 }, nowHour - 1)
  expect(await longTtl.open(token, NOW)).toBeDefined()
  expect(await keyring.open(token, NOW)).toBeUndefined()
})

test("a kid hour that is not the iat hour is refused", async () => {
  const keyring = await ring()
  // Sealed in the previous hour's kid but claiming an iat in this hour.
  const token = await forge(SECRET_A, claimsAt(nowSeconds), nowHour - 1)
  expect(await keyring.open(token, NOW)).toBeUndefined()
})

test("an iat more than 60 seconds ahead is refused; exactly 60 is clock skew", async () => {
  const keyring = await ring()
  expect(
    await keyring.open(await forge(SECRET_A, claimsAt(nowSeconds + 61), nowHour), NOW),
  ).toBeUndefined()
  expect(
    await keyring.open(await forge(SECRET_A, claimsAt(nowSeconds + 60), nowHour), NOW),
  ).toBeDefined()
})

test("exp - iat must equal the configured TTL: longer and shorter are both refused", async () => {
  const keyring = await ring()
  for (const exp of [nowSeconds + TTL + 1, nowSeconds + TTL - 1, nowSeconds + 86_400]) {
    const token = await forge(SECRET_A, claimsAt(nowSeconds, { exp }), nowHour)
    expect(await keyring.open(token, NOW)).toBeUndefined()
  }
})

test("claims of another app, or of a malformed shape, are refused after decryption", async () => {
  const keyring = await ring()
  const bad: Array<Record<string, unknown>> = [
    { aud: "other-app" },
    { v: 2 },
    { sid: "not-a-sid" },
    { sub: 42 },
    { path: 7 },
    { frame: null },
    { s: -1 },
    { s: 1.5 },
    { iat: "now" },
    { owners: [] },
    { owners: { "P:x": { k: ["ok"], w: -1 } } },
    { owners: { "P:x": { k: ["has space"], w: 1 } } },
    { owners: { "P:x": { k: "post:1", w: 1 } } },
    { owners: { "P:x": null } },
    { owners: { "P:x": { k: Array.from({ length: 65 }, (_, i) => `k${i}`), w: 1 } } },
  ]
  for (const override of bad) {
    const token = await forge(SECRET_A, claimsAt(nowSeconds, override), nowHour)
    expect(await keyring.open(token, NOW)).toBeUndefined()
  }
})

test("a token that decrypts to something other than JSON claims is refused", async () => {
  const keyring = await ring()
  const kid = new Uint8Array(16)
  kid.set((await hkdf(SECRET_A, new Uint8Array(0), "nifra live secret id v1")).slice(0, 4), 0)
  new DataView(kid.buffer).setUint32(12, nowHour)
  const subkey = await crypto.subtle.importKey(
    "raw",
    await hkdf(SECRET_A, kid, "nifra live grant v1"),
    "AES-GCM",
    false,
    ["encrypt"],
  )
  const nonce = new Uint8Array(12)
  for (const plain of [TEXT.encode("not json"), new Uint8Array([0xff, 0xfe]), TEXT.encode("[1]")]) {
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: kid },
        subkey,
        plain,
      ),
    )
    expect(
      await keyring.open(toBase64Url(new Uint8Array([...kid, ...nonce, ...sealed])), NOW),
    ).toBeUndefined()
  }
})

test("a grant too large to carry is never issued", async () => {
  const keyring = await ring()
  const keys = Array.from({ length: 64 }, (_, i) => `k${i}`.padEnd(128, "x"))
  expect(await keyring.seal(input({ owners: { "P:x": { k: keys, w: 1 } } }), NOW)).toBeUndefined()
})

test("tags are 128-bit HMACs under the app-salted tag key, and differ per app and secret", async () => {
  const keyring = await ring()
  const tag = await keyring.tag("post:42")
  expect(tag).toMatch(/^[A-Za-z0-9_-]{22}$/)
  const key = await crypto.subtle.importKey(
    "raw",
    await hkdf(SECRET_A, TEXT.encode(APP), "nifra live tag v1"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, TEXT.encode("post:42")))
  expect(tag).toBe(toBase64Url(mac.slice(0, 16)))
  expect(await (await ring([SECRET_A], "other-app")).tag("post:42")).not.toBe(tag)
  expect(await (await ring([SECRET_B])).tag("post:42")).not.toBe(tag)
  expect(await keyring.tag("post:43")).not.toBe(tag)
})

test("the subject tag is stable per viewer, opaque, and differs between viewers", async () => {
  const keyring = await ring()
  const [alice] = await keyring.subjectTags("alice")
  expect(await keyring.subjectTags("alice")).toEqual([alice ?? ""])
  expect(alice).toMatch(/^[A-Za-z0-9_-]{22}$/)
  expect(alice?.includes("alice")).toBe(false)
  const others = await Promise.all(
    ["bob", null, "", "a"].map(async (subject) => (await keyring.subjectTags(subject))[0]),
  )
  expect(new Set([alice, ...others]).size).toBe(5)
  expect(await (await ring([SECRET_A], "other-app")).subjectTags("alice")).not.toEqual([alice])
})

test("rotation: a viewer keeps one subject tag in common between a process on [old] and one on [new, old]", async () => {
  const before = await (await ring([SECRET_A])).subjectTags("alice")
  const during = await (await ring([SECRET_B, SECRET_A])).subjectTags("alice")
  const after = await (await ring([SECRET_B])).subjectTags("alice")
  expect(during).toHaveLength(2)
  // Newest first: the old secret's tag is the same viewer's tag on the process not yet rotated.
  expect(during[1]).toBe(before[0] ?? "")
  expect(during[0]).toBe(after[0] ?? "")
  const bob = await (await ring([SECRET_B, SECRET_A])).subjectTags("bob")
  expect(bob.some((tag) => during.includes(tag))).toBe(false)
})

test("boot: at most 3 secrets, each at least 32 bytes", () => {
  expect(() => assertLiveSecrets([SECRET_A, SECRET_B, SECRET_C])).not.toThrow()
  expect(() => assertLiveSecrets([SECRET_A, SECRET_B, SECRET_C, "d".repeat(32)])).toThrow(
    /at most 3/,
  )
  expect(() => assertLiveSecrets([])).toThrow(/no secret/)
  expect(() => assertLiveSecrets(["short"])).toThrow(/at least 32 bytes/)
  expect(() => assertLiveSecrets([42])).toThrow(/at least 32 bytes/)
})

test("boot: two secrets sharing a secret id fail, including a real 4-byte collision", async () => {
  await expect(ring([SECRET_A, SECRET_A])).rejects.toThrow(/share a secret id/)
  // Found offline by a birthday search: different secrets, the same first 4 bytes of their id.
  const one = "live-secret-id-collision-fixture-14969"
  const two = "live-secret-id-collision-fixture-53199"
  const ids = await Promise.all(
    [one, two].map(async (s) =>
      (await hkdf(s, new Uint8Array(0), "nifra live secret id v1")).slice(0, 4),
    ),
  )
  expect(ids[0]).toEqual(ids[1])
  await expect(ring([one, two])).rejects.toThrow(/share a secret id/)
  await expect(ring([one, SECRET_A])).resolves.toBeDefined()
})

test("a pinned process id must be 8 bytes", async () => {
  await expect(
    createKeyring({ secrets: [SECRET_A], appId: APP, ttl: TTL, processId: new Uint8Array(4) }),
  ).rejects.toThrow(/8 bytes/)
  const pinned = await createKeyring({
    secrets: [SECRET_A],
    appId: APP,
    ttl: TTL,
    processId: new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]),
  })
  const token = must(await pinned.seal(input(), NOW))
  const bytes = atob(token.slice(0, 22).replace(/-/g, "+").replace(/_/g, "/"))
  expect([...bytes.slice(4, 12)].map((c) => c.charCodeAt(0))).toEqual([9, 9, 9, 9, 9, 9, 9, 9])
})

test("derived subkeys are cached per kid, least recently used out, at most 1,024", async () => {
  const keyring = await ring()
  const tokenFor = (n: number) =>
    forge(SECRET_A, claimsAt(nowSeconds), nowHour, [0, 0, 0, 0, 0, 0, n >> 8, n & 0xff])
  const tokens = await Promise.all(Array.from({ length: 1026 }, (_, n) => tokenFor(n)))
  const derive = spyOn(crypto.subtle, "deriveKey")
  spies.push(derive)
  expect(await keyring.open(tokens[0], NOW)).toBeDefined()
  expect(await keyring.open(tokens[0], NOW)).toBeDefined()
  expect(derive).toHaveBeenCalledTimes(1)
  for (let n = 1; n <= 1024; n++) await keyring.open(tokens[n], NOW)
  expect(derive).toHaveBeenCalledTimes(1025)
  // Token 0 was the least recently used when the 1,025th kid arrived: it was evicted.
  await keyring.open(tokens[0], NOW)
  expect(derive).toHaveBeenCalledTimes(1026)
  // Token 1024 is still cached.
  await keyring.open(tokens[1024], NOW)
  expect(derive).toHaveBeenCalledTimes(1026)
})

test("a forged token never takes a cache slot: real subkeys stay cached past any number of forgeries", async () => {
  const keyring = await ring()
  const real = must(await keyring.seal(input(), NOW))
  const sealed = Uint8Array.from(atob(real.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  )
  // The secret id is public in every token; the forger lacks only the secret itself. The real
  // token's own process id bytes are skipped: with them the forgery is the real token, which opens.
  const own = new DataView(sealed.buffer).getUint16(10)
  const forged = Array.from({ length: 1100 }, (_, n) => {
    const bytes = sealed.slice()
    new DataView(bytes.buffer).setUint16(10, n < own ? n : n + 1)
    return toBase64Url(bytes)
  })
  const derive = spyOn(crypto.subtle, "deriveKey")
  spies.push(derive)
  for (const token of forged) expect(await keyring.open(token, NOW)).toBeUndefined()
  expect(derive).toHaveBeenCalledTimes(1100)
  expect(await keyring.open(real, NOW)).toBeDefined()
  expect(derive).toHaveBeenCalledTimes(1100)
})

test("grantTtl tops out at an hour, and an hour-long grant opens until its last second", async () => {
  expect(() => grantTtlOf(3601)).toThrow("from 60 to 3600")
  expect(grantTtlOf(3600)).toBe(3600)
  const keyring = await createKeyring({ secrets: [SECRET_A], appId: APP, ttl: 3600 })
  // Sealed in the last second of an hour: it lives through the whole of the next one.
  const hourEnd = (nowHour + 1) * HOUR_MS - 1000
  const token = must(await keyring.seal(input(), hourEnd))
  expect(await keyring.open(token, hourEnd + 3_598_000)).toBeDefined()
  expect(await keyring.open(token, hourEnd + 3_600_000)).toBeUndefined()
})

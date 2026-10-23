import { describe, expect, test } from "bun:test"
import * as nodeCrypto from "node:crypto"
import { isStoreSecret, type StoreSigner, storeSigner } from "../src/internal/store-signature.ts"

let secrets = 0
// The process keeps one signer per secret, so each test signs under a secret of its own.
const freshSecret = (): string => `store-signature-test-secret-${++secrets}-0123456789abcdef`

/** Runs `run` with `process.getBuiltinModule` answering from `lookup`. */
function withBuiltins<T>(lookup: (id: string) => unknown, run: () => T): T {
  const original = process.getBuiltinModule
  Reflect.set(process, "getBuiltinModule", lookup)
  try {
    return run()
  } finally {
    Reflect.set(process, "getBuiltinModule", original)
  }
}

/** A signer whose HMACs are counted, on the node:crypto path. */
function countedSigner(secret = freshSecret()): { signer: StoreSigner; hashes: () => number } {
  let hashes = 0
  const counted = {
    ...nodeCrypto,
    createHmac: (...args: Parameters<typeof nodeCrypto.createHmac>) => {
      hashes++
      return nodeCrypto.createHmac(...args)
    },
  }
  const signer = withBuiltins(
    (id) => (id === "node:crypto" ? counted : undefined),
    () => storeSigner(secret),
  )
  return { signer, hashes: () => hashes }
}

/** A signer on the Web Crypto path, as on a Worker without nodejs_compat. */
function webCryptoSigner(secret: string): StoreSigner {
  return withBuiltins(
    () => undefined,
    () => storeSigner(secret),
  )
}

const texts = [
  ["plain ascii", "<p>page</p>"],
  ["latin-1", "café"],
  ["astral and cjk", "\u{1f600} 漢字"],
  ["lone surrogate", "a\ud800b"],
  ["empty", ""],
] as const

describe("store signatures", () => {
  test("a secret is a string of at least 32 characters", () => {
    expect([
      isStoreSecret("x".repeat(32)),
      isStoreSecret("x".repeat(31)),
      isStoreSecret(undefined),
      isStoreSecret(32),
    ]).toEqual([true, false, false, false])
  })

  test("node:crypto and Web Crypto sign the same bytes, so a mixed fleet shares one store", async () => {
    const secret = freshSecret()
    const web = webCryptoSigner(secret)
    const node = countedSigner()
    for (const [, text] of texts) {
      const parts = ["meta", text]
      const mac = await web.sign(parts)
      expect(mac).toMatch(/^[0-9a-f]{64}$/)
      expect(mac).toBe(
        nodeCrypto
          .createHmac("sha256", secret)
          .update(`4:meta${text.length}:`)
          .update(text)
          .digest("hex"),
      )
      expect(await web.verify(parts, mac)).toBe(true)
      expect(await webCryptoSigner(freshSecret()).verify(parts, mac)).toBe(false)
      expect(await node.signer.verify(parts, mac)).toBe(false)
    }
  })

  test("parts are hashed behind their lengths, so moving a boundary changes the MAC", async () => {
    for (const signer of [countedSigner().signer, webCryptoSigner(freshSecret())]) {
      const mac = await signer.sign(["ab", "c"])
      expect(await signer.verify(["a", "bc"], mac)).toBe(false)
      expect(await signer.verify(["abc"], mac)).toBe(false)
      expect(await signer.verify(["ab", "c", ""], mac)).toBe(false)
      expect(await signer.verify(["ab", "c"], mac)).toBe(true)
    }
  })

  test("a MAC that is not 64 lowercase hex digits fails without hashing", async () => {
    const { signer, hashes } = countedSigner()
    const mac = await signer.sign(["page"])
    for (const bad of [
      undefined,
      7,
      "",
      mac.toUpperCase(),
      mac.slice(2),
      `${mac}00`,
      "g".repeat(64),
    ]) {
      expect(await signer.verify(["page"], bad)).toBe(false)
    }
    expect(hashes()).toBe(1)
  })

  test("parts this signer proved verify again by comparison, not by hashing", async () => {
    const { signer, hashes } = countedSigner()
    const body = "<p>page</p>".repeat(100)
    const mac = await signer.sign(["meta", body])
    // Equal strings built apart, as a store's JSON parse hands them back.
    expect(await signer.verify([`me${"ta"}`, `${body}`], mac)).toBe(true)
    expect(hashes()).toBe(1)
    // The same MAC on other content is hashed, and fails.
    expect(await signer.verify(["meta", `${body}!`], mac)).toBe(false)
    expect(await signer.verify(["meta"], mac)).toBe(false)
    expect(hashes()).toBe(3)
  })

  test("parts proven by verifying are remembered too; a failure never is", async () => {
    const secret = freshSecret()
    const { signer, hashes } = countedSigner(secret)
    const mac = nodeCrypto.createHmac("sha256", secret).update("4:meta4:body").digest("hex")
    expect(await signer.verify(["meta", "body"], mac)).toBe(true)
    expect(await signer.verify(["meta", "body"], mac)).toBe(true)
    expect(hashes()).toBe(1)
    const wrong = "0".repeat(64)
    expect(await signer.verify(["meta", "body"], wrong)).toBe(false)
    expect(await signer.verify(["meta", "body"], wrong)).toBe(false)
    expect(hashes()).toBe(3)
  })

  test("the proven pages are bounded: the oldest are hashed again, and a huge page is never kept", async () => {
    const { signer, hashes } = countedSigner()
    const page = (n: number): readonly string[] => ["meta", `${n}`.padEnd(200_000, "x")]
    const macs: string[] = []
    for (let n = 0; n < 11; n++) macs.push(await signer.sign(page(n)))
    expect(hashes()).toBe(11)
    expect(await signer.verify(page(10), macs[10])).toBe(true)
    expect(hashes()).toBe(11)
    expect(await signer.verify(page(0), macs[0])).toBe(true)
    expect(hashes()).toBe(12)

    const huge = ["meta", "x".repeat(300_000)]
    const hugeMac = await signer.sign(huge)
    expect(await signer.verify(huge, hugeMac)).toBe(true)
    expect(hashes()).toBe(14)
  })

  test("one signer per secret, the oldest dropped past four", () => {
    const first = freshSecret()
    const signer = storeSigner(first)
    expect(storeSigner(first)).toBe(signer)
    for (let n = 0; n < 4; n++) storeSigner(freshSecret())
    expect(storeSigner(first)).not.toBe(signer)
  })
})

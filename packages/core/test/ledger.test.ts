import { describe, expect, test } from "bun:test"
import {
  computeEffectDigest,
  createMemoryLedgerSink,
  createRequestLedger,
  DEFAULT_MAX_ENTRIES,
  EffectLedgerOverflowError,
  EffectLedgerSealedError,
  effectLedgerOf,
  randomEffectDigestKey,
  recordCapabilityOutcome,
  type SealedEffectLedger,
  server,
  useCapability,
} from "../src/index.ts"

const ledgerOptions = { method: "POST", path: "/pay" }

describe("createRequestLedger — mechanics", () => {
  test("append assigns monotonic seq + clock time and freezes entries", () => {
    let now = 10
    const ledger = createRequestLedger({ ...ledgerOptions, clock: () => now })
    const first = ledger.append({ capability: "db.write" })
    now = 20
    const second = ledger.append({ capability: "payments.charge", phase: "intent" })
    expect(first.seq).toBe(0)
    expect(second.seq).toBe(1)
    expect(first.at).toBe(10)
    expect(second.at).toBe(20)
    expect(second.phase).toBe("intent")
    expect(Object.isFrozen(first)).toBe(true)
    expect(ledger.size).toBe(2)
  })

  test("default phase is intent; entries() is a frozen snapshot", () => {
    const ledger = createRequestLedger(ledgerOptions)
    ledger.append({ capability: "db.write" })
    const snapshot = ledger.entries()
    expect(snapshot[0]?.phase).toBe("intent")
    expect(Object.isFrozen(snapshot)).toBe(true)
    ledger.append({ capability: "db.write" })
    expect(snapshot.length).toBe(1) // snapshot does not grow
  })

  test("rejects an invalid capability, phase, target, digest, and error code", () => {
    const ledger = createRequestLedger(ledgerOptions)
    expect(() => ledger.append({ capability: "Not Valid" })).toThrow(/invalid capability/)
    expect(() => ledger.append({ capability: "db.write", phase: "boom" as never })).toThrow(
      /invalid phase/,
    )
    expect(() => ledger.append({ capability: "db.write", target: "bad\ntarget" })).toThrow(/target/)
    expect(() => ledger.append({ capability: "db.write", target: "x".repeat(129) })).toThrow(
      /target/,
    )
    expect(() => ledger.append({ capability: "db.write", digest: "zz" })).toThrow(/digest/)
    expect(() => ledger.append({ capability: "db.write", error: { code: "Kaboom!" } })).toThrow(
      /error code/,
    )
    expect(() =>
      createRequestLedger({ ...ledgerOptions, clock: () => Number.NaN }).append({
        capability: "db.write",
      }),
    ).toThrow(/clock/)
  })

  test("validates cost axes: bounded count, token keys, finite non-negative values", () => {
    const ledger = createRequestLedger(ledgerOptions)
    const entry = ledger.append({ capability: "db.write", cost: { ms: 12.5, calls: 1 } })
    expect(entry.cost).toEqual({ ms: 12.5, calls: 1 })
    expect(Object.isFrozen(entry.cost)).toBe(true)
    expect(() => ledger.append({ capability: "db.write", cost: { "Bad Key": 1 } })).toThrow(
      /cost axis/,
    )
    expect(() => ledger.append({ capability: "db.write", cost: { ms: -1 } })).toThrow(/cost axis/)
    expect(() => ledger.append({ capability: "db.write", cost: { ms: Number.NaN } })).toThrow(
      /cost axis/,
    )
    const wide = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`axis${index}`, 1]))
    expect(() => ledger.append({ capability: "db.write", cost: wide })).toThrow(/axes/)
  })

  test("no payload by construction: unknown fields never survive append", () => {
    const ledger = createRequestLedger(ledgerOptions)
    const entry = ledger.append({
      capability: "db.write",
      payload: { ssn: "1-2-3" },
      body: "secret",
    } as never)
    expect("payload" in entry).toBe(false)
    expect("body" in entry).toBe(false)
    expect(Object.keys(entry).sort()).toEqual(["at", "capability", "phase", "seq"])
  })

  test("overflow fails closed with EffectLedgerOverflowError", () => {
    const ledger = createRequestLedger({ ...ledgerOptions, maxEntries: 2 })
    ledger.append({ capability: "db.write" })
    ledger.append({ capability: "db.write" })
    expect(() => ledger.append({ capability: "db.write" })).toThrow(EffectLedgerOverflowError)
  })

  test("seal is idempotent and records the route pattern; append after seal throws", async () => {
    const ledger = createRequestLedger({ ...ledgerOptions, clock: () => 1 })
    ledger.append({ capability: "db.write" })
    const first = await ledger.seal()
    const second = await ledger.seal()
    expect(first).toBe(second)
    expect(first.method).toBe("POST")
    expect(first.path).toBe("/pay")
    expect(ledger.sealed).toBe(true)
    expect(() => ledger.append({ capability: "db.write" })).toThrow(EffectLedgerSealedError)
  })

  test("validates construction: route pattern shape, maxEntries bound", () => {
    expect(() => createRequestLedger({ method: "POST", path: "no-slash" })).toThrow(/route pattern/)
    expect(() => createRequestLedger({ ...ledgerOptions, maxEntries: 0 })).toThrow(/maxEntries/)
    expect(DEFAULT_MAX_ENTRIES).toBeGreaterThan(0)
  })
})

describe("hash chain", () => {
  test("identical ledgers under an injected clock chain to the same head", async () => {
    const build = async (): Promise<SealedEffectLedger> => {
      const ledger = createRequestLedger({ ...ledgerOptions, chain: true, clock: () => 5 })
      ledger.append({ capability: "db.write", target: "repo:orders", cost: { ms: 3 } })
      ledger.append({ capability: "payments.charge", digest: "a".repeat(64) })
      return ledger.seal()
    }
    const [a, b] = await Promise.all([build(), build()])
    expect(a.chain?.head).toBe(b.chain?.head as string)
    expect(a.chain?.hashes).toEqual(b.chain?.hashes as readonly string[])
    expect(a.chain?.hashes).toHaveLength(2)
    expect(a.chain?.head).toMatch(/^[0-9a-f]{64}$/)
  })

  test("a differing entry produces a different head (tamper evidence)", async () => {
    const build = async (target: string): Promise<SealedEffectLedger> => {
      const ledger = createRequestLedger({ ...ledgerOptions, chain: true, clock: () => 5 })
      ledger.append({ capability: "db.write", target })
      return ledger.seal()
    }
    const [a, b] = await Promise.all([build("repo:orders"), build("repo:refunds")])
    expect(a.chain?.head).not.toBe(b.chain?.head as string)
  })

  test("chain disabled by default; empty chain binds route identity and declarations", async () => {
    const plain = await createRequestLedger(ledgerOptions).seal()
    expect(plain.chain).toBeUndefined()
    const [chained, otherRoute, otherDeclaration] = await Promise.all([
      createRequestLedger({ ...ledgerOptions, chain: true }).seal(),
      createRequestLedger({ ...ledgerOptions, path: "/refund", chain: true }).seal(),
      createRequestLedger({ ...ledgerOptions, declared: ["db.write"], chain: true }).seal(),
    ])
    expect(chained.chain?.hashes).toHaveLength(0)
    expect(chained.chain?.head).toMatch(/^[0-9a-f]{64}$/)
    expect(chained.chain?.head).not.toBe(otherRoute.chain?.head)
    expect(chained.chain?.head).not.toBe(otherDeclaration.chain?.head)
  })
})

describe("memory sink + digest", () => {
  test("memory sink retains sealed ledgers and evicts beyond its bound", async () => {
    const memory = createMemoryLedgerSink({ maxLedgers: 2 })
    for (let index = 0; index < 3; index++) {
      const ledger = createRequestLedger({ method: "GET", path: `/route${index}` })
      ledger.append({ capability: "db.read" })
      memory.sink(await ledger.seal())
    }
    expect(memory.ledgers).toHaveLength(2)
    expect(memory.ledgers[0]?.path).toBe("/route1") // oldest evicted
    memory.clear()
    expect(memory.ledgers).toHaveLength(0)
    expect(() => createMemoryLedgerSink({ maxLedgers: 0 })).toThrow(/maxLedgers/)
  })

  test("computeEffectDigest is a keyed HMAC: deterministic per key, differing across keys", async () => {
    const keyA = randomEffectDigestKey()
    const keyB = randomEffectDigestKey()
    const payload = new TextEncoder().encode('{"order":1}')
    const first = await computeEffectDigest(keyA, payload)
    const second = await computeEffectDigest(keyA, payload)
    const other = await computeEffectDigest(keyB, payload)
    expect(first).toBe(second)
    expect(first).not.toBe(other)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(keyA).toHaveLength(32)
  })

  test("rejects a brute-forceable short key; accepts a prepared CryptoKey", async () => {
    await expect(computeEffectDigest(new Uint8Array(8), new Uint8Array(1))).rejects.toThrow(
      /at least 16 bytes/,
    )
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      randomEffectDigestKey() as unknown as ArrayBuffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const digest = await computeEffectDigest(cryptoKey, new TextEncoder().encode("x"))
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, [
      "encrypt",
    ])
    await expect(computeEffectDigest(aesKey, new Uint8Array(1))).rejects.toThrow(/HMAC-SHA-256/)
  })
})

describe("server({ effectLedger }) — request path", () => {
  const post = (path: string): Request => new Request(`http://test${path}`, { method: "POST" })

  test("beacon appends entries; the sink receives the sealed ledger with the route pattern", async () => {
    const memory = createMemoryLedgerSink()
    const app = server({ effectLedger: { sink: memory.sink } }).post(
      "/orders/:id",
      { capabilities: ["db.write", "payments.charge"] },
      (c) => {
        useCapability(c, "db.write", { target: "repo:orders", cost: { ms: 2 } })
        recordCapabilityOutcome(c, "db.write", {
          phase: "committed",
          target: "repo:orders",
        })
        useCapability(c, "payments.charge")
        recordCapabilityOutcome(c, "payments.charge", {
          phase: "committed",
          cost: { calls: 1 },
        })
        return { ok: true }
      },
    )
    const res = await app.fetch(post("/orders/12345"))
    expect(res.status).toBe(200)
    expect(memory.ledgers).toHaveLength(1)
    const sealed = memory.ledgers[0] as SealedEffectLedger
    expect(sealed.method).toBe("POST")
    expect(sealed.path).toBe("/orders/:id") // the pattern — never the concrete URL
    expect(sealed.entries.map((entry) => entry.capability)).toEqual([
      "db.write",
      "db.write",
      "payments.charge",
      "payments.charge",
    ])
    expect(sealed.entries.map((entry) => entry.seq)).toEqual([0, 1, 2, 3])
    expect(sealed.entries[0]?.target).toBe("repo:orders")
    expect(sealed.entries.map((entry) => entry.phase)).toEqual([
      "intent",
      "committed",
      "intent",
      "committed",
    ])
  })

  test("declared-but-unused capabilities produce no sink delivery", async () => {
    const memory = createMemoryLedgerSink()
    const app = server({ effectLedger: { sink: memory.sink } }).post(
      "/noop",
      { capabilities: ["db.write"] },
      () => ({ ok: true }),
    )
    expect((await app.fetch(post("/noop"))).status).toBe(200)
    expect(memory.ledgers).toHaveLength(0)
  })

  test("a failing post-effect sink does not turn success into a duplicate-inducing 500", async () => {
    const logged: Record<string, unknown>[] = []
    const app = server({
      effectLedger: {
        sink: () => {
          throw new Error("sink unavailable: secret-token")
        },
      },
      logger: {
        debug() {},
        info() {},
        warn() {},
        error(_message, fields) {
          logged.push(fields ?? {})
        },
      },
    }).post("/pay", { capabilities: ["payments.charge"] }, (c) => {
      useCapability(c, "payments.charge")
      return { ok: true }
    })
    const res = await app.fetch(post("/pay"))
    expect(res.status).toBe(200)
    expect(JSON.stringify(logged)).not.toContain("secret-token")
  })

  test("awaits thenable sinks without relying on instanceof Promise", async () => {
    let settled = false
    const app = server({
      effectLedger: {
        sink: () =>
          ({
            // biome-ignore lint/suspicious/noThenProperty: this regression deliberately uses a non-Promise thenable
            then(resolve: () => void) {
              settled = true
              resolve()
            },
          }) as unknown as Promise<void>,
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    }).post("/pay", { capabilities: ["payments.charge"] }, (c) => {
      useCapability(c, "payments.charge")
      return { ok: true }
    })
    const res = await app.fetch(post("/pay"))
    expect(res.status).toBe(200)
    expect(settled).toBe(true)
  })

  test("a handler error still delivers the partial intent ledger", async () => {
    const memory = createMemoryLedgerSink()
    const app = server({
      effectLedger: { sink: memory.sink },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    }).post("/boom", { capabilities: ["db.write"] }, (c) => {
      useCapability(c, "db.write", { target: "repo:orders" })
      throw new Error("kaboom after the write")
    })
    const res = await app.fetch(post("/boom"))
    expect(res.status).toBe(500)
    expect(memory.ledgers).toHaveLength(1)
    expect(memory.ledgers[0]?.entries).toHaveLength(1)
    expect(memory.ledgers[0]?.entries[0]?.phase).toBe("intent")
  })

  test("ledger overflow inside the handler fails the request; entries up to the bound are audited", async () => {
    const memory = createMemoryLedgerSink()
    const app = server({
      effectLedger: { sink: memory.sink, maxEntries: 3 },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    }).post("/loop", { capabilities: ["db.write"] }, (c) => {
      for (let index = 0; index < 10; index++) useCapability(c, "db.write")
      return { ok: true }
    })
    const res = await app.fetch(post("/loop"))
    expect(res.status).toBe(500)
    expect(memory.ledgers[0]?.entries).toHaveLength(3)
  })

  test("chain: true produces tamper-evident hashes on the sealed ledger", async () => {
    const memory = createMemoryLedgerSink()
    const app = server({ effectLedger: { sink: memory.sink, chain: true } }).post(
      "/pay",
      { capabilities: ["payments.charge"] },
      (c) => {
        useCapability(c, "payments.charge")
        return { ok: true }
      },
    )
    expect((await app.fetch(post("/pay"))).status).toBe(200)
    expect(memory.ledgers[0]?.chain?.hashes).toHaveLength(1)
    expect(memory.ledgers[0]?.chain?.head).toMatch(/^[0-9a-f]{64}$/)
  })

  test("routes without capabilities are untouched: no ledger, no sink, fast path intact", async () => {
    const memory = createMemoryLedgerSink()
    const app = server({ effectLedger: { sink: memory.sink } })
      .get("/plain", () => ({ ok: true }))
      .post("/ledgered", { capabilities: ["db.write"] }, (c) => {
        expect(effectLedgerOf(c)).toBeDefined()
        return { ok: true }
      })
    const plain = await app.fetch(new Request("http://test/plain"))
    expect(plain.status).toBe(200)
    expect((await app.fetch(post("/ledgered"))).status).toBe(200)
    expect(memory.ledgers).toHaveLength(0) // neither recorded an effect
  })

  test("without effectLedger the beacon keeps its old behavior (guard + observation hook only)", async () => {
    const observed: string[] = []
    const app = server({ onCapabilityUse: (event) => observed.push(event.capability) }).post(
      "/pay",
      { capabilities: ["payments.charge"] },
      (c) => {
        expect(effectLedgerOf(c)).toBeUndefined()
        useCapability(c, "payments.charge", { cost: { calls: 1 } })
        return { ok: true }
      },
    )
    expect((await app.fetch(post("/pay"))).status).toBe(200)
    expect(observed).toEqual(["payments.charge"])
  })

  test("beacon ordering: an undeclared capability throws before anything reaches the ledger", async () => {
    const memory = createMemoryLedgerSink()
    const app = server({
      effectLedger: { sink: memory.sink },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    }).post("/pay", { capabilities: ["db.write"] }, (c) => {
      useCapability(c, "payments.charge") // not declared -> throws
      return { ok: true }
    })
    const res = await app.fetch(post("/pay"))
    expect(res.status).toBe(500)
    expect(memory.ledgers).toHaveLength(0) // nothing sanctioned, nothing recorded
  })

  test("server option validation fails closed at construction", () => {
    expect(() => server({ effectLedger: { sink: 42 as never } })).toThrow(/sink/)
    expect(() => server({ effectLedger: { sink: () => {}, maxEntries: 0 } })).toThrow(/maxEntries/)
  })
})

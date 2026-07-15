import { describe, expect, test } from "bun:test"
import { MemoryCache } from "../../cache/src/memory-cache.ts"
import { MemoryJobStore } from "../../jobs/src/memory-store.ts"
import { MemoryStorage } from "../../storage/src/memory.ts"
import {
  assertAdapterCertification,
  type CertifiableDomainEvent,
  cacheStoreCertificationProfile,
  certifyAdapter,
  eventDeliveryCertificationProfile,
  jobStoreCertificationProfile,
  storageAdapterCertificationProfile,
  verifyAdapterCertification,
} from "../src/certification.ts"

class FullMemoryStorage extends MemoryStorage {
  async listPage(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const keys = await this.list(options.prefix === undefined ? {} : { prefix: options.prefix })
    const offset = Number(options.cursor ?? 0)
    const limit = options.limit ?? keys.length
    const page = keys.slice(offset, offset + limit)
    return {
      keys: page,
      ...(offset + page.length < keys.length ? { cursor: String(offset + page.length) } : {}),
    }
  }

  async presign(key: string) {
    return { url: `https://storage.invalid/${encodeURIComponent(key)}` }
  }

  async copy(source: string, destination: string) {
    const object = await this.get(source)
    if (object === null) throw new Error("missing")
    await this.put(destination, object.body)
  }

  async move(source: string, destination: string) {
    await this.copy(source, destination)
    await this.delete(source)
  }
}

function memoryEvents() {
  type Record = {
    position: string
    event: CertifiableDomainEvent
    claimId: string | null
    delivered: boolean
  }
  const rows: Record[] = []
  return {
    async append(event: CertifiableDomainEvent) {
      if (!rows.some((row) => row.event.id === event.id))
        rows.push({ position: String(rows.length + 1), event, claimId: null, delivered: false })
    },
    async claimPending(limit: number) {
      return rows
        .filter((row) => !row.delivered && row.claimId === null)
        .slice(0, limit)
        .map((row) => {
          row.claimId = `claim-${row.position}`
          return row
        })
    },
    async markDelivered(id: string, claimId: string) {
      const row = rows.find(
        (candidate) => candidate.event.id === id && candidate.claimId === claimId,
      )
      if (row === undefined) return false
      row.delivered = true
      row.claimId = null
      return true
    },
    async readPage(options: { after?: string; limit?: number } = {}) {
      const after = Number(options.after ?? 0)
      const matches = rows.filter((row) => Number(row.position) > after)
      const limit = options.limit ?? 100
      const records = matches.slice(0, limit)
      return {
        records,
        nextPosition: records.at(-1)?.position ?? null,
        hasMore: matches.length > records.length,
      }
    },
  }
}

describe("portable adapter certification", () => {
  test("emits deterministic, hashed capability evidence", async () => {
    const profile = cacheStoreCertificationProfile()
    const first = await certifyAdapter({
      profile,
      adapterId: "memory-cache",
      createAdapter: () => new MemoryCache({ now: () => 100 }),
    })
    const second = await certifyAdapter({
      profile,
      adapterId: "memory-cache",
      createAdapter: () => new MemoryCache({ now: () => 100 }),
    })
    expect(first.ok).toBe(true)
    expect(first.evidenceHash).toBe(second.evidenceHash)
    expect(await verifyAdapterCertification(first)).toBe(true)
    expect(await verifyAdapterCertification({ ...first, adapterId: "tampered-adapter" })).toBe(
      false,
    )
    expect(first.evidenceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(first.capabilities.every((capability) => capability.status === "passed")).toBe(true)
  })

  test("fails closed without serializing adapter error messages", async () => {
    const report = await certifyAdapter({
      profile: cacheStoreCertificationProfile(),
      adapterId: "broken-cache",
      createAdapter: () => ({
        get: () => undefined,
        set: () => {
          throw new Error("redis://user:secret@internal")
        },
        delete() {},
        invalidateTag() {},
        clear() {},
      }),
    })
    expect(report.ok).toBe(false)
    expect(JSON.stringify(report)).not.toContain("secret")
    expect(() => assertAdapterCertification(report)).toThrow("cache-store")
  })

  test("certifies the concrete storage and jobs reference adapters", async () => {
    const storage = await certifyAdapter({
      profile: storageAdapterCertificationProfile(),
      adapterId: "memory-storage",
      createAdapter: () => new MemoryStorage(),
    })
    const jobs = await certifyAdapter({
      profile: jobStoreCertificationProfile(),
      adapterId: "memory-jobs",
      createAdapter: () => new MemoryJobStore(),
    })
    expect(storage.ok).toBe(true)
    expect(jobs.ok).toBe(true)
  })

  test("certifies optional provider mechanics and an independent event-log implementation", async () => {
    const storage = await certifyAdapter({
      profile: storageAdapterCertificationProfile({ paging: true, presign: true, move: true }),
      adapterId: "full-memory-storage",
      createAdapter: () => new FullMemoryStorage(),
    })
    const events = await certifyAdapter({
      profile: eventDeliveryCertificationProfile(),
      adapterId: "reference-event-log",
      createAdapter: memoryEvents,
    })
    expect(storage.ok).toBe(true)
    expect(events.ok).toBe(true)
  })
})

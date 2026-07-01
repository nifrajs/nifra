import { server } from "@nifrajs/core"
import { createCache } from "@nifrajs/cache"
import { createQueue } from "@nifrajs/jobs"
import { decodeCursor, paginate, t } from "@nifrajs/schema"
import { MemoryStorage } from "@nifrajs/storage"

// A full-stack starter: cursor pagination (@nifrajs/schema), background jobs (@nifrajs/jobs), a typed
// cache (@nifrajs/cache), and blob storage (@nifrajs/storage) — over an in-memory "notes" store you'd
// swap for your database. Everything is exported so `app.test.ts` can drive it via `app.fetch`.

export interface Note {
  id: number
  title: string
  body: string
  createdAt: number
}

const notes: Note[] = []
let nextId = 1

// ── Background jobs: index a note off the request path (retries + backoff + dead-lettering built in) ──
export const queue = createQueue()
const indexed = new Set<number>()
const indexNote = queue.define<{ id: number }>("index-note", {
  async handler({ id }) {
    indexed.add(id) // a real app writes to a search index here
  },
})
/** Test/inspection helper: has the background worker indexed this note yet? */
export const wasIndexed = (id: number): boolean => indexed.has(id)

// ── Cache: single-flight `wrap` memoizes a hot read for a TTL (bring CF KV / Redis for a shared cache) ──
const cache = createCache()

// ── Storage: note attachments via the memory adapter (swap for FileStorage / R2Storage in prod) ──
const storage = new MemoryStorage()

const NoteInput = t.object({ title: t.string({ minLength: 1 }), body: t.string() })
const NoteSchema = t.object({
  id: t.integer(),
  title: t.string(),
  body: t.string(),
  createdAt: t.integer(),
})

export const app = server()
  // Create a note, then enqueue the indexing job (returns immediately; the worker runs it later).
  .post("/notes", { body: NoteInput, response: NoteSchema }, async (c) => {
    const note: Note = { id: nextId++, title: c.body.title, body: c.body.body, createdAt: Date.now() }
    notes.push(note)
    await indexNote.enqueue({ id: note.id })
    c.set.status = 201
    return note
  })
  // Cursor-paginated list. `t.pageQuery` validates `{ cursor?, limit? }` (limit capped at 50);
  // `t.paginated` types the `{ items, nextCursor }` envelope. Fetch `limit + 1` rows to detect "more".
  .get("/notes", { query: t.pageQuery({ maxLimit: 50 }), response: t.paginated(NoteSchema) }, (c) => {
    const limit = c.query.limit ?? 20
    const after = decodeCursor<number>(c.query.cursor) ?? 0
    const rows = notes.filter((n) => n.id > after).slice(0, limit + 1)
    return paginate(rows, limit, (n) => n.id)
  })
  // Read one, memoized for 30s. Concurrent misses collapse to a single load (stampede protection).
  .get("/notes/:id", async (c) => {
    const id = Number(c.params.id)
    const note = await cache.wrap(`note:${id}`, () => notes.find((n) => n.id === id), { ttlMs: 30_000 })
    if (note === undefined) return c.json({ error: "not found" }, 404)
    return note
  })
  // Attach raw bytes for a note — stored through the pluggable storage adapter.
  .put("/notes/:id/attachment", async (c) => {
    const bytes = await c.boundedBody()
    const key = `notes/${c.params.id}/attachment`
    await storage.put(key, bytes, { contentType: c.req.headers.get("content-type") ?? "application/octet-stream" })
    c.set.status = 201
    return { key, bytes: bytes.byteLength }
  })

export type App = typeof app

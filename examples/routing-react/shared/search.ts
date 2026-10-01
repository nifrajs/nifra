import type { StandardSchemaV1 } from "@nifrajs/core/server"

// The search route's typed contract, in shared/ because both halves read it. Hand-rolled Standard
// Schema (no schema lib needed for the example):
// `page`/`q` drive the loader; `view` is client-side UI only (see `searchClientKeys`). Hostile input
// falls back, so `ctx.search` / `useSearch` are always well-typed.
export const searchSchema = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate(input: unknown) {
      const raw = (input ?? {}) as { page?: unknown; q?: unknown; view?: unknown }
      const page = typeof raw.page === "number" && Number.isFinite(raw.page) ? raw.page : 1
      const q = typeof raw.q === "string" ? raw.q : ""
      const view = raw.view === "grid" ? "grid" : "list"
      return { value: { page, q, view } }
    },
  },
} satisfies StandardSchemaV1<unknown, { page: number; q: string; view: "list" | "grid" }>

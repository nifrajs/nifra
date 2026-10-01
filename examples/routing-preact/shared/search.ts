import type { StandardSchemaV1 } from "@nifrajs/core/server"

// The search route's typed contract, in shared/ because both halves read it (hand-rolled Standard
// Schema, no schema lib needed for the example).
export const searchSchema = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate(input: unknown) {
      const raw = (input ?? {}) as { page?: unknown; q?: unknown }
      const page = typeof raw.page === "number" && Number.isFinite(raw.page) ? raw.page : 1
      const q = typeof raw.q === "string" ? raw.q : ""
      return { value: { page, q } }
    },
  },
} satisfies StandardSchemaV1<unknown, { page: number; q: string }>

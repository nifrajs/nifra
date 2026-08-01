/** @jsxImportSource preact */
import type { LoaderArgs, LoaderData } from "@nifrajs/client"
import type { StandardSchemaV1 } from "@nifrajs/core/server"
import { useNavigate, useSearch } from "@nifrajs/web-preact/router"
import type { backend } from "../backend"

// A route's typed search contract (hand-rolled Standard Schema, no schema lib needed for the example).
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

export const meta = { title: "nifra + Preact - Typed search" }

export async function loader({ search }: LoaderArgs<typeof backend, unknown, typeof searchSchema>) {
  return { echoed: `${search.page}:${search.q}` }
}

// Preact's useSearch returns the validated search VALUE directly (SSR-correct), so `page`/`q` render
// server-side and hydrate with no mismatch, and a soft-nav re-derives search identically.
export default function Search({ data }: { data: LoaderData<typeof loader> }) {
  const { page, q } = useSearch<typeof searchSchema>() // { page: number; q: string }
  const navigate = useNavigate()
  return (
    <div>
      <h1 id="page">Preact typed search</h1>
      <p id="search">
        page=<span id="page-val">{page}</span> q=<span id="q-val">{q || "(empty)"}</span> loader=
        <span id="loader-val">{data.echoed}</span>
      </p>
      <button
        id="next"
        type="button"
        onClick={() => navigate(`/search?page=${page + 1}${q ? `&q=${q}` : ""}`)}
      >
        next page
      </button>{" "}
      <a id="set-q" href="/search?page=1&q=preact">
        set q=preact
      </a>
    </div>
  )
}

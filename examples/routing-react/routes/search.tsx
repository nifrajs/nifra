import type { LoaderArgs, LoaderData } from "@nifrajs/client"
import type { StandardSchemaV1 } from "@nifrajs/core/server"
import { useNavigate, useSearch } from "@nifrajs/web-react/router"
import type { backend } from "../backend"

// A route's typed search contract. Hand-rolled Standard Schema (no schema lib needed for the example):
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

// `view` is purely presentational, so toggling it re-renders WITHOUT re-running the loader.
export const searchClientKeys = ["view"]

export const meta = { title: "nifra - Typed search params" }

// A loader-run counter, so the page can show whether the loader actually re-ran: a client-only `?view`
// change leaves it unchanged, a `?page` change bumps it.
let loaderRuns = 0

// The loader reads the validated query as `ctx.search` (typed by the third LoaderArgs arg), never by
// parsing the URL itself. `search.page` is a number here.
export async function loader({ search }: LoaderArgs<typeof backend, unknown, typeof searchSchema>) {
  loaderRuns++
  return { echoed: `${search.page}:${search.q}`, run: loaderRuns }
}

// The component reads the SAME value with `useSearch` (SSR-correct), so `page`/`q` render server-side and
// hydrate with no mismatch. The buttons/link change the query; a soft-nav re-derives search identically.
export default function Search({ data }: { data: LoaderData<typeof loader> }) {
  const { page, q, view } = useSearch<typeof searchSchema>() // { page: number; q: string; view }
  const navigate = useNavigate()
  const base = `page=${page}${q ? `&q=${q}` : ""}`
  return (
    <div>
      <h1 id="page">Typed search</h1>
      <p id="search">
        page=<span id="page-val">{page}</span> q=<span id="q-val">{q || "(empty)"}</span> view=
        <span id="view-val">{view}</span> loader=<span id="loader-val">{data.echoed}</span> run=
        <span id="run-val">{data.run}</span>
      </p>
      <button
        id="next"
        type="button"
        onClick={() => navigate(`/search?page=${page + 1}${q ? `&q=${q}` : ""}&view=${view}`)}
      >
        next page
      </button>{" "}
      {/* Client-only: flips ?view without re-running the loader (run stays put). */}
      <button
        id="toggle-view"
        type="button"
        onClick={() => navigate(`/search?${base}&view=${view === "grid" ? "list" : "grid"}`)}
      >
        toggle view
      </button>{" "}
      <a id="set-q" href="/search?page=1&q=react">
        set q=react
      </a>
    </div>
  )
}

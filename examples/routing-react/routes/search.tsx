import { useNavigate, useSearch } from "@nifrajs/web-react/router"
import { searchSchema } from "../shared/search.ts"
import type { Route } from "./+types/search"

export { searchSchema }

// `view` is purely presentational, so toggling it re-renders WITHOUT re-running the loader.
export const searchClientKeys = ["view"]

export const meta = { title: "nifra - Typed search params" }

// The component reads the SAME value with `useSearch` (SSR-correct), so `page`/`q` render server-side and
// hydrate with no mismatch. The buttons/link change the query; a soft-nav re-derives search identically.
export default function Search({ data }: Route.ComponentProps) {
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

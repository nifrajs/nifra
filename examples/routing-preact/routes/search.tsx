/** @jsxImportSource preact */

import { href, useNavigate, useSearch } from "@nifrajs/web-preact/router"
import { searchSchema } from "../shared/search.ts"
import type { Route } from "./+types/search"

export { searchSchema }

export const meta = { title: "nifra + Preact - Typed search" }

// Preact's useSearch returns the validated search VALUE directly (SSR-correct), so `page`/`q` render
// server-side and hydrate with no mismatch, and a soft-nav re-derives search identically.
export default function Search({ data }: Route.ComponentProps) {
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
        onClick={() => navigate(href({ to: "/search", search: { page: page + 1, q } }))}
      >
        next page
      </button>{" "}
      <a id="set-q" href={href({ to: "/search", search: { page: 1, q: "preact" } })}>
        set q=preact
      </a>
    </div>
  )
}

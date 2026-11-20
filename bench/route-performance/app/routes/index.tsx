/** @jsxImportSource preact */
import type { LoaderData } from "@nifrajs/client"
import { useEffect, useState } from "preact/hooks"
import { formatName } from "../shared/format-name.ts"
import type { loader } from "./index.backend.ts"

export default function Catalog({ data }: { data: LoaderData<typeof loader> }) {
  const [ready, setReady] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => setReady(true), [])
  return (
    <main>
      <h1>Catalog</h1>
      <button disabled={!ready} type="button" onClick={() => setOpen(true)}>
        Show filters
      </button>
      {open && <p>Filters open</p>}
      <a href="/products/detail">Product details</a>
      <ul>
        {data.items.map((item) => (
          <li key={item.id}>{formatName(item.name)}</li>
        ))}
      </ul>
    </main>
  )
}

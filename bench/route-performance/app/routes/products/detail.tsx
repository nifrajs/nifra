/** @jsxImportSource preact */
import type { LoaderData } from "@nifrajs/client"
import { useEffect } from "preact/hooks"
import { formatName } from "../../shared/format-name.ts"
import type { loader } from "./detail.backend.ts"

export default function Detail({ data }: { data: LoaderData<typeof loader> }) {
  useEffect(() => {
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => performance.mark("bench-detail-painted"))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [])
  return (
    <main>
      <h1>{formatName(data.name)}</h1>
    </main>
  )
}

import { hydrate } from "solid-js/web"
import { Page } from "./app.tsx"

declare global {
  interface Window {
    __SOLID_BENCH_DATA__?: { items: { id: number; name: string }[] }
  }
}

const data = window.__SOLID_BENCH_DATA__
const root = document.getElementById("root")
if (data !== undefined && root) {
  hydrate(() => <Page items={data.items} />, root)
}

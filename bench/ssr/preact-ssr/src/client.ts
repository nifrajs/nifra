import { h, hydrate } from "preact"
import { App, type PageData } from "./app.tsx"

declare global {
  interface Window {
    __PREACT_BENCH_DATA__?: PageData
  }
}

const data = window.__PREACT_BENCH_DATA__
const root = document.getElementById("root")
if (data !== undefined && root) hydrate(h(App, { data }), root)

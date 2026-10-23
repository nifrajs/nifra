/**
 * Browser entry for `share-browser.test.ts`: hydrates the server-rendered list with `mountRouter`.
 * `?share=0` opts the route out of structural sharing.
 */
import { createClientRouter } from "@nifrajs/web/client"
import { listData } from "../../../web/test/share-browser.ts"
import { mountRouter } from "../../src/client.ts"
import { Layout, Page } from "./share-chain.ts"

const counts = { layout: 0, page: 0, rows: 0 }
Reflect.set(globalThis, "shareCounts", counts)
let labels: Record<number, string> = {}

const router = createClientRouter({
  patterns: [{ routeId: "list", pattern: "/list" }],
  initial: {
    routeId: "list",
    params: {},
    path: "/list",
    data: listData(),
    layoutData: [{ nav: "main" }],
    pending: false,
  },
  routeHooks:
    new URLSearchParams(location.search).get("share") === "0" ? { list: { shareData: false } } : {},
  fetchData: async () => ({ v: 1, data: listData(labels), layoutData: [{ nav: "main" }] }),
})
// Preact subscribes from an effect that runs after paint; a reload before then would go unseen.
let subscribed = false
const watched = {
  ...router,
  subscribe: (listener: () => void) => {
    subscribed = true
    return router.subscribe(listener)
  },
}
mountRouter({
  router: watched,
  routes: { list: [Layout, Page] },
  container: document.getElementById("root"),
})

Reflect.set(globalThis, "fixture", {
  counts,
  invalidate: () => router.invalidate(),
  relabel: (next: Record<number, string>) => {
    labels = next
  },
  ready: () => subscribed,
})

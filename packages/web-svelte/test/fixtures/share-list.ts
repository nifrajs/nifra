/**
 * Browser entry for `share-browser.test.ts`: a list page mounted by `mountRouter`, each row a component
 * with an effect on its `row` prop. `?share=0` opts the route out of structural sharing.
 */
import { createClientRouter } from "@nifrajs/web/client"
import { listData } from "../../../web/test/share-browser.ts"
import { mountRouter } from "../../src/client.ts"
import SharePage from "./SharePage.svelte"

const counts = { rows: 0, effects: 0 }
Reflect.set(globalThis, "shareCounts", counts)
let labels: Record<number, string> = {}

const router = createClientRouter({
  patterns: [{ routeId: "list", pattern: "/list" }],
  initial: { routeId: "list", params: {}, path: "/list", data: listData(), pending: false },
  routeHooks:
    new URLSearchParams(location.search).get("share") === "0" ? { list: { shareData: false } } : {},
  fetchData: async () => listData(labels),
})
// No server render: Svelte's `hydrate` finds no markup and mounts instead.
mountRouter({ router, routes: { list: [SharePage] }, container: document.getElementById("root") })

Reflect.set(globalThis, "fixture", {
  counts,
  invalidate: () => router.invalidate(),
  relabel: (next: Record<number, string>) => {
    labels = next
  },
  ready: true,
})

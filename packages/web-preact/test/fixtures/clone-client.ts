import { createClientRouter } from "@nifrajs/web/client"
import { mountRouter } from "../../src/client.ts"
import { Layout, Nested, Page } from "./clone-chain.ts"

const nested = new URLSearchParams(location.search).has("nested")
const router = createClientRouter({
  patterns: [{ routeId: "page", pattern: "/page" }],
  initial: { routeId: "page", params: {}, path: "/page", data: null, pending: false },
  fetchData: async () => ({ v: 1, data: null }),
})
mountRouter({
  router,
  routes: { page: nested ? [Layout, Nested, Page] : [Layout, Page] },
  container: document.getElementById("root"),
})
Reflect.set(globalThis, "fixture", { invalidate: () => router.invalidate() })

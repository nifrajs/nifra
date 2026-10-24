import { createClientRouter, installHistory } from "@nifrajs/web/client"
import { keepAliveClient } from "@nifrajs/web/keep-alive"
import { mountRouter } from "../../src/keep-alive.ts"
import { Layout, Other, Page } from "./clone-chain.ts"

const chain = (id: string) => ({ ids: ["_layout", id], handles: [undefined, undefined] })
const routeHooks = { page: { keepAlive: true as const }, other: { keepAlive: true as const } }
const table = { routes: ["page", "other"], layouts: [] }
const matchChains = { page: chain("page"), other: chain("other") }
const keep = keepAliveClient({
  table,
  routeHooks,
  matchChains,
  fetchData: async () => ({ v: 1, data: null }),
})
const router = keep.attach(
  createClientRouter({
    patterns: [
      { routeId: "page", pattern: "/page" },
      { routeId: "other", pattern: "/other" },
    ],
    initial: { routeId: "page", params: {}, path: "/page", data: null, pending: false },
    fetchData: keep.fetchData,
    routeHooks,
  }),
)
installHistory(router)
mountRouter({
  router,
  routes: { page: [Layout, Page], other: [Layout, Other] },
  container: document.getElementById("root"),
  keepAlive: table,
  matchChains,
})

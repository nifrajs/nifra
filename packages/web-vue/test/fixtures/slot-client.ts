import { createClientRouter } from "@nifrajs/web/client"
import { mountRouter } from "../../src/client.ts"
import { A, B, KeepAliveLayout, RepeatedLayout, TransitionLayout } from "./slot-chain.ts"

const query = new URLSearchParams(location.search)
const Layout = query.has("transition")
  ? TransitionLayout
  : query.has("repeated")
    ? RepeatedLayout
    : KeepAliveLayout
let data: string | null = null
const router = createClientRouter({
  patterns: [
    { routeId: "a", pattern: "/a" },
    { routeId: "b", pattern: "/b" },
  ],
  initial: { routeId: "a", params: {}, path: "/a", data: null, pending: false },
  fetchData: async () => ({ v: 1, data }),
})
mountRouter({
  router,
  routes: { a: [Layout, A], b: [Layout, B] },
  container: document.getElementById("root"),
})
Reflect.set(globalThis, "fixture", {
  go: (id: string) => router.navigate(`/${id}`),
  invalidate: () => router.invalidate(),
  setData: (next: string | null) => {
    data = next
  },
})

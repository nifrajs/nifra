import { createClientRouter } from "@nifrajs/web/client"
import { mountRouter } from "../../src/client.ts"
import { A, B, BOUNDARIES, INITIAL, Layout } from "./route-props-chain.ts"

let held: Promise<void> | undefined
let release = () => {}
const router = createClientRouter({
  patterns: [
    { routeId: "a", pattern: "/a" },
    { routeId: "b", pattern: "/b" },
  ],
  initial: INITIAL,
  fetchData: async (path) => {
    await held
    return { v: 1, data: { page: path }, layoutData: [{ layout: 2 }], boundaries: BOUNDARIES }
  },
})
mountRouter({
  router,
  routes: { a: [Layout, A], b: [Layout, B] },
  container: document.getElementById("root"),
})
Reflect.set(globalThis, "fixture", {
  go: (id: string) => router.navigate(`/${id}`),
  hold: () => {
    held = new Promise((resolve) => {
      release = () => {
        held = undefined
        resolve()
      }
    })
  },
  release: () => release(),
})

import { expect, test } from "bun:test"
import { createWebApp, type Manifest, type RenderAdapter, type RouteModule } from "../src/index.ts"
import { withRouteSlots } from "../src/route-slots.ts"

test("the server rejects forged slot names and route identities before rendering", async () => {
  let renders = 0
  let routeLoads = 0
  const adapter: RenderAdapter = {
    renderToStream: () => {
      renders++
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<main>dashboard</main>"))
          controller.close()
        },
      })
    },
    hydrationHead: () => "",
  }
  const page: RouteModule = {
    default: "dashboard",
    routeSlots: { inspector: ["/users/:id"] },
  }
  const manifest: Manifest = {
    routes: [
      {
        id: "dashboard",
        pattern: "/dashboard",
        layoutIds: [],
        file: "dashboard.tsx",
        load: async () => {
          routeLoads++
          return page
        },
      },
      {
        id: "user",
        pattern: "/users/:id",
        layoutIds: [],
        file: "users/[id].tsx",
        load: async () => ({ default: "user" }),
      },
      {
        id: "admin",
        pattern: "/admin/:id",
        layoutIds: [],
        file: "admin/[id].tsx",
        load: async () => ({ default: "admin" }),
      },
    ],
    layouts: {},
    notFound: { file: "_404.tsx", load: async () => ({ default: "not-found" }) },
  }
  const app = createWebApp({ adapter, manifest, clientEntry: "/client.js" })
  const request = async (path: string): Promise<Response> =>
    app.fetch(new Request(`https://nifra.test${path}`))

  const allowed = await request(withRouteSlots("/dashboard", { inspector: "/users/7" }))
  expect(allowed.status).toBe(200)
  expect(await allowed.text()).toContain("dashboard")
  expect(renders).toBe(1)

  const wrongRoute = await request(withRouteSlots("/dashboard", { inspector: "/admin/1" }))
  expect(wrongRoute.status).toBe(400)
  const unknownName = await request(withRouteSlots("/dashboard", { other: "/users/7" }))
  expect(unknownName.status).toBe(400)
  const unknownRoute = await request(withRouteSlots("/dashboard", { inspector: "/missing/1" }))
  expect(unknownRoute.status).toBe(400)

  expect(renders).toBe(1)
  expect(routeLoads).toBeGreaterThanOrEqual(4)
})

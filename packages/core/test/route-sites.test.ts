import { afterEach, describe, expect, test } from "bun:test"
import { server } from "../src/index.ts"
import { reflectRouteSites } from "../src/reflection.ts"

const HERE = import.meta.path
const priorNodeEnv = process.env.NODE_ENV

afterEach(() => {
  delete process.env.NIFRA_ROUTE_SITES
  if (priorNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = priorNodeEnv
})

const handler = () => "ok"

describe("reflectRouteSites - where each route was registered", () => {
  test("names this file for a route, a group's route and a merged server's route", () => {
    process.env.NIFRA_ROUTE_SITES = "1"
    const users = server().get("/users", handler)
    const app = server()
      .get("/", handler)
      .group("/api", (api) => api.post("/orders", handler))
      .merge(users)
    const sites = reflectRouteSites(app)
    expect([...sites.keys()]).toEqual(["GET /", "POST /api/orders", "GET /users"])
    for (const site of sites.values()) {
      expect(site.startsWith(`${HERE}:`)).toBe(true)
      expect(site.slice(HERE.length)).toMatch(/^:\d+:\d+$/)
    }
    const line = (key: string) => Number(sites.get(key)?.split(":").at(-2))
    expect(line("GET /")).toBeGreaterThan(line("GET /users"))
  })

  test("records nothing unless the flag is set, and nothing in production", () => {
    expect(reflectRouteSites(server().get("/", handler)).size).toBe(0)
    process.env.NIFRA_ROUTE_SITES = "1"
    process.env.NODE_ENV = "production"
    expect(reflectRouteSites(server().get("/", handler)).size).toBe(0)
    expect(reflectRouteSites({}).size).toBe(0)
  })
})

import { describe, expect, test } from "bun:test"
import { assure, NIFRA_ASSURANCE } from "../src/assurance.ts"
import { type AuthenticationStage, authenticated, server } from "../src/index.ts"
import { reflectMergeAuthGaps } from "../src/reflection.ts"

const session: AuthenticationStage<{ readonly id: string }> = {
  id: "session",
  run: () => authenticated({ id: "u1" }),
}

describe("reflectMergeAuthGaps", () => {
  test("a merge under a parent authenticate() whose routes carry no auth is recorded", () => {
    const users = server()
      .get("/users", () => [])
      .post("/users", () => "ok")
    const app = server()
      .authenticate(session)
      .get("/me", () => "me")
      .merge(users)
    const gaps = reflectMergeAuthGaps(app)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.auth).toEqual(["authenticate(session)"])
    expect(gaps[0]?.routes).toEqual(["GET /users", "POST /users"])
    expect(gaps[0]?.site).toContain("merge-auth-gaps.test.ts:")
  })

  test("a merged server that authenticates any route of its own is not recorded", () => {
    const users = server()
      .get("/login", () => "form")
      .authenticate(session)
      .get("/users", () => [])
    const app = server().authenticate(session).merge(users)
    expect(reflectMergeAuthGaps(app)).toEqual([])
  })

  test("a parent without order-scoped auth records nothing", () => {
    const users = server().get("/users", () => [])
    const app = server()
      .get("/", () => "home")
      .merge(users)
    expect(reflectMergeAuthGaps(app)).toEqual([])
  })

  test("subsequent-scoped authenticated evidence counts, limited to the paths it names", () => {
    const admin = server()
      .get("/admin/users", () => [])
      .get("/status", () => "ok")
    const app = server()
    assure(app, {
      id: NIFRA_ASSURANCE.AUTHENTICATED,
      source: "guard",
      scope: "subsequent",
      paths: ["/admin/**"],
    })
    app.merge(admin)
    const gaps = reflectMergeAuthGaps(app)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.auth).toEqual(["guard"])
    expect(gaps[0]?.routes).toEqual(["GET /admin/users"])
  })

  test("a gap inside a merged server is found from the root", () => {
    const inner = server().get("/inner", () => "x")
    const middle = server()
      .authenticate(session)
      .get("/m", () => "m")
      .merge(inner)
    const app = server().merge(middle)
    expect(reflectMergeAuthGaps(app).map((gap) => gap.routes)).toEqual([["GET /inner"]])
  })

  test("anything that is not a server yields no gaps", () => {
    expect(reflectMergeAuthGaps({})).toEqual([])
    expect(reflectMergeAuthGaps(undefined)).toEqual([])
  })
})

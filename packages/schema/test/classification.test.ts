import { describe, expect, test } from "bun:test"
import { classified, reflectRoutes, server } from "@nifrajs/core"
import { t } from "../src/index.ts"

describe("classified response schemas", () => {
  test("field tags survive nested object/array composition and reflection computes max", () => {
    const response = t.object({
      id: t.string(),
      profile: t.object({
        email: classified(t.string(), "pii"),
        sessions: t.array(
          t.object({
            token: classified(t.string(), "secret"),
          }),
        ),
      }),
    })
    const app = server().get("/me", { response }, () => ({
      id: "u1",
      profile: { email: "a@example.test", sessions: [{ token: "redacted" }] },
    }))

    expect(reflectRoutes(app)[0]?.classification).toEqual({
      fields: {
        "/profile/email": "pii",
        "/profile/sessions/*/token": "secret",
      },
      max: "secret",
    })
  })

  test("route fallback raises max without erasing field-level detail", () => {
    const response = t.object({ email: classified(t.string(), "pii") })
    const app = server().get("/me", { response, classification: "secret" }, () => ({
      email: "a@example.test",
    }))
    expect(reflectRoutes(app)[0]?.classification).toEqual({
      fields: { "/email": "pii" },
      max: "secret",
    })
  })
})

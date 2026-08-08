import { describe, expect, test } from "bun:test"
import { isAuthorized, requireAuthorization } from "../src/index.ts"

describe("authorization seam", () => {
  test("delegates policy evaluation and fails closed", async () => {
    const authorizer = ({ action }: { action: string }) => action === "read"
    expect(await isAuthorized(authorizer, { subject: "u1", action: "read" })).toBe(true)
    expect(await isAuthorized(authorizer, { subject: "u1", action: "write" })).toBe(false)
    await expect(
      requireAuthorization(authorizer, { subject: "u1", action: "write" }),
    ).rejects.toMatchObject({ status: 403 })
  })
})

import { describe, expect, test } from "bun:test"
import { normalizeCssLoading } from "../src/css-contract.ts"
import {
  defineServerComponent,
  inheritOwnerAuthorization,
} from "../src/server-components/definition.ts"
import { componentResponseFailure } from "../src/server-components/response.ts"

describe("server component failure envelope", () => {
  const signal = new AbortController().signal
  const failure = (body: string | null, contentType = "application/json") =>
    componentResponseFailure(
      new Response(body, { status: 502, headers: { "content-type": contentType } }),
      signal,
    )

  test("anything but a bounded JSON object is a plain failure with the response status", async () => {
    for (const response of [
      failure("{}", "text/html"),
      failure(null),
      failure("{not json"),
      failure("[1]"),
      failure('{"v":1,"error":"not_a_code"}'),
    ])
      expect(await response).toMatchObject({ code: "component_failed", status: 502 })
    expect(await failure('{"v":1,"error":"component_busy"}')).toMatchObject({
      code: "component_busy",
      status: 502,
    })
  })
})

describe("server component definition", () => {
  test("a definition without authorize or load is refused", () => {
    expect(() =>
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: deliberately malformed definition, to prove the runtime refuses what the type already would.
      defineServerComponent({ load: () => ({}), view: () => null } as unknown as Parameters<
        typeof defineServerComponent
      >[0]),
    ).toThrow(expect.objectContaining({ code: "component_contract" }))
  })

  test("inheriting the owner's authorization admits without a check of its own", () => {
    expect(inheritOwnerAuthorization()).toBeUndefined()
  })
})

describe("css loading mode", () => {
  test("accepts the two modes and names any other value", () => {
    expect(normalizeCssLoading("deferred")).toBe("deferred")
    expect(() => normalizeCssLoading("eager")).toThrow(
      '[nifra/web] cssLoading must be "blocking" or "deferred", received "eager"',
    )
  })
})

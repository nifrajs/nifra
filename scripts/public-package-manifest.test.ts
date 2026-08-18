import { describe, expect, test } from "bun:test"
import { renderPublicProductReadme } from "./gen-public-product-manifest.ts"

describe("public package manifest", () => {
  test("renders the generated package count and rejects a missing heading", () => {
    expect(
      renderPublicProductReadme("## Batteries (44 packages, all typed, all optional)", 46),
    ).toBe("## Batteries (46 packages, all typed, all optional)")
    expect(() => renderPublicProductReadme("# no generated heading", 46)).toThrow(
      "generated Batteries package-count heading",
    )
  })
})

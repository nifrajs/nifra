/** Static Workbench boundary checks for the review projection. */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

describe("workbench review surface", () => {
  test("uses the SDK projection and exposes only evidence fields", async () => {
    const browser = await readFile(new URL("../src/browser.ts", import.meta.url), "utf8")
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8")

    expect(browser).toContain("toReviewView")
    expect(browser).toContain('client.command<Record<string, unknown>>("review.run")')
    expect(browser).not.toMatch(
      /FileSessionStore|PiBackend|NifraBackend|ReplayBackend|sessionStore/,
    )
    expect(html).toContain("<h3>Review</h3>")
    expect(html).toContain('id="review"')
    expect(html).not.toMatch(/prompt text|tool payload|model output|diagnostic report/i)
  })
})

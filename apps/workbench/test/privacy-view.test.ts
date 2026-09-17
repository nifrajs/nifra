import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("Workbench studio source uses SDK projections and no backend/session imports", async () => {
  const browser = await readFile(new URL("../src/browser.ts", import.meta.url), "utf8")
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8")
  expect(browser).toContain("toRunStudioView")
  expect(browser).toContain("toEvidenceTimelineView")
  expect(browser).toContain('client.supports("run-studio")')
  expect(browser).toContain("Run Studio not offered by this host")
  expect(browser).not.toMatch(/FileSessionStore|PiBackend|NifraBackend|ReplayBackend|sessionStore/)
  expect(html).toContain("Evidence timeline")
  expect(html).toContain("Eval comparison")
  expect(html).not.toMatch(/tool output|response body|model completion|diagnostic report/i)
})

/**
 * Browser end-to-end with @nifrajs/e2e: a locator test, then an agent step whose recording replays
 * with no model call. Needs Playwright and a browser (`bunx playwright install chromium`).
 *
 *   bun run examples/e2e-signin.ts
 *
 * The model below is a scripted stand-in. A real one reads `request.snapshot` and calls your provider.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { server } from "@nifrajs/core/server"
import { type E2EModel, e2e, expect, formatReport } from "@nifrajs/e2e"

const page = (body: string): Response =>
  new Response(body, { headers: { "content-type": "text/html" } })

const app = server()
  .get("/signin", () =>
    page(`<h1>Account</h1><button onclick="location.href='/welcome'">Sign in</button>`),
  )
  .get("/welcome", () => page(`<h1>Welcome</h1><a href="/signin">Back</a>`))

let asked = 0
const model: E2EModel = {
  decide(request) {
    asked += 1
    if (request.kind !== "act") throw new Error(`unexpected ${request.kind} request`)
    if (request.history.some((entry) => entry.ok)) return { kind: "done" }
    return { kind: "tap", target: { role: "button", name: "Sign in" } }
  },
}

const cacheDir = await mkdtemp(join(tmpdir(), "e2e-example-"))
try {
  for (const run of [1, 2]) {
    await using t = await e2e(app, {
      model,
      cache: { dir: cacheDir, testId: "sign in", mode: "read-write" },
    })
    await t.open("/signin")
    await t.agent.act("sign in")
    // The recording is saved only because this check passes after the act.
    await expect(t.screen.getByRole("heading")).toHaveText("Welcome")
    await expect(t).toHaveURL("/welcome")
    console.log(`run ${run}: ${formatReport(t.agent.report())}`)
  }
  console.log(`the model was asked ${asked} times in total`) // 2: both on run 1
} finally {
  await rm(cacheDir, { recursive: true, force: true })
}

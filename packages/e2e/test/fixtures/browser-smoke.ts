/**
 * Real-Chromium smoke for @nifrajs/e2e: run on demand (`bun packages/e2e/test/fixtures/browser-smoke.ts`),
 * not part of `bun test`. It proves what the in-process suite cannot: the Playwright engine against a
 * real page, including that a tap waits for the `data-nifra-hydrated` marker instead of racing it.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { server } from "@nifrajs/core"
import { cookieJar } from "@nifrajs/testing"
import { type E2EModel, e2e, expect, Secret } from "../../src/index.ts"

const html = (body: string): Response =>
  new Response(`<!doctype html><html><body>${body}</body></html>`, {
    headers: { "content-type": "text/html" },
  })

let signInLabel = "Sign in"

const app = server()
  .get("/signin", () =>
    html(`<h1>Account</h1><button onclick="location.href='/welcome'">${signInLabel}</button>`),
  )
  .get("/welcome", () => html(`<h1>Welcome</h1><a href="/signin">Back</a>`))
  .get("/", () =>
    html(
      `<h1>Smoke</h1><button id="b">Count 0</button><script type="module" src="/entry.js"></script>`,
    ),
  )
  .get(
    "/entry.js",
    () =>
      new Response(
        `const b = document.getElementById("b"); let n = 0
       await new Promise((r) => setTimeout(r, 400))
       b.onclick = () => { b.textContent = "Count " + ++n }
       document.documentElement.setAttribute("data-nifra-hydrated", "")`,
        { headers: { "content-type": "text/javascript" } },
      ),
  )
  .get("/users/:id", (c) =>
    html(
      `<h1>User ${c.params.id}</h1><input aria-label="Nick" value="ada"><ul><li>a</li><li>b</li></ul>`,
    ),
  )
  .get("/login", () =>
    html(
      `<h1>Sign in</h1><input aria-label="Email"><input aria-label="Password" type="password"><button id="go">Sign in</button><p id="out"></p><script>document.getElementById("go").onclick = () => { document.getElementById("out").textContent = "Welcome " + document.querySelector("[aria-label=Email]").value + " " + document.querySelector("[aria-label=Password]").value.length }</script>`,
    ),
  )
  .get("/me", (c) => html(`<p>session ${c.cookies.sid ?? "none"}</p>`))

const jar = cookieJar()
jar.set("sid", "abc123")

await using t = await e2e(app, { cookies: jar })

await t.open("/")
const started = Date.now()
await t.screen.getByRole("button", "Count").tap()
await expect(t.screen.getByRole("button")).toHaveText("Count 1")
console.log(`tap waited for hydration (${Date.now() - started} ms after open resolved)`)

await t.open("/users/:id", { params: { id: 42 } })
await expect(t.screen.getByRole("heading")).toHaveText("User 42")
await expect(t.screen.getByLabel("Nick")).toHaveValue("ada")
await t.screen.getByLabel("Nick").fill("grace")
await expect(t.screen.getByLabel("Nick")).toHaveValue("grace")
await expect(t.screen.getByRole("listitem")).toHaveCount(2)
await expect(t.screen.getByText("nothing here")).toBeHidden()
await expect(t).toHaveURL("/users/42")

await t.open("/me")
await expect(t.screen.getByText("session abc123")).toBeVisible()

const failure = await expect(t.screen.getByRole("heading"))
  .toBeVisible({ timeout: 300 })
  .catch((error: unknown) => error)
if (failure instanceof Error) console.log("expected-failure message:", failure.message)
else throw new Error("an assertion on a missing element should have failed")

const seen: string[] = []
const answers: unknown[] = [
  { kind: "fill", target: { label: "Email" }, value: "{email}" },
  { kind: "fill", target: { label: "Password" }, value: "{password}" },
  { kind: "tap", target: { role: "button", name: "Sign in" } },
  { kind: "done", summary: "signed in" },
  { pass: true, reason: "welcome shown" },
  { value: { greeting: "Welcome ada@example.test 7" } },
]
let step = 0
const model: E2EModel = {
  decide(request) {
    seen.push(JSON.stringify(request))
    const answer = answers[step]
    step += 1
    return answer
  },
}
{
  await using a = await e2e(app, { model, cache: false })
  await a.open("/login")
  const result = await a.agent.act("sign in as {email} with {password}", {
    params: { email: "ada@example.test", password: new Secret("password", "hunter2") },
  })
  await expect(a.screen.getByText("Welcome ada@example.test 7")).toBeVisible()
  await a.agent.assert("a welcome message is shown")
  const data = await a.agent.extract("the greeting", {
    schema: {
      "~standard": {
        version: 1,
        vendor: "smoke",
        validate: (value) => ({ value }),
      },
    },
  })
  console.log(
    "agent:",
    result.modelCalls,
    "calls,",
    result.actions.length,
    "actions,",
    JSON.stringify(data),
  )
  const leaked = seen.findIndex((request) => request.includes("hunter2"))
  if (leaked >= 0) throw new Error(`the secret reached the model: ${seen[leaked]}`)
  console.log("secret stayed out of", seen.length, "model requests; snapshot sample:")
  console.log(JSON.parse(seen[0] ?? "{}").snapshot)
}

const cacheDir = await mkdtemp(join(tmpdir(), "e2e-smoke-cache-"))
try {
  let asked = 0
  const tapper: E2EModel = {
    decide(request) {
      asked += 1
      if (request.kind !== "act") throw new Error("unexpected request")
      if (request.history.some((entry) => entry.ok)) return { kind: "done" }
      const named = /button "([^"]+)"/.exec(request.snapshot)
      return { kind: "tap", target: { role: "button", name: named?.[1] ?? "" } }
    },
  }
  const refusing: E2EModel = {
    decide() {
      throw new Error("the model should not have been asked")
    },
  }
  const pass = async (model: E2EModel) => {
    await using t = await e2e(app, { model, cache: { dir: cacheDir, testId: "smoke" } })
    await t.open("/signin")
    const result = await t.agent.act("sign in")
    await expect(t.screen.getByRole("heading")).toHaveText("Welcome")
    return { source: result.source, report: t.agent.report() }
  }
  const outcomes: string[] = []
  const note = (label: string, run: { source: string; report: { modelCalls: number } }) =>
    outcomes.push(`${label}: ${run.source}, ${run.report.modelCalls} model calls`)

  note("run 1", await pass(tapper))
  const written = await readdir(cacheDir)
  if (written.length !== 1) throw new Error(`expected one cache file, found ${written.length}`)
  note("run 2", await pass(refusing))
  signInLabel = "Log in"
  note("run 3 (button renamed)", await pass(tapper))
  note("run 4", await pass(refusing))
  console.log(outcomes.join("\n"))
  const expected = [
    "run 1: model, 2 model calls",
    "run 2: replay, 0 model calls",
    "run 3 (button renamed): handoff, 2 model calls",
    "run 4: replay, 0 model calls",
  ]
  if (outcomes.join("|") !== expected.join("|")) throw new Error("the replay cache did not behave")
  console.log("cache file:", written[0], `(${asked} model calls in total)`)
} finally {
  await rm(cacheDir, { recursive: true, force: true })
}
console.log("ok")

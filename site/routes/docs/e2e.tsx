import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/e2e",
  "Nifra - Browser end-to-end tests",
  "Browser tests for a Nifra app with typed paths, locators, retrying assertions, goal-driven agent steps and a replay cache that makes the second run model-free, with @nifrajs/e2e.",
)

const FIRST = `import { test } from "bun:test"
import { server } from "@nifrajs/core/server"
import { e2e, expect } from "@nifrajs/e2e"

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } })

const app = server().get("/users/:id", (c) =>
  html(\`<h1>User \${c.params.id}<label>Nickname <input value="ada">\`),
)

test("a user page renders", async () => {
  await using t = await e2e(app)
  await t.open("/users/:id", { params: { id: 42 } }) // a path or param the app lacks fails typecheck
  await expect(t.screen.getByRole("heading")).toHaveText("User 42")
  await t.screen.getByLabel("Nickname").fill("grace")
  await expect(t).toHaveURL("/users/42")
})`

const SESSION = `import { server } from "@nifrajs/core/server"
import { testSession } from "@nifrajs/testing"
import { e2e, expect } from "@nifrajs/e2e"

const app = server().get("/me", (c) =>
  new Response(\`<p>session \${c.cookies.sid ?? "none"}\`, { headers: { "content-type": "text/html" } }),
)

// Log in through the API, in process, then hand the cookie jar to the browser.
const { cookies } = testSession<typeof app>(app)
cookies.set("sid", "abc123")

await using t = await e2e(app, { cookies })
await t.open("/me")
await expect(t.screen.getByText("session abc123")).toBeVisible()`

const AGENT = `import { server } from "@nifrajs/core/server"
import { e2e, expect, Secret, type E2EModel } from "@nifrajs/e2e"

const app = server().get("/login", () => new Response("<h1>Sign in", {
  headers: { "content-type": "text/html" },
}))

// The seam to a model. Nothing here names a vendor: you call your provider inside decide().
// doc-check: skip - the provider call is yours; a real adapter would await a model API here.
declare const askMyModel: (request: unknown) => Promise<unknown>
const model: E2EModel = { decide: (request) => askMyModel(request) }

await using t = await e2e(app, { model, agentContext: "Acme calls a plan a seat" })
await t.open("/login")

await t.agent.act("sign in as {email} with {password}", {
  params: { email: "ada@example.test", password: new Secret("password", process.env.PASSWORD ?? "") },
})
await t.agent.assert("the dashboard greets Ada")
await t.agent.waitFor("the export is finished", { timeout: 60_000 })
await expect(t.screen.getByRole("heading")).toBeVisible() // locators and agent steps mix in one test`

const DECISIONS = `// What decide() receives and returns, by request kind.
//
//   act      { goal, snapshot, history, secrets, handoff, ... }
//            -> { kind: "tap" | "fill" | "press", target, value?, key? }
//             | { kind: "goto", path } | { kind: "done", summary? } | { kind: "fail", reason }
//   assert   { statement, snapshot }   -> { pass: true | false | "inconclusive", reason }
//   waitFor  { statement, snapshot }   -> { pass, reason }
//   extract  { prompt, snapshot }      -> { value }   (validated with your Standard Schema)
//
// target is one of { role, name? } | { label } | { text } | { testId }, plus exact? and nth?.
// doc-check: skip - protocol sketch, not code.`

const EXTRACT = `import { server } from "@nifrajs/core/server"
import { t as s } from "@nifrajs/schema"
import { e2e } from "@nifrajs/e2e"

const app = server().get("/plan", () => new Response("<p>Pro, 5 seats", {
  headers: { "content-type": "text/html" },
}))

const model = {
  decide: () => ({ value: { plan: "Pro", seats: 5 } }), // a real model reads the outline in the request
}

await using t = await e2e(app, { model })
await t.open("/plan")
const plan = await t.agent.extract("the current plan and seat count", {
  schema: s.object({ plan: s.string(), seats: s.number() }),
})
plan.seats // number`

const CACHE = `import { server } from "@nifrajs/core/server"
import { e2e, expect, formatReport, unique, type E2EModel } from "@nifrajs/e2e"

const app = server().get("/signup", () => new Response("<h1>Sign up", {
  headers: { "content-type": "text/html" },
}))
const model: E2EModel = { decide: () => ({ kind: "done" }) }

await using t = await e2e(app, {
  model,
  cache: { testId: "a visitor signs up", mode: "read-write" },
})
await t.open("/signup")

// unique() keeps a run-varying value from missing the cache; it is typed again on replay.
await t.agent.act("sign up as {email}", { params: { email: unique(\`ada-\${Date.now()}@example.test\`) } })

// The recording is written only when a LATER check passes.
await expect(t.screen.getByRole("heading")).toBeVisible()
console.log(formatReport(t.agent.report())) // Cache: 1 replayed - 0 handed off - 0 missed (0 model calls)`

const CI = `import { server } from "@nifrajs/core/server"
import { e2e } from "@nifrajs/e2e"

const app = server().get("/", () => new Response("<h1>Home", { headers: { "content-type": "text/html" } }))

// CI replays committed recordings and never writes or deletes them. With no model, a recording that
// no longer matches fails with MODEL_MISSING; add mode: "strict" to fail with REPLAY_STALE instead
// of ever calling a model.
await using t = await e2e(app, { cache: { testId: "home", mode: "strict" } })
await t.open("/")`

const ENGINE = `import { server } from "@nifrajs/core/server"
import { e2e } from "@nifrajs/e2e"
import { fakeEngine } from "@nifrajs/e2e/fake"

const app = server().get("/", () => new Response("ok"))

// An in-memory engine with the same locator rules, for testing code built on this package.
const { factory } = fakeEngine({ pages: { "/": [{ role: "heading", name: "Home", text: "Home" }] } })
await using t = await e2e(app, { engine: factory, cache: false })
await t.open("/")
await t.screen.getByRole("heading").count()`

export default function E2E() {
  return (
    <div className="prose">
      <h1 className="page">Browser end-to-end tests</h1>
      <p className="lead">
        <code>@nifrajs/e2e</code> serves your app on an ephemeral port, drives it through a browser,
        and gives you typed paths, locators and retrying assertions. On top it adds goal-driven agent
        steps and a replay cache, so a test can say what it wants in words and still run model-free
        after the first pass. It is a library: use <code>bun:test</code>, Vitest or anything that
        runs <code>async</code> functions.
      </p>

      <h2>A first test</h2>
      <CodeBlock code={FIRST} lang="ts" />
      <p>
        <code>open()</code> takes only paths the app declares and requires their{" "}
        <code>:params</code>. <code>await using</code> closes the browser and the server at scope exit.
        Names and text match as a case-insensitive substring; pass <code>{"{ exact: true }"}</code> for
        a full match. A locator that matches several elements is an error for <code>tap</code>,{" "}
        <code>fill</code>, <code>press</code> and the one-element assertions, never a guess at the
        first. Assertions retry until <code>assertionTimeout</code> (5000 ms by default).
      </p>
      <p>
        On a page that loads a module script, actions wait for <code>data-nifra-hydrated</code> on{" "}
        <code>&lt;html&gt;</code>, so a tap never lands before its handler exists. Pass{" "}
        <code>hydration: &quot;off&quot;</code> for a page that is not a hydrated Nifra page.
      </p>

      <h2>Signed-in sessions</h2>
      <CodeBlock code={SESSION} lang="ts" />

      <h2>Agent steps</h2>
      <p>
        <code>t.agent.act</code> takes one goal; <code>assert</code> and <code>waitFor</code> take a
        statement; <code>extract</code> returns data your schema accepts. The model is a port you
        supply: <code>{"{ decide(request) }"}</code>. The request carries a pruned outline of the page
        (at most <code>snapshotChars</code>, 12000 by default) and what was already tried; the answer is
        a small JSON decision.
      </p>
      <CodeBlock code={AGENT} lang="ts" />
      <CodeBlock code={DECISIONS} lang="ts" />
      <ul>
        <li>
          <b>Budgets.</b> <code>act</code> stops at <code>maxModelCalls</code> (12),{" "}
          <code>maxActions</code> (25) or <code>timeout</code> (120000 ms), each its own error. A tap
          that finds nothing, or several, goes back to the model, which can retry with{" "}
          <code>nth</code>.
        </li>
        <li>
          <b>Secrets.</b> A <code>Secret</code> is typed into the page by name. The model sees{" "}
          <code>{"{password}"}</code>, never the value, and every outline a session sends has any secret
          it was given replaced by its placeholder.
        </li>
        <li>
          <b>Same origin.</b> <code>goto</code> takes an app path only; anything else is refused and
          reported back to the model.
        </li>
        <li>
          <b>No model.</b> Agent steps reject with <code>MODEL_MISSING</code>; locator tests need
          none.
        </li>
      </ul>
      <CodeBlock code={EXTRACT} lang="ts" />

      <h2>The replay cache</h2>
      <p>
        The first run of an <code>act</code> asks the model. The next runs replay what it did, with no
        model call. A recording is written only after a <b>later</b> locator assertion,{" "}
        <code>agent.assert</code> or <code>agent.waitFor</code> passes, and a failing one deletes it, so
        a test should end with a check.
      </p>
      <CodeBlock code={CACHE} lang="ts" />
      <ul>
        <li>
          <b>Replay</b> needs the same start route, finds each control by the role, name, label, text
          or test id it had and requires the same number of matches, then checks the end route and the
          controls and headings that appeared or went away. It never taps a near miss.
        </li>
        <li>
          <b>Hand-off.</b> When a replay stops (<code>target-not-found</code>, <code>ambiguous</code>,{" "}
          <code>end-mismatch</code>, <code>action-uncertain</code>, <code>route-mismatch</code>) the
          actions already done stay done, and the model finishes the goal from the current page.{" "}
          <code>request.handoff</code> carries the reason. A passing check re-records the repaired steps;
          if the goal then fails, the recording is deleted.
        </li>
        <li>
          <b>The key</b> is <code>cache.testId</code> (set it: two tests that say the same thing
          otherwise share a recording), the goal text, the params, <code>agentContext</code> and{" "}
          <code>cache.appIdentity</code>. A <code>unique()</code> value and a <code>Secret</code> do not
          change it, and a secret is stored by name only.
        </li>
        <li>
          <b>Where.</b> <code>.nifra/e2e-cache/&lt;hash&gt;.json</code> under the working directory,
          small and meant to be committed. <code>cache.store</code> swaps in your own;{" "}
          <code>cache: false</code> turns the cache off.
        </li>
      </ul>

      <h3>Modes</h3>
      <table>
        <thead>
          <tr>
            <th>Mode</th>
            <th>Replays</th>
            <th>Writes and deletes</th>
            <th>Stale or missing recording</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>read-write</code>
            </td>
            <td>yes</td>
            <td>yes</td>
            <td>hand-off to the model</td>
          </tr>
          <tr>
            <td>
              <code>read-only</code> (default when <code>CI</code> is set)
            </td>
            <td>yes</td>
            <td>no</td>
            <td>hand-off to the model</td>
          </tr>
          <tr>
            <td>
              <code>strict</code>
            </td>
            <td>yes</td>
            <td>no</td>
            <td>
              <code>REPLAY_STALE</code> / <code>REPLAY_MISSING</code>, no model call
            </td>
          </tr>
          <tr>
            <td>
              <code>off</code>
            </td>
            <td>no</td>
            <td>no</td>
            <td>the model runs every time</td>
          </tr>
        </tbody>
      </table>
      <CodeBlock code={CI} lang="ts" />
      <p>
        <code>t.agent.report()</code> returns <code>{"{ replayed, handedOff, missed, modelCalls }"}</code>{" "}
        and <code>formatReport</code> prints it. Token counts are not reported: the model port returns
        decisions, not usage. A cache store that refuses a write is counted, never thrown.
      </p>

      <h2>Engines</h2>
      <p>
        <code>e2e()</code> uses Playwright by default. Install it yourself (<code>playwright</code> is
        an optional peer dependency) and a browser with <code>bunx playwright install chromium</code>.
        The engine is a six-method interface, so anything else plugs in with{" "}
        <code>e2e(app, {"{ engine }"})</code>; <code>@nifrajs/e2e/fake</code> is an in-memory engine with
        the same locator rules, for testing code built on this package.
      </p>
      <CodeBlock code={ENGINE} lang="ts" />

      <blockquote>
        <p>
          An agent step is only as safe as the app state behind it. Point it at a test database and an
          isolated fixture, never at production, and keep credentials in <code>Secret</code> params.
        </p>
      </blockquote>
    </div>
  )
}

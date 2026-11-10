# @nifrajs/e2e

Browser end-to-end tests for Nifra apps. It serves your app on an ephemeral port, drives it through
a browser engine, and gives you locators and retrying assertions. The route table types `open()`.

```ts
import { test } from "bun:test"
import { e2e, expect } from "@nifrajs/e2e"
import { app } from "../src/app"

test("a user page renders", async () => {
  await using t = await e2e(app)
  await t.open("/users/:id", { params: { id: 42 } })   // a path or param the app lacks fails typecheck
  await expect(t.screen.getByRole("heading")).toHaveText("User 42")
  await t.screen.getByLabel("Nickname").fill("grace")
  await expect(t).toHaveURL("/users/42")
})
```

`await using` closes the browser and the server at scope exit; `t.close()` does the same by hand.

## Locators and assertions

`getByRole(role, name)`, `getByLabel`, `getByText`, `getByTestId`, `.filter({ hasText })`, and chaining
to scope into a row. Names and text match as a case-insensitive substring; pass `{ exact: true }` for
a full match. Actions: `tap`, `fill`, `press`. Assertions retry until they pass or `assertionTimeout`
(default 5000 ms) runs out: `toBeVisible`, `toBeHidden`, `toHaveText`, `toContainText`, `toHaveCount`,
`toHaveValue`, `toHaveURL`, each with `.not`.

A locator that matches several elements is an error for `tap`, `fill`, `press` and the one-element
assertions (`LOCATOR_AMBIGUOUS`, or a failed assertion naming the count).

## Hydration

On a page that loads a module script, the Playwright engine waits for `data-nifra-hydrated` on `<html>`
after each navigation and before each action, so a tap does not land before its handler exists. Pass
`hydration: "off"` for a page that is not a hydrated Nifra page.

## Signed-in sessions

```ts
const { cookies } = testSession<typeof app>(app)
await api.auth.login.post(credentials)
await using t = await e2e(app, { cookies })
```

## Agent steps

Say what you want in words; a model you supply drives the page. Locators and agent steps mix in one test.

```ts
await using t = await e2e(app, { model, agentContext: "Acme calls a plan a seat" })
await t.open("/login")
await t.agent.act("sign in as {email} with {password}", {
  params: { email: "ada@example.test", password: new Secret("password", process.env.PASSWORD ?? "") },
})
await t.agent.assert("the dashboard greets Ada")
await t.agent.waitFor("the export is finished", { timeout: 60_000 })
const plan = await t.agent.extract("the current plan", { schema: PlanSchema })
```

`model` is `{ decide(request) }`: the request carries the goal, a pruned outline of the page and what was
already tried, and the answer is `{ kind: "tap" | "fill" | "press" | "goto" | "done" | "fail", ... }` for
`act`, `{ pass, reason }` for `assert` and `waitFor`, and `{ value }` for `extract`. Nothing here names a
vendor; you own the credentials, the retries and the cost. Without `model`, agent steps reject with
`MODEL_MISSING` and locator tests are unaffected.

- **Budgets.** `act` stops at `maxModelCalls` (12), `maxActions` (25) or `timeout` (120000 ms), each a
  distinct error. A tap that finds no element or several goes back to the model, which can retry with `nth`.
- **Secrets.** A `Secret` is typed into the page by name. The model sees `{password}`, never the value,
  and every snapshot a session sends has any secret it was given replaced by its placeholder.
- **Same origin.** `goto` takes an app path only; anything else is refused and reported to the model.
- **`extract`** validates the answer with your Standard Schema (`EXTRACT_INVALID` on a mismatch).
- **`waitFor`** asks the model again only when the page outline changed.

## Replay cache

The first run of an `act` asks the model; the next runs replay what it did, with no model call.

```ts
await using t = await e2e(app, { model, cache: { testId: "member upgrades to Pro" } })
await t.open("/settings/billing")
await t.agent.act("upgrade the workspace to the {plan} plan", { params: { plan: "Pro" } })
await expect(t.screen.getByRole("status")).toHaveText("Pro")   // a later check that passes saves the recording
console.log(formatReport(t.agent.report()))                    // Cache: 1 replayed - 0 handed off - 0 missed (0 model calls)
```

- **Written only after a later check passes.** A locator `expect` or `agent.assert`/`waitFor` that passes
  saves what the `act`s before it recorded. One that fails deletes them. A test that ends with no check
  records nothing.
- **Replay** needs the same start route, finds each control by the role, name, label, text or test id
  it had, and requires it to match exactly as often as it did. It never taps a near miss. It then checks
  the end route and the controls and headings that appeared or went away.
- **Hand-off.** When a replay stops (`target-not-found`, `ambiguous`, `end-mismatch`, `action-uncertain`,
  `route-mismatch`) the actions it already did stay done, and the model finishes the goal from the current
  page. `ActRequest.handoff` carries the reason and how many actions to leave alone. A passing check
  re-records the repaired steps. If the goal then fails, the recording is deleted.
- **Modes** (`cache.mode`): `read-write` (default; `read-only` when `CI` is set), `read-only` (replays and
  hands off, never writes or deletes), `strict` (replay only: a stale recording is `REPLAY_STALE`, a
  missing one `REPLAY_MISSING`), `off`.
- **The key** is the test (`cache.testId`: pass it), the goal text, the params, `agentContext`, and
  `cache.appIdentity`. Wrap run-varying data in `unique(value)` so a new value does not miss; it is
  typed again on replay. A `Secret` is stored by name only, never by value.
- **Where.** `.nifra/e2e-cache/<hash>.json` under the working directory (`cache.dir`), small and meant to
  be committed. `cache.store` swaps in your own store; `memoryCacheStore()` is one for tests. A store
  that refuses a write is counted in the cache, not thrown. `cache: false` turns the whole thing off.
- Replay needs no model: in CI `model` can be left out and a stale recording then fails with
  `MODEL_MISSING`. `assert`, `waitFor` and `extract` always ask the model.

## Engines

`e2e()` uses the Playwright engine by default; install `playwright` yourself (optional peer). The engine
is a six-method interface (`goto`, `url`, `resolve`, `act`, `snapshot`, `close`), so anything else can plug in with
`e2e(app, { engine })`. `@nifrajs/e2e/fake` is an in-memory engine with the same locator semantics, for
testing code built on this package without a browser.

## Not included yet

Token counts (the model port returns decisions, not usage) and a test runner. Use `bun:test` or Vitest.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.

import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import type { StandardSchemaV1 } from "@nifrajs/core/schema"
import { type AgentDeps, createAgent } from "../src/agent.ts"
import { type FakeNode, fakeEngine } from "../src/fake.ts"
import {
  type ActRequest,
  E2EError,
  type E2EModel,
  e2e,
  type ModelRequest,
  Secret,
} from "../src/index.ts"
import { isRecord } from "../src/internal/record.ts"
import { virtualClock } from "./helpers.ts"

const loginPage: FakeNode[] = [
  { role: "heading", name: "Sign in", text: "Sign in" },
  { role: "textbox", name: "Email", label: "Email" },
  { role: "textbox", name: "Password", label: "Password" },
  { role: "button", name: "Sign in", text: "Sign in" },
  { role: "button", name: "Sign in with SSO", text: "Sign in with SSO" },
]

function actAt(requests: readonly ModelRequest[], index: number): ActRequest {
  const request = requests[index]
  if (request?.kind !== "act") throw new Error(`request ${index} is not an act request`)
  return request
}

function scripted(answers: readonly unknown[]): { model: E2EModel; requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  let next = 0
  return {
    requests,
    model: {
      decide(request) {
        requests.push(request)
        const answer = answers[Math.min(next, answers.length - 1)]
        next += 1
        return answer
      },
    },
  }
}

async function agentOver(
  pages: Record<string, FakeNode[]>,
  model: E2EModel | undefined,
  overrides: Partial<AgentDeps> = {},
  onAct?: Parameters<typeof fakeEngine>[0]["onAct"],
) {
  const { factory, log } = fakeEngine(onAct === undefined ? { pages } : { pages, onAct })
  const engine = await factory({ baseUrl: "http://x", cookies: [], hydration: "off" })
  await engine.goto("http://x/")
  const clock = virtualClock()
  const navigated: string[] = []
  const deps: AgentDeps = {
    engine,
    clock,
    pollInterval: 100,
    actionTimeout: 1000,
    model,
    context: undefined,
    snapshotChars: 12_000,
    origin: "http://x",
    cache: undefined,
    navigate: async (path: string) => {
      navigated.push(path)
      await engine.goto(`http://x${path}`)
    },
    ...overrides,
  }
  return { agent: createAgent(deps), engine, clock, log, navigated }
}

const tap = (name: string, extra: object = {}) => ({
  kind: "tap",
  target: { role: "button", name, ...extra },
})
const done = { kind: "done" }

describe("agent.act", () => {
  test("drives the page until the model says done and reports what the page took", async () => {
    const { model, requests } = scripted([
      { kind: "fill", target: { label: "Email" }, value: "{email}" },
      tap("Sign in", { exact: true }),
      { kind: "done", summary: "signed in" },
    ])
    const { agent, engine, log } = await agentOver(
      { "/": loginPage, "/home": [{ role: "heading", name: "Home" }] },
      model,
      {},
      (node) => (node.name === "Sign in" ? "/home" : undefined),
    )
    const result = await agent.act("sign in as {email}", { params: { email: "ada@example.test" } })
    expect(result.modelCalls).toBe(3)
    expect(result.summary).toBe("signed in")
    expect(result.actions.map((action) => action.kind)).toEqual(["fill", "tap"])
    expect(log.map((entry) => `${entry.kind}:${entry.detail}`)).toEqual([
      "goto:/",
      "fill:ada@example.test",
      "tap:",
      "goto:/home",
    ])
    expect(requests[0]).toMatchObject({
      kind: "act",
      goal: "sign in as ada@example.test",
      secrets: [],
    })
    expect(actAt(requests, 2).history.map((entry) => entry.ok)).toEqual([true, true])
    expect(await engine.url()).toBe("http://x/home")
  })

  test("a secret is typed into the page but never reaches the model", async () => {
    const { model, requests } = scripted([
      { kind: "fill", target: { label: "Password" }, value: "{password}" },
      done,
    ])
    const { agent, engine } = await agentOver(
      { "/": [...loginPage, { text: "debug: hunter2 was typed" }] },
      model,
    )
    await agent.act("enter the {password}", {
      params: { password: new Secret("password", "hunter2") },
    })
    expect(await engine.resolve([{ kind: "label", text: "Password" }])).toEqual([
      { visible: true, text: "", value: "hunter2" },
    ])
    expect(JSON.stringify(requests)).not.toContain("hunter2")
    expect(requests[0]).toMatchObject({ goal: "enter the {password}", secrets: ["password"] })
    expect(actAt(requests, 0).snapshot).toContain("debug: {password} was typed")
  })

  test("a secret typed in one step stays out of the snapshots of later steps", async () => {
    const { model, requests } = scripted([
      { kind: "fill", target: { label: "Password" }, value: "{password}" },
      done,
      { pass: true },
    ])
    const { agent } = await agentOver({ "/": loginPage }, model)
    await agent.act("enter it", { params: { password: new Secret("password", "hunter2") } })
    await agent.assert("a password is entered")
    expect(JSON.stringify(requests)).not.toContain("hunter2")
  })

  test("a failed action goes back to the model, which can narrow with nth", async () => {
    const { model, requests } = scripted([
      tap("Sign in"),
      tap("Sign in", { nth: 0 }),
      tap("Nope"),
      done,
    ])
    const { agent, log } = await agentOver({ "/": loginPage }, model)
    const result = await agent.act("sign in")
    expect(result.actions).toHaveLength(1)
    expect(log.filter((entry) => entry.kind === "tap")).toHaveLength(1)
    const history = actAt(requests, 3).history
    expect(history.map((entry) => entry.ok)).toEqual([false, true, false])
    expect(history[0]?.error).toContain("2 elements")
    expect(history[2]?.error).toContain("no visible element")
  })

  test("press and goto are performed; a goto the session refuses is reported, not thrown", async () => {
    const { model, requests } = scripted([
      { kind: "press", target: { label: "Email" }, key: "Enter" },
      { kind: "goto", path: "/other" },
      { kind: "goto", path: "/blocked" },
      done,
    ])
    const { agent, navigated } = await agentOver({ "/": loginPage, "/other": [] }, model, {
      navigate: async (path: string) => {
        navigated.push(path)
        if (path === "/blocked") throw new TypeError("path must be a same-origin absolute path")
      },
    })
    const result = await agent.act("wander")
    expect(result.actions.map((action) => action.kind)).toEqual(["press", "goto"])
    const history = actAt(requests, 3).history
    expect(history.map((entry) => entry.ok)).toEqual([true, true, false])
    expect(history[2]?.error).toBe("path must be a same-origin absolute path")
    expect(navigated).toEqual(["/other", "/blocked"])
  })

  test("the agent context rides every request", async () => {
    const { model, requests } = scripted([done])
    const { agent } = await agentOver({ "/": loginPage }, model, {
      context: "Acme calls a plan a seat",
    })
    await agent.act("x")
    expect(requests[0]).toMatchObject({ context: "Acme calls a plan a seat" })
  })

  test("fail ends the goal with the model's reason", async () => {
    const { model } = scripted([{ kind: "fail", reason: "no sign-in form" }])
    const { agent } = await agentOver({ "/": [] }, model)
    await expect(agent.act("sign in")).rejects.toMatchObject({
      code: "STEP_FAILED",
      message: 'goal "sign in" failed: no sign-in form',
    })
  })

  test("model-call, action and time budgets stop a goal that does not finish", async () => {
    const taps = scripted([tap("Sign in", { nth: 0 })])
    const a = await agentOver({ "/": loginPage }, taps.model)
    await expect(a.agent.act("loop", { maxModelCalls: 2 })).rejects.toMatchObject({
      code: "STEP_BUDGET_EXCEEDED",
      message: 'goal "loop" used its 2 model calls',
    })
    expect(taps.requests).toHaveLength(2)

    const b = await agentOver({ "/": loginPage }, scripted([tap("Sign in", { nth: 0 })]).model)
    await expect(b.agent.act("loop", { maxActions: 1 })).rejects.toMatchObject({
      code: "STEP_BUDGET_EXCEEDED",
      message: 'goal "loop" used its 1 actions',
    })

    const slowClock = virtualClock()
    const slow: E2EModel = {
      decide() {
        slowClock.advance(60_000)
        return tap("Sign in", { nth: 0 })
      },
    }
    const c = await agentOver({ "/": loginPage }, slow, { clock: slowClock })
    await expect(c.agent.act("loop", { timeout: 100_000 })).rejects.toMatchObject({
      code: "STEP_TIMEOUT",
    })
  })

  test("an answer that is not a decision is MODEL_INVALID", async () => {
    const { agent } = await agentOver({ "/": loginPage }, scripted([{ kind: "dance" }]).model)
    await expect(agent.act("x")).rejects.toMatchObject({ code: "MODEL_INVALID" })
  })

  test("an engine failure that is not about the locator is not swallowed", async () => {
    const { model } = scripted([tap("Go")])
    const { engine } = await agentOver({ "/": [] }, model)
    const broken = {
      ...engine,
      act: async () => {
        throw new Error("browser crashed")
      },
    }
    const { agent } = await agentOver({ "/": [] }, model, { engine: broken })
    await expect(agent.act("x")).rejects.toThrow("browser crashed")
  })

  test("a snapshot over the limit is pruned before the model sees it", async () => {
    const many: FakeNode[] = Array.from({ length: 60 }, (_, i) => ({
      text: `filler line number ${i}`,
    }))
    const { model, requests } = scripted([done])
    const { agent } = await agentOver({ "/": [...many, { role: "button", name: "Go" }] }, model, {
      snapshotChars: 400,
    })
    await agent.act("x")
    const seen = actAt(requests, 0).snapshot
    expect(seen.length).toBeLessThanOrEqual(480)
    expect(seen).toContain('- button "Go"')
    expect(seen).toContain("lines omitted")
  })
})

describe("agent.assert", () => {
  test("passes, fails and is inconclusive on the model's verdict", async () => {
    const { agent } = await agentOver(
      { "/": loginPage },
      scripted([
        { pass: true, reason: "heading present" },
        { pass: false, reason: "no banner" },
        { pass: "inconclusive", reason: "page is blank" },
        { pass: false },
      ]).model,
    )
    await agent.assert("there is a sign in heading")
    await expect(agent.assert("a banner shows")).rejects.toMatchObject({
      code: "ASSERTION_FAILED",
      message: '"a banner shows" does not hold: no banner',
    })
    await expect(agent.assert("a chart shows")).rejects.toMatchObject({
      code: "ASSERTION_INCONCLUSIVE",
      message: 'could not tell whether "a chart shows": page is blank',
    })
    await expect(agent.assert("x")).rejects.toMatchObject({ message: '"x" does not hold' })
  })

  test("a verdict that is not one is MODEL_INVALID, and params fill the statement", async () => {
    const { model, requests } = scripted([{ pass: "maybe" }, { pass: true }])
    const { agent } = await agentOver({ "/": loginPage }, model)
    await expect(agent.assert("x")).rejects.toMatchObject({ code: "MODEL_INVALID" })
    await agent.assert("the plan is {plan}", { params: { plan: "Pro" } })
    expect(requests[1]).toMatchObject({ kind: "assert", statement: "the plan is Pro" })
  })
})

describe("agent.waitFor", () => {
  function changing() {
    let ready = false
    const clock = virtualClock((elapsed) => {
      ready = elapsed >= 300
    })
    const engine = {
      goto: async () => {},
      url: async () => "http://x/",
      resolve: async () => [],
      act: async () => {},
      close: async () => {},
      snapshot: async () => (ready ? '- status: "Done"' : '- status: "Loading"'),
    }
    return { clock, engine }
  }

  test("asks the model only when the screen changed", async () => {
    const { clock, engine } = changing()
    const { model, requests } = scripted([{ pass: false, reason: "still loading" }, { pass: true }])
    const { agent } = await agentOver({ "/": [] }, model, { engine, clock })
    await agent.waitFor("the export is done")
    expect(requests).toHaveLength(2)
    expect(clock.elapsed()).toBe(300)
  })

  test("times out with the last reason", async () => {
    const { clock, engine } = changing()
    const { model, requests } = scripted([{ pass: false, reason: "still loading" }])
    const { agent } = await agentOver({ "/": [] }, model, { engine, clock })
    await expect(agent.waitFor("done", { timeout: 250 })).rejects.toMatchObject({
      code: "WAIT_TIMEOUT",
      message: '"done" did not hold within 250 ms: still loading',
    })
    expect(requests).toHaveLength(1)
    const quiet = await agentOver({ "/": [] }, scripted([{ pass: false }]).model, { engine, clock })
    await expect(quiet.agent.waitFor("done", { timeout: 10 })).rejects.toMatchObject({
      message: '"done" did not hold within 10 ms',
    })
  })

  test("a verdict that is not one is MODEL_INVALID", async () => {
    const { clock, engine } = changing()
    const { agent } = await agentOver({ "/": [] }, scripted([42]).model, { engine, clock })
    await expect(agent.waitFor("x")).rejects.toMatchObject({ code: "MODEL_INVALID" })
  })
})

describe("agent.extract", () => {
  const schema: StandardSchemaV1<unknown, { n: number }> = {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate: (value: unknown) =>
        isRecord(value) && typeof value.n === "number"
          ? { value: { n: value.n } }
          : { issues: [{ message: "n must be a number" }] },
    },
  }

  test("returns data the schema accepts and carries the JSON Schema hint", async () => {
    const { model, requests } = scripted([{ value: { n: 3 } }])
    const { agent } = await agentOver({ "/": loginPage }, model)
    const data = await agent.extract("how many seats", { schema, jsonSchema: { type: "object" } })
    expect(data.n).toBe(3)
    expect(requests[0]).toMatchObject({
      kind: "extract",
      prompt: "how many seats",
      jsonSchema: { type: "object" },
    })
  })

  test("data the schema refuses is EXTRACT_INVALID; a missing value is MODEL_INVALID", async () => {
    const { model } = scripted([{ value: { n: "three" } }, { nothing: 1 }])
    const { agent } = await agentOver({ "/": loginPage }, model)
    await expect(agent.extract("x", { schema })).rejects.toMatchObject({
      code: "EXTRACT_INVALID",
      message: "the extracted data does not match the schema: n must be a number",
    })
    await expect(agent.extract("x", { schema })).rejects.toMatchObject({ code: "MODEL_INVALID" })
  })
})

describe("without a model", () => {
  test("every agent step is MODEL_MISSING and locators still work", async () => {
    const { agent } = await agentOver({ "/": loginPage }, undefined)
    for (const step of [
      () => agent.act("x"),
      () => agent.assert("x"),
      () => agent.waitFor("x"),
      () =>
        agent.extract("x", {
          schema: { "~standard": { version: 1, vendor: "t", validate: () => ({ value: 1 }) } },
        }),
    ]) {
      await expect(step()).rejects.toBeInstanceOf(E2EError)
      await expect(step()).rejects.toMatchObject({ code: "MODEL_MISSING" })
    }
  })
})

describe("t.agent on a session", () => {
  const app = server()
    .get("/", () => "home")
    .get("/next", () => "next")

  test("act reaches the page through the session and goto stays on the app's origin", async () => {
    const { model, requests } = scripted([
      { kind: "goto", path: "/next" },
      { kind: "goto", path: "//evil.example/x" },
      done,
    ])
    const { factory } = fakeEngine({
      pages: {
        "/": [{ role: "heading", name: "Home" }],
        "/next": [{ role: "heading", name: "Next" }],
      },
    })
    await using t = await e2e(app, { engine: factory, model, cache: false })
    await t.open("/")
    const result = await t.agent.act("go next")
    expect(result.actions.map((action) => action.kind)).toEqual(["goto"])
    expect(await t.path()).toBe("/next")
    expect(actAt(requests, 2).history[1]?.ok).toBe(false)
    expect(actAt(requests, 2).snapshot).toBe('- heading "Next"')
  })

  test("a session without a model still runs locator tests", async () => {
    const { factory } = fakeEngine({ pages: { "/": [{ role: "heading", name: "Home" }] } })
    await using t = await e2e(app, { engine: factory, cache: false })
    await t.open("/")
    await expect(t.agent.act("x")).rejects.toMatchObject({ code: "MODEL_MISSING" })
    expect(await t.screen.getByRole("heading").count()).toBe(1)
  })
})

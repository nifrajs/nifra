import { expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { server, silentLogger, status } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import { LAST_BEFORE_HANDLE } from "../src/server/before-handler.ts"
import type { NodeServeOutcome } from "../src/server/node-outcome.ts"

/**
 * Every derive/before/after mix the fused hook lanes accept must answer exactly as the generic
 * program does. The generic program is the reference: the same hooks plus an error hook that never
 * changes an answer, which keeps the route off the fused lanes. The shapes, the way each hook
 * behaves and the way the handler ends are all generated, so no combination is picked by hand.
 */

type Rec = Record<string, unknown>
const JSON_TYPE = "application/json;charset=utf-8"
/** A thrown answer whose body cannot render: the request must still end in a 500, never a rejection. */
const UNRENDERABLE = {
  toJSON(): never {
    throw new Error("unrenderable")
  },
}
type HookMode =
  | "pass"
  | "async"
  | "early"
  | "early-async"
  | "response"
  | "undefined"
  | "null"
  | "null-async"
  | "empty"
  | "throw"
  | "reject"
  | "throw-unrenderable"
  | "reject-unrenderable"
  | "assign-throw"
  | "assign-throw-async"
type HandlerMode =
  | "sync"
  | "async"
  | "throw"
  | "reject"
  | "response"
  | "status"
  | "redirect"
  | "throw-unrenderable"
  | "reject-unrenderable"
type SchemaKind = "none" | "query" | "body"
/** A hook registered after the route, which must not reach it: hooks are order-scoped. */
type Trailing = "none" | "before" | "derive" | "after"

interface Shape {
  readonly derives: number
  readonly befores: number
  readonly afters: number
  readonly schema: SchemaKind
}
interface Plan {
  readonly derive: readonly HookMode[]
  readonly before: readonly HookMode[]
  readonly after: readonly HookMode[]
  readonly handler: HandlerMode
  readonly trailing: Trailing
  /** The last before hook is registered with `beforeHandler()`, which a later hook is inserted ahead of. */
  readonly guarded: boolean
}

const FAULTS: Record<"derive" | "before" | "after", readonly HookMode[]> = {
  derive: [
    "early",
    "early-async",
    "response",
    "undefined",
    "null",
    "throw",
    "reject",
    "throw-unrenderable",
    "reject-unrenderable",
    "assign-throw",
    "assign-throw-async",
  ],
  before: [
    "early",
    "early-async",
    "response",
    "null",
    "null-async",
    "empty",
    "throw",
    "reject",
    "throw-unrenderable",
    "reject-unrenderable",
  ],
  after: ["undefined", "throw", "reject", "throw-unrenderable", "reject-unrenderable"],
}
const HANDLERS: readonly HandlerMode[] = [
  "async",
  "throw",
  "reject",
  "response",
  "status",
  "redirect",
  "throw-unrenderable",
  "reject-unrenderable",
]
const TRAILING: readonly Trailing[] = ["none", "before", "derive", "after"]
const SCHEMAS: readonly SchemaKind[] = ["none", "query", "body"]

function shapes(): Shape[] {
  const out: Shape[] = []
  for (const schema of SCHEMAS)
    for (let derives = 0; derives <= 2; derives++)
      for (let befores = 0; befores <= 2; befores++)
        for (let afters = 0; afters <= 2; afters++)
          if (derives + befores + afters > 0) out.push({ derives, befores, afters, schema })
  return out
}

function plans(shape: Shape): Plan[] {
  const fill = (n: number, mode: HookMode): HookMode[] => Array.from({ length: n }, () => mode)
  const baseline = (mode: HookMode, handler: HandlerMode): Plan => ({
    derive: fill(shape.derives, mode),
    before: fill(shape.befores, mode),
    after: fill(shape.afters, mode),
    handler,
    trailing: "none",
    guarded: false,
  })
  const out: Plan[] = [baseline("pass", "sync"), baseline("async", "async")]
  // Hooks alternate between sync and async, so a continuation resumes in the middle of a chain.
  const alternate = baseline("pass", "sync")
  let turn = 0
  const swap = (modes: readonly HookMode[]): HookMode[] =>
    modes.map(() => (turn++ % 2 === 0 ? "pass" : "async"))
  out.push({
    derive: swap(alternate.derive),
    before: swap(alternate.before),
    after: swap(alternate.after),
    handler: "sync",
    trailing: "none",
    guarded: false,
  })
  for (const around of [baseline("pass", "sync"), baseline("async", "async")]) {
    for (const kind of ["derive", "before", "after"] as const) {
      for (let i = 0; i < around[kind].length; i++) {
        for (const fault of FAULTS[kind]) {
          const modes = [...around[kind]]
          modes[i] = fault
          out.push({ ...around, [kind]: modes })
        }
      }
    }
  }
  for (const handler of HANDLERS) out.push({ ...baseline("pass", "sync"), handler })
  // A handler fault behind async hooks resumes in a continuation, and one async hook beside
  // synchronous ones resumes the chain from that hook alone.
  for (const handler of HANDLERS) out.push({ ...baseline("async", "async"), handler })
  const quiet = baseline("pass", "sync")
  for (const kind of ["derive", "before", "after"] as const) {
    for (let i = 0; i < quiet[kind].length; i++) {
      const modes = [...quiet[kind]]
      modes[i] = "async"
      out.push({ ...quiet, [kind]: modes })
    }
  }
  // Every plan again with a hook registered after the route and with its last before hook marked a
  // guard: a later `beforeHandle()` is inserted ahead of a guard, shifting the route's hook array.
  return out.flatMap((plan) =>
    TRAILING.flatMap((trailing) =>
      (shape.befores > 0 ? [false, true] : [false]).map((guarded) => ({
        ...plan,
        trailing,
        guarded,
      })),
    ),
  )
}

/** What a hook or handler reads off its context. */
type Ctx = Rec & { set: { headers: Record<string, string> }; params: { id: string } }

/** The methods this test drives, viewed structurally so the fluent chain stays one type. */
interface AppLike {
  derive(hook: (c: Ctx) => unknown): AppLike
  beforeHandle(hook: (c: Ctx) => unknown): AppLike
  afterHandle(hook: (result: unknown, c: Ctx) => unknown): AppLike
  onError(hook: () => unknown): AppLike
  get(path: string, ...rest: unknown[]): AppLike
  post(path: string, ...rest: unknown[]): AppLike
  fetch(request: Request): Promise<Response>
  resolveNode(request: Request): Promise<NodeServeOutcome>
  catalog: { entries(): { entry: { execution: { fusedLane: string | undefined } } }[] }
}

function build(shape: Shape, plan: Plan, reference: boolean): { app: AppLike; calls: string[] } {
  const calls: string[] = []
  // biome-ignore lint/plugin/noChainedTypeAssertions: the real builder's types are per-route, and this test only needs the methods listed on AppLike
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: every method AppLike names exists on the builder with these argument shapes
  let app = server({ logger: silentLogger }).use(nodeDirect()) as unknown as AppLike

  plan.derive.forEach((mode, k) => {
    app = app.derive((c) => {
      calls.push(`d${k}`)
      const value = { [`d${k}`]: (k === 0 ? 0 : Number(c[`d${k - 1}`] ?? 0)) + 1 }
      switch (mode) {
        case "async":
          return Promise.resolve(value)
        case "early":
          return status(401, { from: `d${k}` })
        case "early-async":
          return Promise.resolve(status(401, { from: `d${k}` }))
        case "response":
          return new Response(`derive ${k}`, { status: 202 })
        case "undefined":
          return undefined
        case "null":
          return null
        case "throw":
          throw new Error(`d${k}`)
        case "reject":
          return Promise.reject(new Error(`d${k}`))
        case "throw-unrenderable":
          throw status(401, UNRENDERABLE)
        case "reject-unrenderable":
          return Promise.reject(status(401, UNRENDERABLE))
        // `set` is read-only on the context, so merging this result throws.
        case "assign-throw":
          return { set: 1 }
        case "assign-throw-async":
          return Promise.resolve({ set: 1 })
        default:
          return value
      }
    })
  })
  plan.before.forEach((mode, k) => {
    const hook = (c: Ctx): unknown => {
      calls.push(`b${k}`)
      c.set.headers[`x-b${k}`] = "1"
      switch (mode) {
        case "async":
          return Promise.resolve(undefined)
        case "early":
          return { early: `b${k}` }
        case "early-async":
          return Promise.resolve({ early: `b${k}` })
        case "null":
          return null
        case "null-async":
          return Promise.resolve(null)
        case "empty":
          return ""
        case "response":
          return new Response(`before ${k}`, { status: 203 })
        case "throw":
          throw new Error(`b${k}`)
        case "reject":
          return Promise.reject(new Error(`b${k}`))
        case "throw-unrenderable":
          throw status(401, UNRENDERABLE)
        case "reject-unrenderable":
          return Promise.reject(status(401, UNRENDERABLE))
        default:
          return undefined
      }
    }
    // What `beforeHandler(hook)` does, without its `Context` parameter type.
    if (plan.guarded && k === plan.before.length - 1) LAST_BEFORE_HANDLE.add(hook)
    app = app.beforeHandle(hook)
  })
  plan.after.forEach((mode, k) => {
    app = app.afterHandle((result) => {
      calls.push(`a${k}`)
      switch (mode) {
        case "async":
          return Promise.resolve({ [`a${k}`]: result })
        case "undefined":
          return undefined
        case "throw":
          throw new Error(`a${k}`)
        case "reject":
          return Promise.reject(new Error(`a${k}`))
        case "throw-unrenderable":
          throw status(401, UNRENDERABLE)
        case "reject-unrenderable":
          return Promise.reject(status(401, UNRENDERABLE))
        default:
          return { [`a${k}`]: result }
      }
    })
  })
  // Never answers, so a thrown error keeps its default response; its presence alone refuses fusion.
  if (reference) app = app.onError(() => undefined)

  const handler = (c: Ctx): unknown => {
    calls.push("h")
    const seen = {
      ds: Object.keys(c)
        .filter((key) => /^d\d$/.test(key))
        .sort(),
      id: c.params.id,
      query: c.query,
      body: c.body,
    }
    switch (plan.handler) {
      case "async":
        return Promise.resolve(seen)
      case "throw":
        throw new Error("handler")
      case "reject":
        return Promise.reject(new Error("handler"))
      case "throw-unrenderable":
        throw status(401, UNRENDERABLE)
      case "reject-unrenderable":
        return Promise.reject(status(401, UNRENDERABLE))
      case "response":
        return new Response("handler response", { status: 207 })
      case "status":
        return status(201, seen)
      case "redirect":
        throw Response.redirect("https://example.com/next", 302)
      default:
        return seen
    }
  }
  if (shape.schema === "query") {
    app = app.get("/r/:id", { query: t.object({ limit: t.string() }) }, handler)
  } else if (shape.schema === "body") {
    app = app.post("/r/:id", { body: t.object({ name: t.string() }) }, handler)
  } else {
    app = app.get("/r/:id", handler)
  }
  if (plan.trailing === "before") {
    app = app.beforeHandle(() => {
      calls.push("t")
      return undefined
    })
  } else if (plan.trailing === "derive") {
    app = app.derive(() => {
      calls.push("t")
      return {}
    })
  } else if (plan.trailing === "after") {
    app = app.afterHandle((result) => {
      calls.push("t")
      return result
    })
  }
  return { app, calls }
}

function requests(shape: Shape): Request[] {
  const url = (path: string): string => `http://localhost${path}`
  const post = (body: unknown): Request =>
    new Request(url("/r/7"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  if (shape.schema === "query") {
    return [new Request(url("/r/7?limit=3")), new Request(url("/r/7"))]
  }
  if (shape.schema === "body") return [post({ name: "ada" }), post({})]
  return [new Request(url("/r/7"))]
}

interface View {
  readonly status: number
  readonly body: string
  readonly calls: readonly string[]
}

async function webView(app: AppLike, calls: string[], request: Request): Promise<View> {
  calls.length = 0
  let response: Response
  try {
    response = await app.fetch(request)
  } catch (err) {
    return { status: -1, body: `rejected: ${String(err)}`, calls: [...calls] }
  }
  const body = await response.text()
  const headers = ["content-type", "location", "x-b0", "x-b1"].map((n) => response.headers.get(n))
  return { status: response.status, body: `${body}|${headers.join(",")}`, calls: [...calls] }
}

async function nodeView(app: AppLike, calls: string[], request: Request): Promise<View> {
  calls.length = 0
  let outcome: NodeServeOutcome
  try {
    outcome = await app.resolveNode(request)
  } catch (err) {
    return { status: -1, body: `rejected: ${String(err)}`, calls: [...calls] }
  }
  let status: number
  let body: string
  let headers: (string | null)[]
  if (outcome.kind === "json") {
    status = outcome.status
    body = outcome.body ?? ""
    // The Node writer adds the JSON content type itself, so it is not in the outcome's headers.
    headers = ["content-type", "location", "x-b0", "x-b1"].map((n) =>
      n === "content-type" ? (body === "" ? null : JSON_TYPE) : headerOf(outcome.headers, n),
    )
  } else if (outcome.kind === "body") {
    status = outcome.status
    body = typeof outcome.body === "string" ? outcome.body : new TextDecoder().decode(outcome.body)
    headers = ["content-type", "location", "x-b0", "x-b1"].map((n) => headerOf(outcome.headers, n))
  } else {
    status = outcome.response.status
    body = await outcome.response.text()
    headers = ["content-type", "location", "x-b0", "x-b1"].map((n) =>
      outcome.response.headers.get(n),
    )
  }
  return { status, body: `${body}|${headers.join(",")}`, calls: [...calls] }
}

function headerOf(
  headers: Readonly<Record<string, string | readonly string[]>> | undefined,
  name: string,
): string | null {
  if (headers === undefined) return null
  const value = headers[name]
  if (value === undefined) return null
  return Array.isArray(value) ? value.join(", ") : String(value)
}

// One test per shape keeps each well inside the runner's timeout, coverage instrumentation included.
for (const shape of shapes()) {
  test(`hooks ${JSON.stringify(shape)} answer as the generic program does, on the Web and Node-direct lanes`, async () => {
    const expectedLane = shape.schema === "body" ? "body-hooks" : "hooks"
    const mismatches: string[] = []
    for (const plan of plans(shape)) {
      const fused = build(shape, plan, false)
      const reference = build(shape, plan, true)
      const lanes = [fused, reference].map(
        ({ app }) => app.catalog.entries()[0]?.entry.execution.fusedLane,
      )
      // Parity between two copies of the generic lane would prove nothing.
      if (lanes[0] !== expectedLane || lanes[1] !== undefined) {
        mismatches.push(`lanes ${lanes.join(" / ")}`)
        continue
      }
      for (const request of requests(shape)) {
        const want = await webView(reference.app, reference.calls, request.clone())
        const web = await webView(fused.app, fused.calls, request.clone())
        const node = await nodeView(fused.app, fused.calls, request.clone())
        const label = `${JSON.stringify(plan)} ${request.method} ${request.url}`
        if (JSON.stringify(web) !== JSON.stringify(want)) {
          mismatches.push(
            `web ${label}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(web)}`,
          )
        }
        if (JSON.stringify(node) !== JSON.stringify(want)) {
          mismatches.push(
            `node ${label}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(node)}`,
          )
        }
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([])
  })
}

test("the generated hook plans cover every axis", () => {
  const all = shapes()
  expect(all).toHaveLength(78)
  expect(all.reduce((total, shape) => total + plans(shape).length, 0)).toBeGreaterThan(30_000)
})

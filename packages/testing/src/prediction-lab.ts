/**
 * Seeded hostile corpus for predictions and projections - the prediction-side sibling of
 * `adversarial.ts`.
 *
 * `adversarial.ts` proves HTTP body/query/response contracts with validator-proven hostile
 * mutations. This module proves the same shaped guarantees one layer up: the `@nifrajs/webmcp`
 * prediction store (stale versions, expiry, prototype-grafting patches, non-atomic patches,
 * commit conflicts, reconcile/tool rollback) and the WebMCP-plus-MCP projection of one
 * capability (the same witness accepted or rejected identically on both surfaces).
 *
 * Every case has a stable ID, every run carries its replay seed, and every clock is injected -
 * nothing reads `Date.now` or `crypto.randomUUID` implicitly. `only` replays a subset by ID.
 *
 * Deliberately out of scope: A2A and AG-UI projections. Neither package exposes a same-contract
 * projection from a tool/capability (`a2a` has `agentCard`/`mountA2A` at the protocol level; there
 * is no `capability -> a2a/ag-ui` seam), so a parity case here would invent the seam it claims to
 * test. Proposing such a seam needs consumer evidence first (N7), not a lab that assumes it.
 */

import type { McpToolContext } from "@nifrajs/mcp/protocol"
import { toMcpTool } from "@nifrajs/mcp/tool-contract"
import {
  type AgentCapability,
  type AgentSurfacePrediction,
  createPredictionStore,
  defineAgentCapability,
  executePredicted,
  type PredictionStore,
  type PredictionStoreSnapshot,
  toWebMcpTool,
} from "@nifrajs/webmcp"

export type PredictionLabTarget = "prediction" | "projection"

export interface PredictionLabContext {
  readonly seed: number
  readonly caseId: string
  readonly target: PredictionLabTarget
  readonly mutation?: string
}

export interface PredictionLabReplay {
  readonly seed: number
  readonly caseId: string
}

export interface PredictionLabResult {
  readonly id: string
  readonly target: PredictionLabTarget
  readonly mutation?: string
  readonly ok: boolean
  readonly message: string
  readonly replay: PredictionLabReplay
}

export interface PredictionLabReport {
  readonly ok: boolean
  readonly seed: number
  readonly results: readonly PredictionLabResult[]
  readonly failures: readonly PredictionLabResult[]
  readonly counts: { readonly passed: number; readonly failed: number }
}

export interface PredictionLabOptions {
  /** Replayable seed. Prediction IDs and clocks derive from it deterministically. */
  readonly seed?: number
  /** Replay only these stable case IDs. */
  readonly only?: string | readonly string[]
}

export const PREDICTION_LAB_SEED = 0x50_52_45_44

interface CartItem {
  readonly sku: string
  readonly quantity: number
}

interface CartState {
  readonly items: readonly CartItem[]
}

interface AddInput {
  readonly sku: string
  readonly quantity: number
}

interface AddOutput {
  readonly cartVersion: string
}

type LabSchema<Input, Output = Input> = {
  readonly jsonSchema: Readonly<Record<string, unknown>>
  readonly "~standard": {
    readonly version: 1
    readonly vendor: string
    readonly types: { readonly input: Input; readonly output: Output }
    readonly validate: (
      value: unknown,
    ) => { readonly value: Output } | { readonly issues: readonly { readonly message: string }[] }
  }
}

function issue(message: string): { readonly issues: readonly { readonly message: string }[] } {
  return { issues: [{ message }] }
}

const mcpContext: McpToolContext = {
  signal: new AbortController().signal,
  requestId: null,
  reportProgress: () => {},
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Strict cart-add input: unknown fields rejected, so hostile extras are provably invalid. */
const addInputSchema: LabSchema<AddInput> = {
  jsonSchema: {
    type: "object",
    properties: {
      sku: { type: "string", minLength: 1 },
      quantity: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    },
    required: ["sku", "quantity"],
    additionalProperties: false,
  },
  "~standard": {
    version: 1,
    vendor: "prediction-lab",
    types: {
      input: { sku: "example", quantity: 1 },
      output: { sku: "example", quantity: 1 },
    },
    validate(value: unknown) {
      if (typeof value !== "object" || value === null) return issue("input must be an object")
      const record = value as Record<string, unknown>
      const keys = Object.keys(record).sort()
      if (keys.join(",") !== "quantity,sku") return issue("input must be exactly { sku, quantity }")
      if (typeof record.sku !== "string" || record.sku === "")
        return issue("sku must be a non-empty string")
      if (!Number.isSafeInteger(record.quantity) || (record.quantity as number) <= 0)
        return issue("quantity must be a positive safe integer")
      return { value: { sku: record.sku as string, quantity: record.quantity as number } }
    },
  },
}

const addOutputSchema: LabSchema<AddOutput> = {
  jsonSchema: {
    type: "object",
    properties: { cartVersion: { type: "string" } },
    required: ["cartVersion"],
    additionalProperties: false,
  },
  "~standard": {
    version: 1,
    vendor: "prediction-lab",
    types: {
      input: { cartVersion: "example" },
      output: { cartVersion: "example" },
    },
    validate(value: unknown) {
      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as Record<string, unknown>).cartVersion !== "string"
      )
        return issue("output must carry cartVersion")
      return { value: { cartVersion: (value as Record<string, unknown>).cartVersion as string } }
    },
  },
}

function labCapability(options: {
  readonly execute: (input: AddInput) => AddOutput | Promise<AddOutput>
  readonly reconcileThrows?: boolean
  readonly onExecute?: () => void
  readonly onReconcile?: () => void
}): AgentCapability<AddInput, AddOutput, CartState> {
  return defineAgentCapability({
    name: "cart.add",
    description: "Add a product to the current cart.",
    input: addInputSchema,
    output: addOutputSchema,
    writes: ["cart"],
    execute: (input) => {
      options.onExecute?.()
      return options.execute(input)
    },
    predict: ({ input, version }) => ({
      baseVersion: version,
      patch: [{ op: "add", path: "/items/-", value: { sku: input.sku, quantity: input.quantity } }],
    }),
    reconcile: ({ input, output }) => {
      options.onReconcile?.()
      if (options.reconcileThrows === true) throw new Error("lab reconcile failure")
      void input
      return {
        state: { items: [{ sku: "server-item", quantity: 1 }] },
        version: (output as AddOutput).cartVersion,
      }
    },
  })
}

function emptyCart(version: string): { readonly state: CartState; readonly version: string } {
  return { state: { items: [] }, version }
}

function cartAddPrediction(version: string, sku = "lab-sku"): AgentSurfacePrediction {
  return {
    baseVersion: version,
    patch: [{ op: "add", path: "/items/-", value: { sku, quantity: 1 } }],
  }
}
function deterministicExecutionOptions(predictionId: string, now: number) {
  return {
    predictionId,
    now: () => now,
    effectId: `${predictionId}-effect`,
    clock: () => now,
  }
}

type CaseRun = (ctx: {
  readonly seed: number
  readonly now: number
  readonly predictionId: (index: number) => string
}) =>
  | Promise<{ readonly ok: boolean; readonly message: string }>
  | { readonly ok: boolean; readonly message: string }

interface LabCase {
  readonly id: string
  readonly target: PredictionLabTarget
  readonly mutation?: string
  readonly run: CaseRun
}

function snapshotItems(snapshot: PredictionStoreSnapshot<CartState>): readonly CartItem[] {
  return snapshot.state.items
}

const LAB_CASES: readonly LabCase[] = [
  {
    id: "prediction-stale-version",
    target: "prediction",
    mutation: "baseVersion v0 against authoritative v1",
    run: ({ now, predictionId }) => {
      const store = createPredictionStore<CartState>(emptyCart("v1"))
      const result = store.predict(predictionId(0), { ...cartAddPrediction("v0") }, now)
      const stateKept = snapshotItems(result.snapshot).length === 0
      const ok = result.outcome === "stale" && stateKept
      return {
        ok,
        message: ok
          ? "stale baseVersion rejected without touching state"
          : `expected stale + empty state, got ${result.outcome} + ${snapshotItems(result.snapshot).length} items`,
      }
    },
  },
  {
    id: "prediction-expired-at-predict",
    target: "prediction",
    mutation: "expiresAt at or before now",
    run: ({ now, predictionId }) => {
      const store = createPredictionStore<CartState>(emptyCart("v1"))
      const result = store.predict(
        predictionId(0),
        { ...cartAddPrediction("v1"), expiresAt: now },
        now,
      )
      const ok = result.outcome === "expired" && snapshotItems(result.snapshot).length === 0
      return {
        ok,
        message: ok
          ? "already-expired prediction refused"
          : `expected expired, got ${result.outcome}`,
      }
    },
  },
  {
    id: "prediction-expire-sweep",
    target: "prediction",
    mutation: "clock advances past expiresAt",
    run: ({ now, predictionId }) => {
      const store = createPredictionStore<CartState>(emptyCart("v1"))
      const events: string[] = []
      store.subscribe((event) => {
        events.push(event.type)
      })
      const predicted = store.predict(
        predictionId(0),
        { ...cartAddPrediction("v1"), expiresAt: now + 1000 },
        now,
      )
      if (predicted.outcome !== "predicted")
        return { ok: false, message: `setup failed: ${predicted.outcome}` }
      const swept = store.expire(now + 2000)
      const after = store.snapshot()
      const ok =
        swept.length === 1 &&
        swept[0] === predictionId(0) &&
        after.activePredictionIds.length === 0 &&
        snapshotItems(after).length === 0 &&
        events.includes("expired")
      return {
        ok,
        message: ok ? "expiry swept the overlay with an event" : "expiry sweep left residue",
      }
    },
  },
  {
    id: "prediction-prototype-path",
    target: "prediction",
    mutation: "patch path traverses forbidden prototype segments",
    run: ({ now, predictionId }) => {
      const store = createPredictionStore<CartState>(emptyCart("v1"))
      const forbidden = ["__proto__", "constructor", "prototype"] as const
      // Each forbidden pointer must fail before an overlay is stored; checking all three keeps the
      // corpus aligned with the store's complete prototype-pollution guard.
      let allThrew = true
      for (const [index, segment] of forbidden.entries()) {
        let threw = false
        try {
          store.predict(
            predictionId(index),
            {
              baseVersion: "v1",
              patch: [
                { op: "add", path: `/${segment}/polluted`, value: { sku: "x", quantity: 1 } },
              ],
            },
            now,
          )
        } catch {
          threw = true
        }
        allThrew = allThrew && threw
      }
      const after = store.snapshot()
      const ok =
        allThrew &&
        after.activePredictionIds.length === 0 &&
        snapshotItems(after).length === 0 &&
        (Object.prototype as Record<string, unknown>).polluted === undefined
      return {
        ok,
        message: ok
          ? "prototype-grafting patches threw without storing overlays"
          : "prototype patch was not fail-closed",
      }
    },
  },
  {
    id: "prediction-non-atomic-patch",
    target: "prediction",
    mutation: "second op removes a missing path",
    run: ({ now, predictionId }) => {
      const store = createPredictionStore<CartState>(emptyCart("v1"))
      // A patch whose second op cannot apply throws during candidate application - before the
      // overlay is stored - so the first op must not survive either. Assert throw + empty state.
      let threw = false
      try {
        store.predict(
          predictionId(0),
          {
            baseVersion: "v1",
            patch: [
              { op: "add", path: "/items/-", value: { sku: "a", quantity: 1 } },
              { op: "remove", path: "/items/7" },
            ],
          },
          now,
        )
      } catch {
        threw = true
      }
      const after = store.snapshot()
      const ok =
        threw && after.activePredictionIds.length === 0 && snapshotItems(after).length === 0
      return {
        ok,
        message: ok
          ? "partial patch threw - no half-applied overlay"
          : `non-atomic patch left ${snapshotItems(after).length} items`,
      }
    },
  },
  {
    id: "prediction-duplicate-id-invalid",
    target: "prediction",
    mutation: "same prediction id predicted twice",
    run: ({ now, predictionId }) => {
      const store = createPredictionStore<CartState>(emptyCart("v1"))
      const first = store.predict(predictionId(0), cartAddPrediction("v1"), now)
      const second = store.predict(predictionId(0), cartAddPrediction("v1"), now)
      const ok = first.outcome === "predicted" && second.outcome === "invalid"
      return {
        ok,
        message: ok
          ? "duplicate prediction id rejected"
          : `${first.outcome} then ${second.outcome}`,
      }
    },
  },
  {
    id: "prediction-commit-conflict",
    target: "prediction",
    mutation: "authoritative version advances before commit",
    run: ({ now, predictionId }) => {
      const store: PredictionStore<CartState> = createPredictionStore<CartState>(emptyCart("v1"))
      const first = store.predict(predictionId(0), cartAddPrediction("v1", "first"), now)
      const second = store.predict(predictionId(1), cartAddPrediction("v1", "second"), now)
      if (first.outcome !== "predicted" || second.outcome !== "predicted")
        return { ok: false, message: "setup failed" }
      const committed = store.commit(predictionId(0), emptyCart("v2"), now)
      if (committed.outcome !== "committed") return { ok: false, message: "setup commit failed" }
      const late = store.commit(predictionId(1), emptyCart("v3"), now)
      const after = store.snapshot()
      const ok =
        late.outcome === "conflicted" &&
        after.version === "v2" &&
        after.activePredictionIds.length === 0
      return {
        ok,
        message: ok ? "late commit conflicted without clobbering v2" : `got ${late.outcome}`,
      }
    },
  },
  {
    id: "prediction-tool-failure-rolls-back",
    target: "prediction",
    mutation: "tool execute throws after predict",
    run: async ({ now, predictionId }) => {
      let executed = false
      const capability = labCapability({
        execute: () => {
          executed = true
          throw new Error("lab tool failure")
        },
      })
      const store = createPredictionStore<CartState>(emptyCart("v1"))
      const before = store.snapshot()
      const result = await executePredicted(
        capability,
        { sku: "lab-sku", quantity: 1 },
        store,
        deterministicExecutionOptions(predictionId(0), now),
      )
      const after = store.snapshot()
      const ok =
        executed &&
        result.tool?.ok === false &&
        result.outcome === "rolled-back" &&
        after.activePredictionIds.length === 0 &&
        snapshotItems(after).length === snapshotItems(before).length
      return {
        ok,
        message: ok ? "tool failure rolled the overlay back" : `got ${result.outcome}`,
      }
    },
  },
  {
    id: "prediction-reconcile-failure-rolls-back",
    target: "prediction",
    mutation: "reconcile throws after a successful tool call",
    run: async ({ now, predictionId }) => {
      let executed = false
      let reconciled = false
      const capability = labCapability({
        execute: () => {
          executed = true
          return { cartVersion: "v2" }
        },
        reconcileThrows: true,
        onReconcile: () => {
          reconciled = true
        },
      })
      const store = createPredictionStore<CartState>(emptyCart("v1"))
      const result = await executePredicted(
        capability,
        { sku: "lab-sku", quantity: 1 },
        store,
        deterministicExecutionOptions(predictionId(0), now),
      )
      const after = store.snapshot()
      const ok =
        executed &&
        reconciled &&
        result.tool?.ok === true &&
        result.outcome === "rolled-back" &&
        after.version === "v1" &&
        snapshotItems(after).length === 0
      return {
        ok,
        message: ok ? "reconcile failure kept authoritative v1" : `got ${result.outcome}`,
      }
    },
  },
  {
    id: "prediction-commit-accepts-server",
    target: "prediction",
    mutation: "happy path - predict, execute, reconcile, commit",
    run: async ({ now, predictionId }) => {
      let executed = false
      let reconciled = false
      const capability = labCapability({
        execute: () => {
          executed = true
          return { cartVersion: "v2" }
        },
        onReconcile: () => {
          reconciled = true
        },
      })
      const store = createPredictionStore<CartState>(emptyCart("v1"))
      const result = await executePredicted(
        capability,
        { sku: "lab-sku", quantity: 1 },
        store,
        deterministicExecutionOptions(predictionId(0), now),
      )
      const after = store.snapshot()
      const item = snapshotItems(after)[0]
      const ok =
        executed &&
        reconciled &&
        result.tool?.ok === true &&
        result.outcome === "committed" &&
        after.version === "v2" &&
        item?.sku === "server-item" &&
        item.quantity === 1
      return {
        ok,
        message: ok ? "predicted execution committed at v2" : `got ${result.outcome}`,
      }
    },
  },
  {
    id: "projection-webmcp-mcp-parity",
    target: "projection",
    mutation: "same witness across toWebMcpTool and toMcpTool",
    run: async ({ now, predictionId }) => {
      const capability = labCapability({
        execute: (input) => ({ cartVersion: `v-${input.sku}` }),
      })
      const webmcp = toWebMcpTool(capability, {
        effectId: `${predictionId(0)}-webmcp-effect`,
        clock: () => now,
      })
      // The WebMCP adapter grants the tool's own capability itself; the MCP adapter takes the
      // host's grant at construction. Both grants name the same token, so the boundary stays one.
      const mcp = toMcpTool(capability.tool, {
        capabilities: [capability.tool.capability],
        effectId: `${predictionId(0)}-mcp-effect`,
        clock: () => now,
      })
      const valid = { sku: "lab-sku", quantity: 2 }
      const webValid = (await webmcp.execute(valid)) as { readonly ok: boolean }
      const mcpValid = (await mcp.handler(valid, mcpContext)) as { readonly isError?: true }
      const hostiles: readonly { readonly name: string; readonly input: unknown }[] = [
        { name: "wrong-type", input: { sku: "lab-sku", quantity: "two" } },
        { name: "missing-field", input: { sku: "lab-sku" } },
        { name: "unknown-field", input: { sku: "lab-sku", quantity: 1, admin: true } },
        { name: "empty-sku", input: { sku: "", quantity: 1 } },
        { name: "non-object", input: "add-to-cart" },
      ]
      const mismatches: string[] = []
      if (webValid.ok !== true) mismatches.push("webmcp rejected the valid witness")
      if (mcpValid.isError === true) mismatches.push("mcp rejected the valid witness")
      if (webmcp.name !== mcp.name) mismatches.push("projected tool names differ")
      if (webmcp.description !== mcp.description) mismatches.push("projected descriptions differ")
      if (JSON.stringify(webmcp.inputSchema) !== JSON.stringify(mcp.inputSchema))
        mismatches.push("projected input schemas differ")
      const properties = webmcp.inputSchema.properties
      if (
        !isRecord(properties) ||
        !Object.hasOwn(properties, "sku") ||
        !Object.hasOwn(properties, "quantity")
      )
        mismatches.push("projected input schema omits the valid witness fields")
      for (const hostile of hostiles) {
        const web = (await webmcp.execute(hostile.input)) as { readonly ok: boolean }
        const viaMcp = (await mcp.handler(
          hostile.input as unknown as Record<string, unknown>,
          mcpContext,
        )) as { readonly isError?: true }
        if (web.ok !== false) mismatches.push(`webmcp accepted ${hostile.name}`)
        if (viaMcp.isError !== true) mismatches.push(`mcp accepted ${hostile.name}`)
      }
      const ok = mismatches.length === 0
      return {
        ok,
        message: ok ? "both projections share one validation boundary" : mismatches.join("; "),
      }
    },
  },
]

export async function runPredictionLab(
  options: PredictionLabOptions = {},
): Promise<PredictionLabReport> {
  const seed = options.seed ?? PREDICTION_LAB_SEED
  if (!Number.isSafeInteger(seed))
    throw new TypeError("prediction lab: seed must be a finite safe integer")
  const requested =
    options.only === undefined
      ? undefined
      : Array.isArray(options.only)
        ? [...options.only]
        : [options.only]
  let only: Set<string> | undefined
  if (requested !== undefined) {
    if (requested.length === 0)
      throw new TypeError("prediction lab: only must select at least one case ID")
    const known = new Set(LAB_CASES.map((labCase) => labCase.id))
    const unknown = requested.filter((id) => typeof id !== "string" || !known.has(id))
    if (unknown.length > 0)
      throw new RangeError(`prediction lab: unknown case ID(s): ${unknown.join(", ")}`)
    only = new Set(requested)
  }
  const now = 1_700_000_000_000 + (seed % 1000)
  const predictionId = (index: number): string => `pl-${seed.toString(16)}-${index}`
  const results: PredictionLabResult[] = []
  for (const labCase of LAB_CASES) {
    if (only !== undefined && !only.has(labCase.id)) continue
    let outcome: { readonly ok: boolean; readonly message: string }
    try {
      outcome = await labCase.run({ seed, now, predictionId })
    } catch (error) {
      outcome = {
        ok: false,
        message: error instanceof Error ? `threw: ${error.message}` : "threw an unknown value",
      }
    }
    results.push(
      Object.freeze({
        id: labCase.id,
        target: labCase.target,
        ...(labCase.mutation === undefined ? {} : { mutation: labCase.mutation }),
        ok: outcome.ok,
        message: outcome.message,
        replay: Object.freeze({ seed, caseId: labCase.id }),
      }),
    )
  }
  const failures = Object.freeze(results.filter((result) => !result.ok))
  return Object.freeze({
    ok: failures.length === 0,
    seed,
    results: Object.freeze(results),
    failures,
    counts: Object.freeze({ passed: results.length - failures.length, failed: failures.length }),
  })
}

/** Run the lab and throw a joined error on failure - the `assertAdversarialContract` shape. */
export async function assertPredictionLab(
  options: PredictionLabOptions = {},
): Promise<PredictionLabReport> {
  const report = await runPredictionLab(options)
  if (!report.ok) {
    throw new Error(
      `Prediction lab failed: ${report.failures.map((failure) => `${failure.id} - ${failure.message} (replay seed ${report.seed})`).join("\n")}`,
    )
  }
  return report
}

/** Stable case IDs in run order. */
export const predictionLabCaseIds: readonly string[] = Object.freeze(
  LAB_CASES.map((labCase) => labCase.id),
)

export function toPredictionLabContext(
  seed: number,
  labCase: {
    readonly id: string
    readonly target: PredictionLabTarget
    readonly mutation?: string
  },
): PredictionLabContext {
  return {
    seed,
    caseId: labCase.id,
    target: labCase.target,
    ...(labCase.mutation === undefined ? {} : { mutation: labCase.mutation }),
  }
}

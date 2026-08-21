/**
 * `@nifrajs/testing/agent-eval` - a deterministic, evidence-only eval harness for agent runs.
 *
 * A suite is a bounded set of cases, each scored by one or more typed rubrics. A rubric is a closed
 * contract: an ordered outcome allow-list, a finite score range, and a set of named numeric metrics.
 * Nothing else is admitted - a verdict carrying free-form evaluator prose, an out-of-range score, or
 * an unknown outcome is rejected at parse time. There is no opaque blended "agent score": the report
 * is the evidence contract (ids, codes, bounded numbers, digests) and nothing more.
 *
 * Determinism is structural: cases run in sorted id order and every digest is taken over a canonical,
 * order-independent projection, so reordering declarations cannot change a digest. Baseline
 * comparison classifies each (case, rubric) as equal / improved / tolerated / regressed / missing /
 * incomparable against explicit tolerances, and every regression carries a stable, addressable id.
 */

const TOKEN = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const MAX_CASES = 512
const MAX_RUBRICS = 32
const MAX_OUTCOMES = 32
const MAX_METRICS = 32

// ── Rubric contract ───────────────────────────────────────────────────────────────────────────

/** A closed rubric contract. Outcomes are ordered worst -> best; the index is the outcome rank. */
export interface RubricSpec {
  readonly id: string
  /** Ordered outcome codes, worst first. Rank = index; a change in rank is an improvement/regression. */
  readonly outcomes: readonly string[]
  /** Finite inclusive score range. */
  readonly score: { readonly min: number; readonly max: number }
  /** Whether a higher score is better. Default true. Governs improved/regressed classification. */
  readonly higherIsBetter?: boolean
  /** Allowed numeric metric names. A verdict metric outside this set is rejected. */
  readonly metrics?: readonly string[]
}

/** One rubric's verdict on one case. Numbers and codes only; no free-form text field exists. */
export interface RubricVerdict {
  readonly rubricId: string
  readonly outcome: string
  readonly score: number
  readonly metrics?: Readonly<Record<string, number>>
}

// ── Case and suite ────────────────────────────────────────────────────────────────────────────

/** One eval case. `evaluate` is a deterministic producer of rubric verdicts - evidence, not a run. */
export interface AgentEvalCase {
  readonly id: string
  evaluate(): readonly RubricVerdict[] | PromiseLike<readonly RubricVerdict[]>
}

export interface AgentEvalSuiteSpec {
  readonly id: string
  readonly version?: number
  readonly rubrics: readonly RubricSpec[]
  readonly cases: readonly AgentEvalCase[]
}

export interface AgentEvalSuite {
  readonly id: string
  readonly version: number
  readonly caseIds: readonly string[]
  readonly rubricIds: readonly string[]
  run(): Promise<AgentEvalReport>
}

// ── Report (the evidence contract) ────────────────────────────────────────────────────────────

/** The frozen shape of a rubric, embedded so a baseline comparison is self-contained. */
export interface RubricShape {
  readonly rubricId: string
  readonly outcomes: readonly string[]
  readonly scoreMin: number
  readonly scoreMax: number
  readonly higherIsBetter: boolean
  readonly digest: string
}

export interface CaseResult {
  readonly caseId: string
  readonly verdicts: readonly RubricVerdict[]
  readonly digest: string
}

export interface AgentEvalReport {
  readonly version: 1
  readonly suiteId: string
  readonly suiteVersion: number
  readonly rubricShapes: readonly RubricShape[]
  readonly cases: readonly CaseResult[]
  readonly digest: string
}

// ── Baseline comparison ───────────────────────────────────────────────────────────────────────

export type ComparisonCode =
  | "equal"
  | "improved"
  | "tolerated"
  | "regressed"
  | "missing"
  | "incomparable"

/** Explicit tolerance for a score regression. `rubricId` omitted applies to every rubric. */
export interface ScoreTolerance {
  readonly rubricId?: string
  /** Absolute worsening tolerated. Default 0. */
  readonly abs?: number
  /** Relative worsening tolerated, as a fraction of the baseline magnitude. Default 0. */
  readonly rel?: number
}

export interface BaselineOptions {
  readonly tolerances?: readonly ScoreTolerance[]
  /** Comparison codes that fail the assertion. Default `["regressed"]`. */
  readonly failOn?: readonly ComparisonCode[]
}

export interface CaseComparison {
  readonly caseId: string
  readonly rubricId: string
  readonly code: ComparisonCode
  readonly regressionId: string
  readonly baselineScore?: number
  readonly currentScore?: number
}

export interface BaselineComparison {
  readonly suiteId: string
  readonly comparisons: readonly CaseComparison[]
  readonly regressions: readonly string[]
  readonly digest: string
}

/** Thrown by {@link assertAgentEvalBaseline} when a comparison contains a failing code. */
export class AgentEvalRegressionError extends Error {
  constructor(readonly comparison: BaselineComparison) {
    super(
      `agent eval ${comparison.suiteId}: ${comparison.regressions.length} regression(s): ` +
        comparison.regressions.join(", "),
    )
    this.name = "AgentEvalRegressionError"
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value)
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function assertToken(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || !TOKEN.test(value))
    throw new TypeError(`agent eval: ${what} must be a bounded token`)
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record))
    if (!allowed.includes(key))
      throw new TypeError(`agent eval: verdict carries unexpected key '${key}'`)
}

function validateRubric(rubric: RubricSpec): void {
  assertToken(rubric.id, "rubric id")
  if (rubric.outcomes.length < 1 || rubric.outcomes.length > MAX_OUTCOMES)
    throw new RangeError(`agent eval: rubric must declare 1-${MAX_OUTCOMES} outcomes`)
  const seen = new Set<string>()
  for (const outcome of rubric.outcomes) {
    assertToken(outcome, "outcome code")
    if (seen.has(outcome)) throw new TypeError(`agent eval: duplicate outcome '${outcome}'`)
    seen.add(outcome)
  }
  if (!Number.isFinite(rubric.score.min) || !Number.isFinite(rubric.score.max))
    throw new TypeError("agent eval: rubric score range must be finite")
  if (rubric.score.min > rubric.score.max)
    throw new RangeError("agent eval: rubric score min must not exceed max")
  if (rubric.metrics !== undefined) {
    if (rubric.metrics.length > MAX_METRICS)
      throw new RangeError(`agent eval: rubric declares more than ${MAX_METRICS} metrics`)
    const metricSeen = new Set<string>()
    for (const metric of rubric.metrics) {
      assertToken(metric, "metric name")
      if (metricSeen.has(metric)) throw new TypeError(`agent eval: duplicate metric '${metric}'`)
      metricSeen.add(metric)
    }
  }
}

/** Parse one verdict against its rubric. Fails closed on unknown outcome, bad range, or stray key. */
export function parseRubricVerdict(rubric: RubricSpec, value: unknown): RubricVerdict {
  if (!isRecord(value)) throw new TypeError("agent eval: verdict must be an object")
  assertOnlyKeys(value, ["rubricId", "outcome", "score", "metrics"])
  if (value.rubricId !== rubric.id)
    throw new TypeError(
      `agent eval: verdict rubricId '${String(value.rubricId)}' != '${rubric.id}'`,
    )
  if (typeof value.outcome !== "string" || !rubric.outcomes.includes(value.outcome))
    throw new TypeError(
      `agent eval: unknown outcome '${String(value.outcome)}' for rubric ${rubric.id}`,
    )
  if (typeof value.score !== "number" || !Number.isFinite(value.score))
    throw new TypeError(`agent eval: verdict score for ${rubric.id} must be a finite number`)
  if (value.score < rubric.score.min || value.score > rubric.score.max)
    throw new RangeError(
      `agent eval: score ${value.score} out of [${rubric.score.min}, ${rubric.score.max}] for ${rubric.id}`,
    )
  let metrics: Record<string, number> | undefined
  if (value.metrics !== undefined) {
    if (!isRecord(value.metrics))
      throw new TypeError("agent eval: verdict metrics must be an object")
    const allowed = new Set(rubric.metrics ?? [])
    const out: Record<string, number> = {}
    for (const [key, metricValue] of Object.entries(value.metrics)) {
      if (!allowed.has(key))
        throw new TypeError(`agent eval: unknown metric '${key}' for ${rubric.id}`)
      if (typeof metricValue !== "number" || !Number.isFinite(metricValue))
        throw new TypeError(`agent eval: metric '${key}' must be a finite number`)
      out[key] = metricValue
    }
    metrics = out
  }
  return Object.freeze({
    rubricId: rubric.id,
    outcome: value.outcome,
    score: value.score,
    ...(metrics !== undefined ? { metrics: Object.freeze(metrics) } : {}),
  })
}

// ── Suite construction and execution ──────────────────────────────────────────────────────────

/** Declare a bounded, deterministic eval suite. Duplicate case or rubric ids fail closed. */
export function defineAgentEvalSuite(spec: AgentEvalSuiteSpec): AgentEvalSuite {
  assertToken(spec.id, "suite id")
  const version = spec.version ?? 1
  if (!Number.isInteger(version) || version < 1)
    throw new RangeError("agent eval: suite version must be a positive integer")
  if (spec.rubrics.length < 1 || spec.rubrics.length > MAX_RUBRICS)
    throw new RangeError(`agent eval: suite must declare 1-${MAX_RUBRICS} rubrics`)
  const rubricById = new Map<string, RubricSpec>()
  for (const rubric of spec.rubrics) {
    validateRubric(rubric)
    if (rubricById.has(rubric.id))
      throw new TypeError(`agent eval: duplicate rubric id '${rubric.id}'`)
    rubricById.set(rubric.id, rubric)
  }
  if (spec.cases.length < 1 || spec.cases.length > MAX_CASES)
    throw new RangeError(`agent eval: suite must declare 1-${MAX_CASES} cases`)
  const caseById = new Map<string, AgentEvalCase>()
  for (const testCase of spec.cases) {
    assertToken(testCase.id, "case id")
    if (caseById.has(testCase.id))
      throw new TypeError(`agent eval: duplicate case id '${testCase.id}'`)
    caseById.set(testCase.id, testCase)
  }

  const caseIds = [...caseById.keys()].sort()
  const rubricIds = [...rubricById.keys()].sort()

  return Object.freeze({
    id: spec.id,
    version,
    caseIds: Object.freeze(caseIds),
    rubricIds: Object.freeze(rubricIds),
    async run(): Promise<AgentEvalReport> {
      const rubricShapes = await Promise.all(
        rubricIds.map((id) => shapeOf(rubricById.get(id) as RubricSpec)),
      )
      const cases: CaseResult[] = []
      for (const caseId of caseIds) {
        const produced = await (caseById.get(caseId) as AgentEvalCase).evaluate()
        const perRubric = new Map<string, RubricVerdict>()
        for (const raw of produced) {
          if (!isRecord(raw) || typeof raw.rubricId !== "string")
            throw new TypeError(
              `agent eval: case '${caseId}' produced a verdict without a rubricId`,
            )
          const rubric = rubricById.get(raw.rubricId)
          if (rubric === undefined)
            throw new TypeError(
              `agent eval: case '${caseId}' scored unknown rubric '${raw.rubricId}'`,
            )
          if (perRubric.has(rubric.id))
            throw new TypeError(`agent eval: case '${caseId}' scored rubric '${rubric.id}' twice`)
          perRubric.set(rubric.id, parseRubricVerdict(rubric, raw))
        }
        const verdicts = [...perRubric.values()].sort((a, b) =>
          a.rubricId.localeCompare(b.rubricId),
        )
        cases.push({
          caseId,
          verdicts: Object.freeze(verdicts),
          digest: await sha256(canonical({ caseId, verdicts })),
        })
      }
      const digest = await sha256(
        canonical({
          suiteId: spec.id,
          suiteVersion: version,
          rubricShapes,
          cases: cases.map((entry) => ({ caseId: entry.caseId, digest: entry.digest })),
        }),
      )
      return Object.freeze({
        version: 1 as const,
        suiteId: spec.id,
        suiteVersion: version,
        rubricShapes: Object.freeze(rubricShapes),
        cases: Object.freeze(cases),
        digest,
      })
    },
  })
}

async function shapeOf(rubric: RubricSpec): Promise<RubricShape> {
  const higherIsBetter = rubric.higherIsBetter ?? true
  const projection = {
    rubricId: rubric.id,
    outcomes: rubric.outcomes,
    scoreMin: rubric.score.min,
    scoreMax: rubric.score.max,
    higherIsBetter,
  }
  return Object.freeze({ ...projection, digest: await sha256(canonical(projection)) })
}

// ── Baseline comparison ───────────────────────────────────────────────────────────────────────

/** Compare a fresh report against a baseline report. Every (case, rubric) gets a stable id. */
export async function compareAgentEvalBaseline(
  baseline: AgentEvalReport,
  current: AgentEvalReport,
  options: BaselineOptions = {},
): Promise<BaselineComparison> {
  const baseShapes = new Map(baseline.rubricShapes.map((shape) => [shape.rubricId, shape]))
  const curShapes = new Map(current.rubricShapes.map((shape) => [shape.rubricId, shape]))
  const baseVerdicts = indexVerdicts(baseline)
  const curVerdicts = indexVerdicts(current)

  const keys = new Set<string>([...baseVerdicts.keys(), ...curVerdicts.keys()])
  const comparisons: CaseComparison[] = []
  for (const key of [...keys].sort()) {
    const [caseId, rubricId] = key.split(" ") as [string, string]
    const regressionId = `${current.suiteId}/${caseId}/${rubricId}`
    const base = baseVerdicts.get(key)
    const cur = curVerdicts.get(key)
    const code = classify(
      base,
      cur,
      baseShapes.get(rubricId),
      curShapes.get(rubricId),
      rubricId,
      options,
    )
    comparisons.push(
      Object.freeze({
        caseId,
        rubricId,
        code,
        regressionId,
        ...(base !== undefined ? { baselineScore: base.score } : {}),
        ...(cur !== undefined ? { currentScore: cur.score } : {}),
      }),
    )
  }
  const failOn = new Set(options.failOn ?? ["regressed"])
  const regressions = comparisons
    .filter((entry) => failOn.has(entry.code))
    .map((entry) => entry.regressionId)
  const digest = await sha256(canonical({ suiteId: current.suiteId, comparisons }))
  return Object.freeze({
    suiteId: current.suiteId,
    comparisons: Object.freeze(comparisons),
    regressions: Object.freeze(regressions),
    digest,
  })
}

/** Assert no failing comparison. Throws {@link AgentEvalRegressionError} with the stable ids. */
export async function assertAgentEvalBaseline(
  baseline: AgentEvalReport,
  current: AgentEvalReport,
  options: BaselineOptions = {},
): Promise<BaselineComparison> {
  const comparison = await compareAgentEvalBaseline(baseline, current, options)
  if (comparison.regressions.length > 0) throw new AgentEvalRegressionError(comparison)
  return comparison
}

function indexVerdicts(report: AgentEvalReport): Map<string, RubricVerdict> {
  const map = new Map<string, RubricVerdict>()
  for (const entry of report.cases)
    for (const verdict of entry.verdicts) map.set(`${entry.caseId} ${verdict.rubricId}`, verdict)
  return map
}

function classify(
  base: RubricVerdict | undefined,
  cur: RubricVerdict | undefined,
  baseShape: RubricShape | undefined,
  curShape: RubricShape | undefined,
  rubricId: string,
  options: BaselineOptions,
): ComparisonCode {
  if (base === undefined || cur === undefined) return "missing"
  if (baseShape === undefined || curShape === undefined || baseShape.digest !== curShape.digest)
    return "incomparable"
  const baseRank = curShape.outcomes.indexOf(base.outcome)
  const curRank = curShape.outcomes.indexOf(cur.outcome)
  if (baseRank !== curRank) return curRank > baseRank ? "improved" : "regressed"

  // Same outcome: compare the score in the rubric's better-direction.
  if (cur.score === base.score) return "equal"
  const better = curShape.higherIsBetter ? cur.score > base.score : cur.score < base.score
  if (better) return "improved"
  const worseBy = Math.abs(cur.score - base.score)
  const tolerance = resolveTolerance(rubricId, options)
  const allowed = Math.max(tolerance.abs, tolerance.rel * Math.abs(base.score))
  return worseBy <= allowed ? "tolerated" : "regressed"
}

function resolveTolerance(
  rubricId: string,
  options: BaselineOptions,
): { readonly abs: number; readonly rel: number } {
  let abs = 0
  let rel = 0
  for (const tolerance of options.tolerances ?? []) {
    if (tolerance.rubricId !== undefined && tolerance.rubricId !== rubricId) continue
    if (tolerance.abs !== undefined) abs = Math.max(abs, tolerance.abs)
    if (tolerance.rel !== undefined) rel = Math.max(rel, tolerance.rel)
  }
  return { abs, rel }
}

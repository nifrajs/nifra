import type { AssurancePolicy, AssuranceRule } from "../assurance.ts"
import { NIFRA_ASSURANCE_IDS } from "../internal/route-assurance.ts"

/**
 * How much a {@link securityBaseline} demands. Each level is a superset of the one before it, so
 * raising the level only ever adds findings.
 *
 * - `"essential"` - the invariants that hold for ANY app and never false-positive on a reasonable
 *   one: a body read must be bounded, an unlimited body may never claim to be bounded, an agent tool
 *   ingress must be bounded, and an authenticated state change must prove CSRF. Every required piece
 *   of evidence here is either published by the core from the route schema or only demanded when the
 *   route already opted into the risk (CSRF is required only where authentication is present). Safe to
 *   adopt on day one.
 * - `"standard"` (default) - essential, plus: a route the app itself classified as `pii` or higher
 *   must be authenticated, whether it reads or writes. High signal, low noise - it fires only on
 *   routes the application already labelled sensitive.
 * - `"strict"` - standard, plus the opinionated, higher-friction requirements: every route must carry
 *   a response contract, every read must carry security headers, and every mutation must be rate
 *   limited. These need middleware the app has to install, so they are opt-in rather than default.
 */
export type SecurityBaselineLevel = "essential" | "standard" | "strict"

/** Tuning for {@link securityBaseline}. Every knob only ever tightens the policy. */
export interface SecurityBaselineOptions {
  /** How much the baseline demands. Default `"standard"`. See {@link SecurityBaselineLevel}. */
  readonly level?: SecurityBaselineLevel
  /**
   * How to treat a route no rule matched. Default `"ignore"` so the baseline is purely additive - it
   * asserts the invariants below and stays silent on everything else, which lets a project adopt it
   * without first classifying its whole route table. Set `"error"` to make an unclassified route a
   * finding, turning the baseline into a closed allow-list (recommended once the table is covered).
   */
  readonly unmatched?: "error" | "ignore"
  /**
   * Require that a matched route's evidence was installed by runtime enforcement (middleware/plugin
   * or framework policy) rather than asserted inline on `schema.assurance`. Default `true`: an author
   * label is not proof, and a security baseline that accepts labels is theater. Set `false` only to
   * stage adoption before guards emit runtime evidence.
   */
  readonly requireRuntimeProvenance?: boolean
}

const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const
const READING = ["GET", "HEAD"] as const
/** The classification threshold above which the baseline demands authentication. */
const SENSITIVE = "pii" as const

/**
 * A first-match-wins security policy that turns the recurring audit finding classes into machine
 * checked route invariants. Composed only from the public assurance engine, so it inherits its
 * fail-closed evaluation, provenance checks, and selector validation - no bespoke evaluator.
 *
 * The rules are ordered most-specific-first because assurance evaluation is first-match-wins: each
 * route is owned by exactly one rule, so that rule carries the FULL requirement bundle for its class
 * (a body-carrying mutation proves bounded-body AND CSRF in one rule, not two). Raising the `level`
 * widens those bundles; it never reorders them.
 *
 * Coverage by level (see {@link SecurityBaselineLevel} for the rationale):
 *
 * | invariant | essential | standard | strict |
 * | --- | :-: | :-: | :-: |
 * | unlimited body can never be "bounded" (F-001) | ✓ | ✓ | ✓ |
 * | every body read is bounded | ✓ | ✓ | ✓ |
 * | agent tool ingress is bounded | ✓ | ✓ | ✓ |
 * | authenticated mutation proves CSRF | ✓ | ✓ | ✓ |
 * | pii+ route is authenticated | | ✓ | ✓ |
 * | every route carries a response contract | | | ✓ |
 * | every read carries security headers | | | ✓ |
 * | every mutation is rate limited | | | ✓ |
 *
 * The baseline deliberately does not select on `access`/`zone` capabilities: those selectors require
 * capability definitions and would make the preset refuse an app that declares none. Extend the
 * returned policy's `rules` for capability- or path-specific requirements; put more specific rules
 * before these so they own their routes first.
 */
export function securityBaseline(options: SecurityBaselineOptions = {}): AssurancePolicy {
  const level = options.level ?? "standard"
  const strict = level === "strict"
  const authSensitive = level !== "essential"
  const provenance = options.requireRuntimeProvenance === false ? "any" : "runtime"

  const A = NIFRA_ASSURANCE_IDS
  // Evidence the app must install middleware for, gated to the levels that assume that cost.
  const contract = strict ? [A.RESPONSE_CONTRACT] : []
  const headers = strict ? [A.SECURITY_HEADERS] : []
  const rateLimit = strict ? [A.RATE_LIMITED] : []
  const authed = authSensitive ? [A.AUTHENTICATED] : []

  const rules: AssuranceRule[] = [
    // The static twin of the config-time rejection: a schema route that opted into `bodyLimit:
    // "unlimited"` can never carry `nifra.body-bounded` (the core withholds it), so requiring it is a
    // standing ban. Owns the unlimited case before any body rule below can soften it. (F-001.)
    {
      name: "banned-unlimited-body",
      match: { hasBody: true, bodyLimit: "unlimited" },
      require: [A.BODY_BOUNDED],
    },
    // Agent tool ingress buffers attacker-influenced arguments; it must be bounded. Not CSRF-guarded:
    // tool calls are token-authenticated machine traffic, not ambient-cookie browser posts.
    {
      name: "tool-ingress-bounded",
      match: { tools: true, hasBody: true },
      require: [A.BODY_BOUNDED, ...contract],
      requireProvenance: provenance,
    },
  ]

  // Sensitive mutations, split by body shape so bounded-body is required only where a body exists.
  // Emitted only when a level adds a requirement beyond the generic mutation rules, otherwise they
  // would be redundant duplicates that only slow evaluation.
  if (authSensitive || strict) {
    rules.push(
      {
        name: "sensitive-mutation-body",
        match: { methods: [...MUTATING], hasBody: true, classificationAtLeast: SENSITIVE },
        require: [A.BODY_BOUNDED, ...authed, ...contract, ...rateLimit],
        requireCsrfWithAuthenticated: true,
        requireProvenance: provenance,
      },
      {
        name: "sensitive-mutation",
        match: { methods: [...MUTATING], classificationAtLeast: SENSITIVE },
        require: [...authed, ...contract, ...rateLimit],
        requireCsrfWithAuthenticated: true,
        requireProvenance: provenance,
      },
    )
  }

  rules.push(
    {
      name: "mutation-body",
      match: { methods: [...MUTATING], hasBody: true },
      require: [A.BODY_BOUNDED, ...contract, ...rateLimit],
      requireCsrfWithAuthenticated: true,
      requireProvenance: provenance,
    },
    {
      name: "mutation",
      match: { methods: [...MUTATING] },
      require: [...contract, ...rateLimit],
      requireCsrfWithAuthenticated: true,
      requireProvenance: provenance,
    },
  )

  if (authSensitive || strict) {
    rules.push({
      name: "sensitive-read",
      match: { methods: [...READING], classificationAtLeast: SENSITIVE },
      require: [...authed, ...contract, ...headers],
      requireProvenance: provenance,
    })
  }

  // The catch-all read rule. At essential/standard its requirement bundle is empty, so it is a pure
  // classification that simply marks reads as covered - which matters only under `unmatched: "error"`,
  // where an unowned route would otherwise fail. At strict it demands the response + header contract.
  rules.push({
    name: "read",
    match: { methods: [...READING] },
    require: [...contract, ...headers],
    ...(strict ? { requireProvenance: provenance } : {}),
  })

  return {
    rules,
    unmatched: options.unmatched ?? "ignore",
    // A wrong import reflecting zero routes must fail, not silently pass a security gate.
    allowEmpty: false,
  }
}

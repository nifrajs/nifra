/**
 * What every runtime is held to, alone and against each other.
 *
 * 1. Bad client input never answers 5xx.
 * 2. Every request ends - a response, or a closed connection - before the deadline.
 * 3. No stack trace, file path or internal message reaches a body or a header.
 * 4. Every lane gives the same status, headers and body.
 *
 * What may differ is written down here, each entry with its reason: `DOCUMENTED_*` for differences
 * that are by design, `OPEN_*` for violations that wait for a decision, each listed with a
 * reproduction in the PR that added the harness. Delete an `OPEN_*` entry with its fix.
 */
import { brotliDecompressSync, gunzipSync } from "node:zlib"
import { needsResolving } from "../../packages/core/src/server/request-target.ts"
import { INTERNAL_SENTINEL } from "../fixtures/runtime-differential/app.ts"
import { type Case, nonAscii, SERVER_FAULT_ROUTES } from "./arbitraries.ts"
import { LANE_NAMES, type LaneName } from "./lanes.ts"
import type { Outcome } from "./wire.ts"

export type ViolationKind =
  | "server-error"
  | "hang"
  | "no-response"
  | "malformed-response"
  | "leak"
  | "difference"
  | "runtime-fault"

export interface Violation {
  readonly kind: ViolationKind
  /** Stable across cases that fail the same way; a shrink keeps a counterexample on its signature. */
  readonly signature: string
  /** The lanes that showed it. */
  readonly lanes: readonly LaneName[]
  readonly detail: string
}

export type Outcomes = ReadonlyMap<LaneName, Outcome>

/** Framing and transport headers each runtime sets its own way; none of them is the app's answer. */
export const TRANSPORT_HEADERS: ReadonlySet<string> = new Set([
  "date",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "server",
])

const utf8 = new TextDecoder("utf-8", { fatal: true })
const latin1 = new TextDecoder("latin1")

export function bodyText(body: Uint8Array): string {
  try {
    return utf8.decode(body)
  } catch {
    return `base64:${Buffer.from(body).toString("base64")}`
  }
}

/** The part of an outcome two runtimes must agree on, as one comparable string. */
export function canonical(outcome: Outcome): string {
  if (outcome.kind !== "response") return outcome.kind
  const headers = outcome.headers
    .filter(([name]) => !TRANSPORT_HEADERS.has(name))
    .map(([name, value], order) => ({ name, value, order }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.order - b.order))
    .map(({ name, value }) => `${name}: ${value}`)
  return `${outcome.status}\n${headers.join("\n")}\n\n${bodyText(outcome.body)}`
}

/** Short label of an outcome for signatures: the status, or the kind of non-answer. */
export function label(outcome: Outcome): string {
  return outcome.kind === "response" ? String(outcome.status) : outcome.kind
}

/** A runtime turning the request away: any 4xx, or closing without an answer. */
export const isRefusal = (outcome: Outcome) =>
  outcome.kind === "closed" ||
  (outcome.kind === "response" && outcome.status >= 400 && outcome.status < 500)

/**
 * A rewrite of one lane's answer into the form the others give, for a difference only in how the
 * runtime spells the same thing. Applied before lanes are compared.
 */
export interface Equivalence {
  readonly id: string
  readonly why: string
  /** The rewritten outcome, or `undefined` when this rule does not touch it. */
  apply(lane: LaneName, outcome: Outcome): Outcome | undefined
}

function withContentType(outcome: Outcome, from: string, to: string): Outcome | undefined {
  if (outcome.kind !== "response") return undefined
  if (!outcome.headers.some(([name, value]) => name === "content-type" && value === from))
    return undefined
  return {
    ...outcome,
    headers: outcome.headers.map(([name, value]): readonly [string, string] =>
      name === "content-type" && value === from ? [name, to] : [name, value],
    ),
  }
}

/** The body decoded from the `Content-Encoding` the platform applied, with that header dropped. */
function decoded(outcome: Outcome): Outcome | undefined {
  if (outcome.kind !== "response") return undefined
  const encoding = outcome.headers.find(([name]) => name === "content-encoding")?.[1]
  if (encoding !== "gzip" && encoding !== "br") return undefined
  const headers = outcome.headers.filter(([name]) => name !== "content-encoding")
  // A HEAD or 204 carries the header and no body to decode.
  if (outcome.body.length === 0) return { ...outcome, headers }
  let body: Uint8Array
  try {
    body = encoding === "gzip" ? gunzipSync(outcome.body) : brotliDecompressSync(outcome.body)
  } catch {
    return undefined
  }
  return { ...outcome, body, headers }
}

export const DOCUMENTED_EQUIVALENCES: readonly Equivalence[] = [
  {
    id: "streamed-file-dated-when-settled",
    why:
      "A static file too big to snapshot is dated only once its last change is more than 2 s old, so " +
      "whether `last-modified` comes back depends on when the request lands, not on the runtime. The " +
      "harness writes its tree at startup; every other header and the bytes are still compared.",
    apply: (_lane, outcome) =>
      outcome.kind === "response" &&
      outcome.headers.some(
        ([name, value]) => name === "content-type" && value === "application/octet-stream",
      ) &&
      outcome.headers.some(([name]) => name === "last-modified")
        ? { ...outcome, headers: outcome.headers.filter(([name]) => name !== "last-modified") }
        : undefined,
  },
  {
    id: "workerd-compresses",
    why:
      "Workers compress a response for a client that accepts it, as Cloudflare's edge does; the app " +
      "installs no compression. The decoded body must still be the other runtimes' body.",
    apply: (lane, outcome) => (lane === "workerd" ? decoded(outcome) : undefined),
  },
  {
    id: "json-content-type-is-the-runtimes",
    why:
      "nifra's JSON carries the Content-Type the runtime's own Response.json writes, so a handler's JSON " +
      "and the framework's envelopes agree on one runtime: Bun says application/json;charset=utf-8, " +
      "undici, Deno and workerd application/json.",
    apply: (lane, outcome) =>
      lane === "node" || lane === "deno" || lane === "workerd"
        ? withContentType(outcome, "application/json", "application/json;charset=utf-8")
        : undefined,
  },
]

export const OPEN_EQUIVALENCES: readonly Equivalence[] = []

const PARSER_REFUSAL = "refused by its own parser"

/** An open entry named in `exposed`, by its whole id or its leading code (`U16`), excuses nothing. */
export const isExposed = (id: string, exposed: ReadonlySet<string>) =>
  exposed.has(id) || exposed.has(id.slice(0, id.indexOf(" ")))

/** The app marks every answer it gives (`onResponseHeaders` in the fixture). */
const fromApp = (outcome: Outcome) =>
  outcome.kind === "response" &&
  outcome.headers.some(([name, value]) => name === "x-differential" && value === "1")

/**
 * The local workerd lane runs behind `wrangler dev`, whose front answers some requests itself before
 * the Worker runs: 501 to a method that is not a token, 500 to an absolute-form target, a repeated
 * Host or a Content-Length it cannot read, 415 to `Accept-Encoding: *;q=0`, a 500 with its own stack
 * when the client hangs up inside a body. An answer without the app's mark is the front's, not the
 * app's, so it is held to nothing. Production traffic meets Cloudflare's edge instead.
 */
export const FRONT_ANSWER = "U2 workerd-front-answer"

/** Lanes that do not take part in judging this case, with the reason. */
export function excluded(
  testCase: Case,
  outcomes: Outcomes,
  exposed: ReadonlySet<string> = new Set(),
): ReadonlyMap<LaneName, string> {
  const out = new Map<LaneName, string>()
  for (const [lane, outcome] of outcomes) {
    if (outcome.kind === "unrepresentable") out.set(lane, outcome.reason)
  }
  const edge = outcomes.get("workerd")
  if (edge?.kind === "response" && !fromApp(edge) && !isExposed(FRONT_ANSWER, exposed))
    out.set("workerd", FRONT_ANSWER)
  // Workers have no filesystem: static assets are the platform's job, so the edge build registers no
  // static route.
  if (testCase.route === "static" && outcomes.has("workerd") && !out.has("workerd"))
    out.set("workerd", "no filesystem on the edge")
  // A runtime may refuse what its parser does not take (`Case.refusable`); every lane that takes the
  // request must still agree with every other.
  if (testCase.refusable.length > 0) {
    for (const [lane, outcome] of outcomes)
      if (isRefusal(outcome) && !out.has(lane)) out.set(lane, PARSER_REFUSAL)
  }
  return out
}

/** A known violation of any kind, excused while it waits for a decision. */
export interface Waiver {
  readonly id: string
  readonly why: string
  matches(violation: Violation, testCase: Case, outcomes: Outcomes): boolean
}

const statusOf = (outcomes: Outcomes, lane: LaneName) => {
  const outcome = outcomes.get(lane)
  return outcome?.kind === "response" ? outcome.status : undefined
}

/** Every compared lane but `lane` gave one and the same answer. */
const othersAgree = (outcomes: Outcomes, lane: LaneName) =>
  new Set([...outcomes].filter(([name]) => name !== lane).map(([, outcome]) => canonical(outcome)))
    .size <= 1

/** The violation is `lane`'s alone: every other lane agrees, or only `lane` broke the invariant. */
const aloneIn = (violation: Violation, outcomes: Outcomes, lane: LaneName) =>
  violation.kind === "difference"
    ? othersAgree(outcomes, lane)
    : violation.lanes.every((name) => name === lane)

/**
 * A form page's answer with what its action read left out: the `saved` paragraph of the page, or
 * the whole body in data mode, where the action's result is the body. A 400 is kept only as the
 * `invalid_form` a body the runtime cannot parse gets; anything else is `undefined`.
 */
function withoutFormRead(outcome: Outcome | undefined): string | undefined {
  if (outcome?.kind !== "response") return undefined
  const text = bodyText(outcome.body)
  if (outcome.status === 400)
    return text.includes('"invalid_form"') ? "400 invalid_form" : undefined
  if (outcome.status !== 200) return undefined
  const data = outcome.headers.some(
    ([name, value]) => name === "content-type" && value.startsWith("application/json"),
  )
  const masked = data
    ? "(what the action read)"
    : text.replace(/<p class="saved">[^<]*<\/p>/, '<p class="saved">(what the action read)</p>')
  return canonical({ ...outcome, body: new TextEncoder().encode(masked) })
}

export const OPEN_FINDINGS: readonly Waiver[] = [
  {
    id: "W2 runtime-form-parsers-differ",
    why:
      "`c.req.formData()` is the runtime's own parser, and the runtimes read one body differently: a file " +
      "part without a Content-Type is text/plain;charset=utf-8 on Bun, text/plain on Node, " +
      "application/octet-stream on Deno and '' on workerd; workerd decodes a malformed `%A` and unescapes " +
      "`\\` in a filename; Bun accepts a quoted boundary holding a quote and Deno an unclosed multipart, " +
      "which the others refuse as invalid_form. Waived only where every lane answers the page or " +
      "invalid_form and the pages differ in nothing but what the action read.",
    matches: (violation, testCase, outcomes) => {
      if (violation.kind !== "difference" || testCase.route !== "pageForm") return false
      const pages = new Set<string>()
      for (const lane of LANE_NAMES) {
        if (!outcomes.has(lane)) continue
        const page = withoutFormRead(outcomes.get(lane))
        if (page === undefined) return false
        if (page !== "400 invalid_form") pages.add(page)
      }
      return pages.size <= 1
    },
  },
  {
    id: "U16 workerd-joins-cookies-with-comma",
    why:
      "Two Cookie headers reach a Worker joined by ', ' (the Fetch rule for repeated fields); Bun, Node " +
      "and Deno join Cookie with '; '. nifra splits on ';', so on workerd the first cookie swallows the next. " +
      "Splitting on ', ' too would let an unencoded cookie value holding ', sid=x' inject a cookie, and a " +
      "browser sends one Cookie line, so it stays a workerd quirk.",
    matches: (violation, testCase, outcomes) =>
      violation.kind === "difference" &&
      testCase.request.headers.filter(([name]) => name.toLowerCase() === "cookie").length > 1 &&
      othersAgree(outcomes, "workerd"),
  },
  {
    id: "U4 workerd-waits-after-early-eof",
    why:
      "When a request's body ends early (the client half-closes inside its framing), local workerd keeps " +
      "the Worker's body read waiting and never answers. Bun and Node close; Deno answers 400.",
    matches: (violation, testCase) =>
      violation.kind === "hang" &&
      violation.lanes.length === 1 &&
      violation.lanes[0] === "workerd" &&
      testCase.refusable.includes("body shorter than its framing"),
  },
  {
    id: "U5 workerd-decodes-header-bytes-as-utf8",
    why:
      "A header value with bytes past ASCII is one character per byte (latin1) on Bun, Node and Deno, as " +
      "Fetch's ByteString says; workerd decodes it as UTF-8. An app echoing such a header differs.",
    matches: (violation, testCase, outcomes) =>
      violation.kind === "difference" &&
      testCase.request.headers.some(([, value]) => nonAscii(value)) &&
      othersAgree(outcomes, "workerd"),
  },
  {
    id: "U6 repeated-header-empty-member",
    why:
      "A field repeated with an empty member (`x:` and `x: 1`) is read two ways: Bun, Node and workerd " +
      "join it as ', 1', while Deno's `Headers` iteration drops the empty member (`get` does not). A " +
      "header schema or an echo of the value differs by runtime.",
    matches: (violation, testCase) => {
      if (violation.kind !== "difference") return false
      const seen = new Map<string, number>()
      for (const [name] of testCase.request.headers)
        seen.set(name.toLowerCase(), (seen.get(name.toLowerCase()) ?? 0) + 1)
      return testCase.request.headers.some(
        ([name, value]) => value.trim() === "" && (seen.get(name.toLowerCase()) ?? 0) > 1,
      )
    },
  },
  {
    id: "U9 workerd-resolves-dot-segments-twice",
    why:
      "workerd resolves a raw `..` before the Worker's URL parser sees `%2e%2e`, so `/old/%2e%2e/..` " +
      "reaches the app as `/old/` where a single WHATWG pass (Bun, Node, Deno) gives `/`. The app " +
      "routes a different handler on workerd.",
    matches: (violation, testCase, outcomes) =>
      violation.kind === "difference" &&
      /%2e/i.test(testCase.request.target) &&
      needsResolving(testCase.request.target) &&
      othersAgree(outcomes, "workerd"),
  },
  {
    id: "U7 workerd-keeps-trailing-space",
    why:
      "A header value is read without the whitespace around it (RFC 9110 section 5.5); workerd keeps the " +
      "trailing space (' pad ' reads as 'pad '). An app echoing such a header differs.",
    matches: (violation, testCase, outcomes) =>
      violation.kind === "difference" &&
      testCase.request.headers.some(([, value]) => value !== value.trimEnd()) &&
      othersAgree(outcomes, "workerd"),
  },
  {
    id: "U3 deno-truncates-after-early-eof",
    why:
      "When a request's body ends early (the client half-closes inside its framing), Deno.serve writes the " +
      "head of a streamed response, Content-Length included, then closes without the body, or sends nothing " +
      "at all. A bare Deno.serve handler does the same; Bun and Node close without answering.",
    matches: (violation, testCase) =>
      violation.kind === "malformed-response" &&
      violation.lanes.length === 1 &&
      violation.lanes[0] === "deno" &&
      testCase.refusable.includes("body shorter than its framing"),
  },
  {
    id: "U1 bun-505-on-space-in-target",
    why:
      "Bun.serve reads a request line with a raw space in the target as a bad HTTP version and answers " +
      "505 before the app runs; Node and Deno answer 400. Runtime behaviour, not nifra's.",
    matches: (violation, testCase, outcomes) =>
      statusOf(outcomes, "bun-serve") === 505 &&
      / /.test(testCase.request.target) &&
      aloneIn(violation, outcomes, "bun-serve"),
  },
]

/** Entries a runtime writes to stderr that are known and listed. An entry is a line and the indented
 * lines under it (a stack, an object dump), matched on its first line. */
export const KNOWN_STDERR: readonly {
  readonly id: string
  readonly lane: LaneName
  readonly entry: RegExp
}[] = [
  {
    // Printed once per process, when Deno finishes the response to a request whose `signal` was read,
    // unless Deno runs with `--unstable-no-legacy-abort`. nifra reads it to carry it over when it
    // rebuilds a request.
    id: "U10 deno-legacy-abort-notice",
    lane: "deno",
    entry: /^Deno\.serve: request\.signal aborts on successful responses \(legacy behavior\)/,
  },
  {
    // `wrangler dev`'s proxy logs a client that hangs up once it has its answer, or mid-body (the
    // harness closes every connection after the first response, and half-closes inside a body), and
    // any request it failed itself, whose answer the case is already judged on. A Durable Object
    // holding N WebSockets also logs "Network connection lost" N-1 times as they close; a bare
    // WebSocketPair hub without nifra does the same.
    id: "U8 wrangler-proxy-log",
    lane: "workerd",
    entry:
      /^✘ \[ERROR\] (?:Failed to drain the unused request body\.|Uncaught Error: Network connection lost\.|Error inside ProxyWorker \(the affected request failed; the dev server continues\): )/,
  },
  {
    // Linux workerd logs the C++ check that refused an input: a URL or Host it cannot parse (a port
    // past 65535 fails while it builds the request URL), a bad chunk size, a CONNECT with no connect()
    // handler to take it, a close frame RFC 6455 forbids (and the proxy's copy of that failure). macOS
    // workerd logs none of these. The case is still judged on its answer, and an exception in the
    // Worker's own code logs as a JavaScript error, not one of these.
    id: "U17 workerd-logs-refused-input",
    lane: "workerd",
    entry:
      /^✘ \[ERROR\] (?:Uncaught exception: |e = )(?:kj|workerd)\/[\w/-]+\.(?:c\+\+|h):\d+: failed: /,
  },
]

const LEAK_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["sentinel", new RegExp(INTERNAL_SENTINEL, "g")],
  ["stack-frame", /\bat [^\s()]+ \((?:file:|node:|\/|[A-Za-z]:\\)[^)]*\)/g],
  ["stack-frame", /\n\s+at (?:file:|node:|\/)\S+/g],
  [
    "file-path",
    /(?:file:\/\/|\/Users\/|\/home\/|\/srv\/|\/private\/var\/|node_modules\/|[A-Za-z]:\\\\)[^\s"'<>)]*/g,
  ],
  ["source-location", /\.(?:[cm]?[jt]sx?):\d+(?::\d+)?/g],
  [
    "error-class",
    /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|AggregateError)\b/g,
  ],
]

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** Every leak pattern found in `said` that nothing in `sent` carried. */
export function leaksIn(said: string, sent: readonly string[]): string[] {
  const found: string[] = []
  for (const [id, pattern] of LEAK_PATTERNS) {
    for (const match of said.matchAll(pattern)) {
      if (!sent.some((text) => text.includes(match[0])))
        found.push(`${id}: ${JSON.stringify(match[0].slice(0, 80))}`)
    }
  }
  return found
}

/** Every leak pattern found in the response that the request did not itself carry. */
function leaks(testCase: Case, outcome: Outcome): string[] {
  if (outcome.kind !== "response") return []
  const request = testCase.request
  const sent = [
    request.target,
    safeDecode(request.target),
    request.body,
    safeDecode(request.body),
    ...request.headers.flat(),
  ]
  return leaksIn(
    [latin1.decode(outcome.body), ...outcome.headers.map(([, value]) => value)].join("\n"),
    sent,
  )
}

/** Group lanes by identical canonical outcome, in lane order. */
export function groups(
  outcomes: Outcomes,
): { readonly lanes: LaneName[]; readonly outcome: Outcome; readonly key: string }[] {
  const out: { lanes: LaneName[]; outcome: Outcome; key: string }[] = []
  for (const lane of LANE_NAMES) {
    const outcome = outcomes.get(lane)
    if (outcome === undefined) continue
    const key = canonical(outcome)
    const group = out.find((candidate) => candidate.key === key)
    if (group === undefined) out.push({ lanes: [lane], outcome, key })
    else group.lanes.push(lane)
  }
  return out
}

export interface Judgement {
  readonly violations: readonly Violation[]
  /** Rules that excused something in this case, by id. */
  readonly excusedBy: readonly string[]
}

/** The invariants each lane is held to on its own. */
function ownViolations(testCase: Case, outcomes: Outcomes, tag: string): Violation[] {
  const seen = new Map<
    string,
    { kind: ViolationKind; what: string; lanes: LaneName[]; detail: string }
  >()
  const note = (kind: ViolationKind, lane: LaneName, what: string, detail: string) => {
    const entry = seen.get(`${kind}|${what}`)
    if (entry === undefined) seen.set(`${kind}|${what}`, { kind, what, lanes: [lane], detail })
    else entry.lanes.push(lane)
  }
  for (const [lane, outcome] of outcomes) {
    if (
      outcome.kind === "response" &&
      outcome.status >= 500 &&
      !SERVER_FAULT_ROUTES.has(testCase.route)
    ) {
      note(
        "server-error",
        lane,
        String(outcome.status),
        `${lane} answered ${outcome.status}: ${bodyText(outcome.body).slice(0, 300)}`,
      )
    }
    if (outcome.kind === "timeout")
      note(
        "hang",
        lane,
        "timeout",
        `${lane}: no complete response (${outcome.received} bytes received)`,
      )
    if (outcome.kind === "malformed-response")
      note("malformed-response", lane, "garbage", `${lane}: ${outcome.raw}`)
    if (outcome.kind === "closed" && testCase.refusable.length === 0) {
      note("no-response", lane, "closed", `${lane}: closed with no response (${outcome.detail})`)
    }
    for (const found of leaks(testCase, outcome))
      note("leak", lane, found.slice(0, found.indexOf(":")), `${lane}: ${found}`)
  }
  return [...seen.values()].map(({ kind, what, lanes, detail }) => ({
    kind,
    signature: `${kind} ${testCase.route} ${what} [${lanes.join(",")}]${tag}`,
    lanes,
    detail: lanes.length > 1 ? `${detail} (also: ${lanes.slice(1).join(", ")})` : detail,
  }))
}

/**
 * Hold `outcomes` to the invariants and to each other. `exposed` names open findings to report
 * instead of excuse, so a run shrinks them to a reproduction.
 */
export function judge(
  testCase: Case,
  outcomes: Outcomes,
  exposed: ReadonlySet<string> = new Set(),
): Judgement {
  const tag = testCase.refusable.length > 0 ? ` refusable=${testCase.refusable.join("+")}` : ""
  const excusedBy = new Set<string>()
  const skip = excluded(testCase, outcomes, exposed)
  if ([...skip.values()].includes(PARSER_REFUSAL)) excusedBy.add("parser-refusal")
  if ([...skip.values()].includes(FRONT_ANSWER)) excusedBy.add(FRONT_ANSWER)
  const violations = ownViolations(
    testCase,
    new Map([...outcomes].filter(([lane]) => skip.get(lane) !== FRONT_ANSWER)),
    tag,
  )

  const compared = new Map<LaneName, Outcome>()
  const normalized = new Map<LaneName, Outcome>()
  for (const [lane, outcome] of outcomes) {
    let current = outcome
    for (const rule of [
      ...DOCUMENTED_EQUIVALENCES,
      ...OPEN_EQUIVALENCES.filter((rule) => !isExposed(rule.id, exposed)),
    ]) {
      const rewritten = rule.apply(lane, current)
      if (rewritten !== undefined) {
        current = rewritten
        if (!skip.has(lane)) excusedBy.add(rule.id)
      }
    }
    normalized.set(lane, current)
    if (!skip.has(lane)) compared.set(lane, current)
  }
  const grouped = groups(compared)
  if (grouped.length > 1) {
    const counts = new Map<string, number>()
    for (const group of grouped)
      counts.set(label(group.outcome), (counts.get(label(group.outcome)) ?? 0) + 1)
    const summary = grouped
      .map(
        (group) =>
          `${group.lanes.join(",")}=${label(group.outcome)}${(counts.get(label(group.outcome)) ?? 0) > 1 ? "*" : ""}`,
      )
      .join(" ")
    violations.push({
      kind: "difference",
      signature: `difference ${testCase.route} ${summary}${tag}`,
      lanes: grouped.flatMap((group) => group.lanes),
      detail: grouped
        .map((group) => `--- ${group.lanes.join(",")}\n${group.key.slice(0, 1200)}`)
        .join("\n"),
    })
  }

  const open = violations.filter((violation) => {
    const outcomesFor = violation.kind === "difference" ? compared : normalized
    const waiver = OPEN_FINDINGS.find(
      (candidate) =>
        !isExposed(candidate.id, exposed) && candidate.matches(violation, testCase, outcomesFor),
    )
    if (waiver !== undefined) excusedBy.add(waiver.id)
    return waiver === undefined
  })
  return { violations: open, excusedBy: [...excusedBy] }
}

// Built from a string: a control character in a regex literal reads as a typo to the linter.
const ANSI_COLOR = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g")

/** A runtime's stderr with the known entries taken out, and the ids of the ones taken. */
export function unknownStderr(
  lane: LaneName,
  text: string,
): { readonly rest: string; readonly known: readonly string[] } {
  const known = new Set<string>()
  const plain = text.replace(ANSI_COLOR, "")
  const rest = plain
    .split(/\n(?=\S)/)
    .map((entry) => entry.trimEnd())
    .filter((entry) => {
      if (entry.trim() === "") return false
      const match = KNOWN_STDERR.find(
        (candidate) => candidate.lane === lane && candidate.entry.test(entry.trimStart()),
      )
      if (match !== undefined) known.add(match.id)
      return match === undefined
    })
    .join("\n")
  return { rest, known: [...known] }
}

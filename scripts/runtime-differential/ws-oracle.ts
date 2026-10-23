/**
 * What every runtime is held to over a WebSocket, alone and against each other.
 *
 * 1. Every session ends - each socket closed or refused - before the deadline.
 * 2. A refused handshake is the app's 4xx, unless the case's guard throws by design.
 * 3. No stack trace, file path or internal message reaches a frame, a close reason or a refusal.
 * 4. Every socket sees the same handshake answer and the same messages on every lane.
 *
 * What may differ is written down here: `socketLines` for how each runtime fails a connection, and
 * `WS_OPEN_FINDINGS` for violations that wait for a decision, as in `oracle.ts`.
 */
import { createHash } from "node:crypto"
import { LANE_NAMES, type LaneName } from "./lanes.ts"
import {
  bodyText,
  isExposed,
  type Judgement,
  leaksIn,
  TRANSPORT_HEADERS,
  type Violation,
  type ViolationKind,
} from "./oracle.ts"
import type { WsCase, WsEvent, WsOutcome } from "./ws.ts"

export type WsOutcomes = ReadonlyMap<LaneName, WsOutcome>

const utf8 = new TextDecoder()

/** A payload short enough to read is shown; a long one by its length and digest. */
function payloadText(bytes: Uint8Array): string {
  if (bytes.length <= 160) return JSON.stringify(bodyText(bytes))
  return `${bytes.length} bytes sha1:${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}`
}

function closeText(bytes: Uint8Array): string {
  if (bytes.length === 0) return "close with no code"
  if (bytes.length === 1) return "close with a 1-byte payload"
  return `close ${((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)} ${payloadText(bytes.subarray(2))}`
}

/** `Upgrade` and `Connection` are case-insensitive tokens (RFC 6455 section 4.2.2); runtimes vary. */
const TOKEN_HEADERS = new Set(["upgrade", "connection"])

/** The 101's headers, its `Upgrade` and `Connection` tokens kept: they are the handshake's answer. */
function openHeaders(headers: readonly (readonly [string, string])[]): string[] {
  return headers
    .filter(([name]) => !TRANSPORT_HEADERS.has(name) || TOKEN_HEADERS.has(name))
    .map(([name, value]) => `${name}: ${TOKEN_HEADERS.has(name) ? value.toLowerCase() : value}`)
    .sort()
}

/**
 * A refusal's headers without framing and transport. JSON is spelled as the runtime's own
 * `Response.json` spells it - `application/json;charset=utf-8` on Bun, `application/json` elsewhere
 * - as the HTTP oracle's `json-content-type-is-the-runtimes` equivalence says.
 */
function refusalHeaders(headers: readonly (readonly [string, string])[]): string[] {
  return headers
    .filter(([name]) => !TRANSPORT_HEADERS.has(name))
    .map(([name, value]) => `${name}: ${name === "content-type" ? contentType(value) : value}`)
    .sort()
}

/**
 * A body's type as the runtime's own `Response` spells it: `Response.json` writes
 * `application/json;charset=utf-8` on Bun and `application/json` elsewhere, and `new Response(text)`
 * writes `text/plain;charset=utf-8` on Bun and `text/plain;charset=UTF-8` elsewhere.
 */
function contentType(value: string): string {
  if (value === "application/json;charset=utf-8") return "application/json"
  if (value === "text/plain;charset=UTF-8") return "text/plain;charset=utf-8"
  return value
}

function eventText(event: WsEvent): string {
  switch (event.kind) {
    case "refused":
      return `refused ${event.status}\n${refusalHeaders(event.headers).join("\n")}\n\n${bodyText(event.body)}`
    case "open":
      return `open\n${openHeaders(event.headers).join("\n")}`
    case "text":
      return `< text ${payloadText(event.bytes)}`
    case "binary":
      return `< binary ${payloadText(event.bytes)}`
    case "pong":
      return `< pong ${payloadText(event.bytes)}`
    case "close":
      return `< ${closeText(event.bytes)}`
    case "end":
      return "< end"
    case "timeout":
      return `timeout waiting for ${event.waiting}`
    case "malformed":
      return `malformed: ${event.detail}`
    case "violation":
      return `> a frame RFC 6455 forbids (${event.step})`
    case "oversize":
      return "> a message over the cap"
  }
}

/** The close for a message over the cap: 1009, or Bun's drop. Its reason is the runtime's. */
const OVERSIZE_CLOSE = /^< (?:close 1009 .*|end)$/

/**
 * One socket's events as compared. After a frame the protocol forbids, the runtime fails the
 * connection its own way (U12-U14), so only what came before is compared. After a message over the
 * cap the socket closes with 1009 - Node's `ws` with no reason, Bun by dropping the connection (U11)
 * - so that close reads as one line on every runtime.
 */
function socketLines(events: readonly WsEvent[]): string[] {
  const lines: string[] = []
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event === undefined) continue
    lines.push(eventText(event))
    if (event.kind === "violation") {
      lines.push("(the runtime fails the connection its own way)")
      return lines
    }
    const next = events[i + 1]
    if (event.kind === "oversize" && next !== undefined && OVERSIZE_CLOSE.test(eventText(next))) {
      lines.push("< closed for the message over the cap")
      i++
    }
  }
  return lines
}

/** The part of a session two runtimes must agree on, as one comparable string. */
export function wsCanonical(outcome: WsOutcome): string {
  const failed = outcome.sockets[0]?.some((event) => event.kind === "violation") === true
  return outcome.sockets
    .map((events, i) => {
      // The watcher hears how the failed socket closed, which is the runtime's own answer too.
      const watcher = failed && i === outcome.sockets.length - 1 && i > 0
      const shown = watcher ? events.slice(0, 2) : events
      return `socket ${i}\n${socketLines(shown).join("\n")}${watcher ? "\n(close report not compared)" : ""}`
    })
    .join("\n")
}

/** Short label for signatures: the first socket's handshake status and how it ended. */
function wsLabel(outcome: WsOutcome): string {
  const events = outcome.sockets[0] ?? []
  const first = events[0]
  if (first?.kind === "refused") return String(first.status)
  if (first?.kind !== "open") return first?.kind ?? "nothing"
  const last = [...events].reverse().find((event) => event.kind !== "open")
  if (last?.kind === "close")
    return `101/${last.bytes.length < 2 ? "nocode" : ((last.bytes[0] ?? 0) << 8) | (last.bytes[1] ?? 0)}`
  return `101/${last?.kind ?? "open"}`
}

export function wsGroups(
  outcomes: WsOutcomes,
): { readonly lanes: LaneName[]; readonly outcome: WsOutcome; readonly key: string }[] {
  const out: { lanes: LaneName[]; outcome: WsOutcome; key: string }[] = []
  for (const lane of LANE_NAMES) {
    const outcome = outcomes.get(lane)
    if (outcome === undefined) continue
    const key = wsCanonical(outcome)
    const group = out.find((candidate) => candidate.key === key)
    if (group === undefined) out.push({ lanes: [lane], outcome, key })
    else group.lanes.push(lane)
  }
  return out
}

/** A refused handshake whose 5xx the case asked for: the guard throws on `x-ws-token: throw`. */
const throwsByDesign = (testCase: WsCase) =>
  testCase.route === "guarded" &&
  testCase.headers.some(([name, value]) => name === "x-ws-token" && value === "throw") &&
  !testCase.headers.some(([name]) => name === "x-block")

/** What the client sent, which a frame may carry back without leaking anything. */
function sentTexts(testCase: WsCase): string[] {
  const texts: string[] = [testCase.path, ...testCase.headers.flat()]
  for (const step of testCase.steps) {
    if (step.kind === "text" || step.kind === "ping") texts.push(step.text)
    else if (step.kind === "fragments") texts.push(step.parts.join(""))
    else if (step.kind === "close") texts.push(step.reason)
  }
  return texts
}

function said(event: WsEvent): string {
  switch (event.kind) {
    case "refused":
      return [utf8.decode(event.body), ...event.headers.map(([, value]) => value)].join("\n")
    case "text":
    case "pong":
      return utf8.decode(event.bytes)
    case "close":
      return utf8.decode(event.bytes.subarray(2))
    default:
      return ""
  }
}

export interface WsWaiver {
  readonly id: string
  readonly why: string
  matches(violation: Violation, testCase: WsCase, outcomes: WsOutcomes): boolean
}

export const WS_OPEN_FINDINGS: readonly WsWaiver[] = []

function ownViolations(testCase: WsCase, outcomes: WsOutcomes): Violation[] {
  const seen = new Map<
    string,
    { kind: ViolationKind; what: string; lanes: LaneName[]; detail: string }
  >()
  const note = (kind: ViolationKind, lane: LaneName, what: string, detail: string) => {
    const entry = seen.get(`${kind}|${what}`)
    if (entry === undefined) seen.set(`${kind}|${what}`, { kind, what, lanes: [lane], detail })
    else entry.lanes.push(lane)
  }
  const sent = sentTexts(testCase)
  for (const [lane, outcome] of outcomes) {
    outcome.sockets.forEach((events, socket) => {
      for (const event of events) {
        if (event.kind === "timeout")
          note(
            "hang",
            lane,
            "timeout",
            `${lane}: socket ${socket} timed out waiting for ${event.waiting}`,
          )
        if (event.kind === "malformed")
          note("malformed-response", lane, "garbage", `${lane}: socket ${socket}: ${event.detail}`)
        if (event.kind === "refused" && event.status >= 500 && !throwsByDesign(testCase))
          note(
            "server-error",
            lane,
            String(event.status),
            `${lane} refused the handshake with ${event.status}: ${bodyText(event.body).slice(0, 300)}`,
          )
        for (const found of leaksIn(said(event), sent))
          note(
            "leak",
            lane,
            found.slice(0, found.indexOf(":")),
            `${lane}: socket ${socket}: ${found}`,
          )
      }
    })
  }
  return [...seen.values()].map(({ kind, what, lanes, detail }) => ({
    kind,
    signature: `${kind} ws:${testCase.route} ${what} [${lanes.join(",")}]`,
    lanes,
    detail: lanes.length > 1 ? `${detail} (also: ${lanes.slice(1).join(", ")})` : detail,
  }))
}

/** Hold every lane's sessions to the invariants and to each other. */
export function judgeWs(
  testCase: WsCase,
  outcomes: WsOutcomes,
  exposed: ReadonlySet<string> = new Set(),
): Judgement {
  const violations = ownViolations(testCase, outcomes)
  const grouped = wsGroups(outcomes)
  if (grouped.length > 1) {
    const summary = grouped
      .map((group) => `${group.lanes.join(",")}=${wsLabel(group.outcome)}`)
      .join(" ")
    violations.push({
      kind: "difference",
      signature: `difference ws:${testCase.route} ${summary}`,
      lanes: grouped.flatMap((group) => group.lanes),
      detail: grouped
        .map((group) => `--- ${group.lanes.join(",")}\n${group.key.slice(0, 1500)}`)
        .join("\n"),
    })
  }
  const excusedBy = new Set<string>()
  const open = violations.filter((violation) => {
    const waiver = WS_OPEN_FINDINGS.find(
      (candidate) =>
        !isExposed(candidate.id, exposed) && candidate.matches(violation, testCase, outcomes),
    )
    if (waiver !== undefined) excusedBy.add(waiver.id)
    return waiver === undefined
  })
  return { violations: open, excusedBy: [...excusedBy] }
}

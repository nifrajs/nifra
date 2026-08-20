/**
 * Agent-run tracing - one OpenTelemetry span per bounded agent run, one child span per step
 * evidence item, effect ledger heads carried as span attributes.
 *
 * The bridge consumes only the runner's constrained step-evidence contract (`seq`, `kind`,
 * `outcome`, tool name, effect id, error code, ledger head): prompts, tool inputs, and outputs
 * cannot enter an export. The evidence shape is declared structurally so the package stays
 * dependency-free on `@nifrajs/agent`; the returned `telemetry` object satisfies its
 * `AgentTelemetryPort` as-is.
 */

import {
  type ActiveObservation,
  type AttributeValue,
  createObservationLifecycle,
  type ObservationAdapter,
  type ObservationContext,
  type ObservationParent,
} from "@nifrajs/otel"

/** Structural twin of `@nifrajs/agent`'s `AgentStepEvidence`. */
export interface AgentRunEvidence {
  readonly seq: number
  readonly at: number
  readonly kind: "model" | "tool" | "approval" | "budget" | "state"
  readonly outcome: "started" | "passed" | "failed" | "denied" | "suspended" | "committed"
  readonly name?: string
  readonly effectId?: string
  readonly code?: string
  readonly ledgerHead?: string
}

/** Structural slice of the runner's `AgentRunResult` that `end()` reads. */
export interface AgentRunOutcome {
  readonly status: "completed" | "suspended" | "continue"
  readonly error?: { readonly code: string }
  readonly reason?: string
}

export interface TraceAgentRunOptions {
  /** Agent name, recorded as `nifra.agent.name`. */
  readonly agent: string
  /** Turn id, recorded as `nifra.agent.turn_id`. */
  readonly turnId: string
  /** Exporter that receives the run span and its evidence child spans. */
  readonly exporter?: ObservationAdapter
  readonly adapters?: readonly ObservationAdapter[]
  /**
   * Parent span for the run - pass the enclosing request observation's `context` to nest agent
   * runs under the HTTP span. `null` forces a root span; `undefined` falls back to `traceparent`.
   */
  readonly parent?: ObservationParent | null
  /** Inbound W3C header used when `parent` is undefined. */
  readonly traceparent?: string | null
}

export interface AgentRunTrace {
  /** Pass as (or combine into) `ports.telemetry`. Never throws; a failing adapter cannot fail the turn. */
  readonly telemetry: { step(evidence: AgentRunEvidence): void }
  /** The run span's trace identity, forwardable with `traceHeaders`. */
  readonly context: ObservationContext
  /**
   * End the run span. Pass the runner's result to record the final status
   * (`nifra.agent.status`, pending reason, error code); omit it when the run threw.
   * Exactly-once: repeated calls are ignored.
   */
  end(result?: AgentRunOutcome): void
}

function evidenceAttributes(evidence: AgentRunEvidence): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {
    "nifra.agent.evidence.seq": evidence.seq,
    "nifra.agent.evidence.outcome": evidence.outcome,
  }
  if (evidence.name !== undefined) attributes["tool.name"] = evidence.name
  if (evidence.effectId !== undefined) attributes["nifra.effect.id"] = evidence.effectId
  if (evidence.code !== undefined) attributes["nifra.agent.error_code"] = evidence.code
  if (evidence.ledgerHead !== undefined) attributes["nifra.ledger.head"] = evidence.ledgerHead
  return attributes
}

/**
 * Open a run span and adapt the runner's step evidence into child spans.
 *
 *   const trace = traceAgentRun({ agent: agent.name, turnId, exporter, parent: c.observation?.context })
 *   const result = await runAgent(agent, input, { ...ports, telemetry: trace.telemetry }, options)
 *   trace.end(result)
 *
 * Model evidence arrives as a started/terminal pair and becomes one timed `nifra.agent.model`
 * span; every other evidence item is terminal-only and becomes an instant child span.
 */
export function traceAgentRun(options: TraceAgentRunOptions): AgentRunTrace {
  const adapters = [
    ...(options.exporter === undefined ? [] : [options.exporter]),
    ...(options.adapters ?? []),
  ]
  const lifecycle = createObservationLifecycle({ adapters })
  const run = lifecycle.start({
    name: "nifra.agent.run",
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    ...(options.traceparent === undefined ? {} : { traceparent: options.traceparent }),
    attributes: {
      "nifra.agent.name": options.agent,
      "nifra.agent.turn_id": options.turnId,
    },
  })
  // The runner is sequential - at most one model call is in flight, so a single slot pairs the
  // `started` item with its terminal twin. Kinds other than "model" emit terminal items only.
  let openModel: ActiveObservation | undefined

  const step = (evidence: AgentRunEvidence): void => {
    try {
      if (evidence.kind === "model" && evidence.outcome === "started") {
        openModel?.end({ status: "error", attributes: { "nifra.agent.error_code": "unpaired" } })
        openModel = run.startChild({
          name: "nifra.agent.model",
          attributes: evidenceAttributes(evidence),
        })
        return
      }
      const failed = evidence.outcome === "failed" || evidence.outcome === "denied"
      const status = failed ? "error" : "ok"
      if (evidence.kind === "model" && openModel !== undefined) {
        const span = openModel
        openModel = undefined
        span.setAttributes(evidenceAttributes(evidence))
        span.end({ status })
        return
      }
      run
        .startChild({
          name: `nifra.agent.${evidence.kind}`,
          attributes: evidenceAttributes(evidence),
        })
        .end({ status })
    } catch {
      // Telemetry must never fail the turn it observes.
    }
  }

  const end = (result?: AgentRunOutcome): void => {
    try {
      openModel?.end({ status: "error", attributes: { "nifra.agent.error_code": "run_ended" } })
      openModel = undefined
      if (result === undefined) {
        run.end({ status: "error", attributes: { "nifra.agent.status": "threw" } })
        return
      }
      const attributes: Record<string, AttributeValue> = { "nifra.agent.status": result.status }
      if (result.reason !== undefined) attributes["nifra.agent.pending_reason"] = result.reason
      if (result.error !== undefined) attributes["nifra.agent.error_code"] = result.error.code
      run.end({ status: result.error === undefined ? "ok" : "error", attributes })
    } catch {
      // Same fail-open rule as step().
    }
  }

  return Object.freeze({ telemetry: Object.freeze({ step }), context: run.context, end })
}

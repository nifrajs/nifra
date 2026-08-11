import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import {
  attachCapabilityJournal,
  type CapabilityExecutionJournal,
} from "@nifrajs/core/capabilities"
import { defineIdentityPlugin, type IdentityPlugin } from "@nifrajs/core/server"

export interface DurableCommandOptions {
  /** Where effect transitions are recorded. `createDurableEffectJournal` from
   * `@nifrajs/core/durable-execution` is the one this is built for; any implementation of the seam
   * works, and a memory-backed one is a test double, not a durable command. */
  readonly journal: CapabilityExecutionJournal
}

/**
 * Journal every capability effect on the routes below it, and declare the evidence that says so.
 *
 * A capability defined `idempotency: "durable"` requires `nifra.durable-command` evidence, and until
 * this adapter existed nothing in the framework produced it. The only way to satisfy the tier was to
 * write `assurance: ["nifra.durable-command"]` on the route - an assertion with nothing behind it,
 * wrong in both directions: a route that genuinely journals its effects but omits the string fails
 * `nifra check`, and a route that journals nothing but includes it passes.
 *
 * The evidence is a by-product here rather than a claim. Installing the adapter puts the journal on
 * the request, so `executeCapability` records intent before an effect runs and exactly one terminal
 * outcome after - which is what the tier is asking about. A call that passes its own `journal` still
 * uses that one.
 *
 *     const commands = durableCommand({ journal: createDurableEffectJournal({ store }) })
 *     const app = server().use(commands).post("/charge", { capabilities: ["billing.charge"] }, …)
 *
 * `beforeHandle` is order-scoped, like the auth plugins: routes registered before `.use(...)` are not
 * covered, and the `subsequent` scope on the evidence says the same thing to `nifra check`.
 *
 * Note what this does NOT claim. Response replay (`schema.idempotency`) is a different guarantee and
 * deliberately never proves this one: replaying a stored response after a crash mid-effect does not
 * make the effect exactly-once, and the journal is what survives the crash.
 */
export function durableCommand(options: DurableCommandOptions): IdentityPlugin {
  const journal = options.journal
  if (journal === null || typeof journal !== "object") {
    throw new TypeError("durableCommand: journal must be a CapabilityExecutionJournal")
  }
  for (const method of ["intent", "executing", "committed", "failed"] as const) {
    if (typeof journal[method] !== "function") {
      // Fail at wiring time. A journal missing a transition would otherwise surface as a mid-effect
      // TypeError on the first write in production, with the evidence already declared.
      throw new TypeError(`durableCommand: journal.${method} must be a function`)
    }
  }
  const plugin = defineIdentityPlugin("nifra:durable-command", (app) =>
    app.beforeHandle((c: object) => {
      attachCapabilityJournal(c, journal)
      return undefined
    }),
  )
  return withRouteAssurance(plugin, {
    id: NIFRA_ASSURANCE.DURABLE_COMMAND,
    source: "durable-command",
    scope: "subsequent",
  })
}

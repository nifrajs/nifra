---
"@nifrajs/middleware": minor
"@nifrajs/core": minor
---

A capability requiring durable idempotency has an adapter that satisfies it.

```ts
import { createDurableEffectJournal } from "@nifrajs/core/durable-execution"
import { durableCommand } from "@nifrajs/middleware"

const app = server()
  .use(durableCommand({ journal: createDurableEffectJournal({ store }) }))
  .post("/charge", { capabilities: ["billing.charge"] }, (c) =>
    executeCapability(c, "billing.charge", {}, () => gateway.charge(order)),
  )
```

A capability defined `idempotency: "durable"` requires `nifra.durable-command` evidence, and nothing
shipped produced it. The tier was reachable, but only by writing `assurance: ["nifra.durable-command"]`
on the route - an assertion with nothing behind it, and wrong in both directions: a route that
genuinely journals its effects but omits the string fails `nifra check`, and a route that journals
nothing but includes it passes. Every other assurance id has a shipped emitter; this one now does too.

The evidence is a by-product rather than a claim. Installing the adapter puts the journal on the
request, so `executeCapability` records intent before an effect runs and exactly one terminal outcome
after - which is what the tier is asking about. `executeCapability` resolves an explicitly passed
`journal` first, so existing call sites are untouched, and a journal missing a transition is refused at
wiring time rather than surfacing as a TypeError partway through a production effect.

`attachCapabilityJournal` and `capabilityJournalOf` are exported from `@nifrajs/core/capabilities` as
the seam the adapter uses.

Response replay is still not durable-command evidence, and that is deliberate: if the process dies
between the effect and storing its response there is nothing to replay, so replay cannot be what makes
an effect exactly-once. The journal survives that; only the journal clears the tier.

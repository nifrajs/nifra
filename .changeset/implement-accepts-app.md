---
"@nifrajs/core": minor
---

`implement(contract, handlers, app)` accepts a pre-configured app, so a contract-first backend can run
middleware. A route captures the server's `derive`/`decorate`/assurance chain at registration, so the
chain has to be on the app before its routes exist:

```ts
const app = implement(contract, handlers, server().use(auth).derive(sessionOf))
```

Handlers now receive `Context & Ctx` — the same shape an inline handler gets, so one graduates either
way unchanged — and any routes already on the app stay in the returned server's registry. This is also
what lets `nifra assure` prove a contract-first app rather than only classify it: the plugin that
installs the enforcement is what declares the evidence, and only a plugin installed before
registration is captured. The two-argument call is unchanged.

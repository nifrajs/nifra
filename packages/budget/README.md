# @nifrajs/budget

Compatibility import for the request-deadline mechanics owned by `@nifrajs/core/budget`. Existing
Nifra, Hono, and Fetch consumers can keep this import unchanged; new core consumers may use the
subpath directly. Both paths resolve to the same implementation and classes.

```ts
import {
  assertBudgetRemaining,
  createRequestBudget,
  withDeadlineHeader,
} from "@nifrajs/budget"

const budget = createRequestBudget({
  deadline: Date.now() + 2_000,
  signal: request.signal,
})

assertBudgetRemaining(budget, 100)
await fetch(url, {
  signal: budget.signal,
  headers: withDeadlineHeader(undefined, budget.child(50)),
})
```

The wire value is an absolute Unix epoch deadline. `remaining()` samples wall time once, then uses a
monotonic clock so NTP changes cannot extend or shorten admitted work. A budget does not choose retry,
provider, tenant, or money policy; it only answers how much time remains.

Nifra route handlers receive the same primitive as `c.budget`. `c.signal` remains the cancellation
signal and aborts at the effective server deadline.

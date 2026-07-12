# @nifrajs/budget

Portable request-deadline mechanics for Nifra, Hono, and any Fetch runtime.

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

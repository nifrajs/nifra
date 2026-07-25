---
"@nifrajs/cache": minor
"@nifrajs/jobs": minor
"@nifrajs/storage": minor
---

Cache, queue and storage operations can produce capability evidence.

```ts
import { useCapability } from "@nifrajs/core/capabilities"

const cache = createCache({ beacon: useCapability })
await cache.for(c).set(key, value)   // announces `cache.write`, and fails closed if undeclared
```

Static provenance answers what a MODULE can reach, so its evidence is as broad as the module holding
it. A call answers which ROUTE did what. That is the gap these close: the token is produced by the
operation rather than by a policy file asserting an import implies it.

`useCapability` is passed in rather than imported, so all three packages keep their zero dependencies -
a cache should not pull the server into a bundle that only wanted a cache. Nothing changes for existing
code: the unbound `cache.set(...)`, `job.enqueue(...)` and `adapter.put(...)` paths are untouched, and
`for(context)` without a configured beacon throws rather than handing back something that quietly
produces no evidence.

Storage takes a `withCapabilityBeacon(adapter, { beacon })` wrapper instead of an interface method,
because `StorageAdapter` is meant to be implemented outside the package and a new method would break
every adapter already written. `cache.wrap` announces read AND write, since a miss writes and which one
happens is not knowable before the call.

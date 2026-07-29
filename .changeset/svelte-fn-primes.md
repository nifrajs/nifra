---
"@nifrajs/web-svelte": patch
---

`useServerFn`'s store reports the current state to a late subscriber.

Svelte's `readable` runs its start function only on the FIRST subscription, and this one subscribed
without priming - so a store read after a call had already finished reported its initial value, idle,
for a call that succeeded. It hits a handle created at module scope, one shared through a Svelte
context, and any component that mounts after the call.

It now sets `store.snapshot()` before subscribing, matching `useFetcher` in this same package. The
other four adapters already read a snapshot on mount, so this was the one place where "is it pending"
gave a different answer from the shared state machine it exists to report.

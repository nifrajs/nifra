---
"@nifrajs/web": minor
---

Infinite queries now take part in the query cache like plain ones. `invalidateQueries` marks a matching infinite query stale, refetches its loaded pages when it is mounted, and keeps a fetch begun before the invalidation from publishing. `dehydrate` includes infinite queries in a new `infiniteQueries` field, and `hydrate` seeds them, including for a key not yet queried. Unmounted infinite queries are evicted after `gcTime` and past `max`, where before they were kept forever.

`createMutation`: an `onMutate` that throws now fails the mutation (state `error`, `onError` and `onSettled` run) instead of leaving it `pending`. An `onSuccess` that throws after the write still rejects the call, but the state stays `success` and `onError` is not called, so an optimistic rollback no longer undoes a write the server kept.

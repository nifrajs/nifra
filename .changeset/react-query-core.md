---
"@nifrajs/web-react": minor
"@nifrajs/web": minor
---

Add a full React Query core on `@nifrajs/web-react/query` — `useQuery` (now with `enabled`/`staleTime`),
`useMutation`, `useInfiniteQuery`, `useQueryClient`, `QueryClientProvider`, and the SSR
`HydrationBoundary` — a drop-in for the TanStack Query surface, backed by an expanded agnostic engine in
`@nifrajs/web`.

The engine (`createQueryClient`) gains imperative cache ops (`getQueryData`/`setQueryData` for optimistic
updates, `prefetchQuery`), per-query `staleTime`, SSR `dehydrate`/`hydrate`, and paged (`infiniteQuery`)
support; plus a standalone `createMutation` state machine (single-flight, TanStack callback order). All
logic lives in the injected-clock, framework-free engine so it's deterministically tested; the React
bindings are thin `useSyncExternalStore` wrappers. A hook without a `QueryClientProvider` uses a
client-side singleton (SSR-idle); with a `HydrationBoundary`-fed provider client, queries render their
server-seeded data during SSR with no hydration flash.

# @nifrajs/graphql

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.

## 5.0.0

### Minor Changes

- adb446f: Every document limit runs before `validate()`. The new `maxFieldOverlaps` (default 2,000) bounds the pairs of fields sharing a response name in one selection set, counted through inline fragments and fragment spreads; graphql-js's overlap validation compares every such pair, so a few kilobytes of repeated fields within the depth and complexity limits no longer hold the event loop for seconds. A fragment no operation uses is refused before validation too. Over a WebSocket, a `subscribe` frame sent before `connection_init` is admitted goes straight to graphql-ws, which closes the socket with `4401` without reading the query: no validation errors, and so no field-name suggestions, reach an unauthenticated socket.
- c07a8a4: A GraphQL POST whose `Content-Type` is not `application/json` (or another `+json` type) answers `415` before its body is read. Before, an urlencoded, multipart or `text/plain` body was parsed and executed, so a cross-site HTML form could post a mutation with the visitor's cookies. Clients that send JSON without a `Content-Type` header must now set it.
- 6b1f6b0: `mountGraphql({ subscriptions: true })` admits a socket only when `authorize` accepts its upgrade request, and applies the HTTP query limits (`maxQueryBytes`, `maxDepth`, `executionTimeoutMs` and the rest) to operations over it. Before, `subscriptions: true` reused only `schema` and `context`, so a socket could run queries and mutations that HTTP refused. When `authorize` is set and `subscriptions` is an options object with neither `authorize` nor `onConnect`, `mountGraphql` throws instead of admitting every socket. `graphqlWebSocket` takes a new `authorize(request)` option, checked before `onConnect`.
- 09bce56: Each `graphqlWebSocket` operation runs with an abort signal that resolvers read through graphql's `info.getAbortSignal()`. It is aborted when the operation passes `executionTimeoutMs`, when the client sends `complete`, and when the socket closes. A subscription source that a resolver still produces after that abort is returned, so its cleanup runs.

### Patch Changes

- e5a12ef: The `authorize` option's documentation now gives its real place in a request: after the origin check and before the body is read or parsed, with a CORS preflight skipping it. It said the hook ran after the body parsed.
- d530984: Over HTTP, `executionTimeoutMs` now aborts the execution's signal, which resolvers read through `info.getAbortSignal()`, instead of only answering 504 while the resolvers kept running. An aborted request aborts it too. The WebSocket transport already did this.
- c44c5a8: A WebSocket subscription whose source arrives after `executionTimeoutMs` has its stream returned, so the source's cleanup runs. Before, the client got the timeout error but the late source stayed open.
- 7775c2b: Recheck current route authentication, authorization and prerequisite hooks before idempotent replay,
  without repeating the handler, effect ledger or stored response transformations. Preserve stored
  status, safe headers and the replay marker after admission.

  Enforce typed SSE event limits in UTF-8 bytes before dispatch for complete and fragmented frames,
  with bounded, linear fragment accounting independent of chunk boundaries.

  Bound the in-memory GraphQL pubsub subscriber queue to 1024 events by default. Overloaded subscribers
  detach and fail with `GraphqlPubSubOverflowError`; configure `maxQueuedEvents` or explicit
  `drop-oldest`/`drop-newest` policies when needed. Returning or throwing into an iterator clears queued
  events and ends delivery.

- Updated dependencies [a0a02f4]
- Updated dependencies [0aed425]
- Updated dependencies [eaf030b]
- Updated dependencies [7de0397]
- Updated dependencies [4199ff3]
- Updated dependencies [90d9ee6]
- Updated dependencies [364a234]
- Updated dependencies [c06cba5]
- Updated dependencies [f4d3852]
- Updated dependencies [4a82ae0]
- Updated dependencies [0ff867a]
- Updated dependencies [e7391bf]
- Updated dependencies [0b80a59]
- Updated dependencies [c64db12]
- Updated dependencies [3753104]
- Updated dependencies [4b3b1fa]
- Updated dependencies [3562557]
- Updated dependencies [53087f3]
- Updated dependencies [2def6c7]
- Updated dependencies [b5b5bc3]
- Updated dependencies [22e1777]
- Updated dependencies [3a483cd]
- Updated dependencies [35f52c7]
- Updated dependencies [343cb81]
- Updated dependencies [d91fd44]
- Updated dependencies [b13e071]
- Updated dependencies [077657f]
- Updated dependencies [a5963cb]
- Updated dependencies [05aac0e]
- Updated dependencies [1a6616f]
- Updated dependencies [7775c2b]
- Updated dependencies [846e2f6]
- Updated dependencies [aadd9fc]
- Updated dependencies [ea16748]
- Updated dependencies [fc0284a]
- Updated dependencies [5b22f4d]
- Updated dependencies [1b94593]
- Updated dependencies [9f58295]
- Updated dependencies [b9608ac]
- Updated dependencies [7a165de]
- Updated dependencies [4064f36]
- Updated dependencies [48aad8c]
- Updated dependencies [41050ed]
- Updated dependencies [fc837cb]
- Updated dependencies [b80ce77]
- Updated dependencies [9b1acc9]
- Updated dependencies [740109f]
- Updated dependencies [e0a25fe]
- Updated dependencies [3630b6e]
- Updated dependencies [1290c6d]
- Updated dependencies [d0a7d58]
  - @nifrajs/core@5.0.0

## 4.0.2

## 4.0.1

## 4.0.0

### Patch Changes

- dab0f1f: Document limits measure each fragment once and reuse the result at every spread, so measuring a document takes time linear in its length however often it spreads its fragments.
- 99e6687: `graphqlWebSocket` frees an operation's `maxSubscriptions` slot when the server completes it or ends it with an error, not only when the client sends `complete`. An `onConnect` that throws refuses the connection with 4403, as returning `false` does. An operation that runs past `executionTimeoutMs` ends with an error result and leaves the connection open, and any other failure in a frame closes that one socket with 4500.
- Updated dependencies [dde125b]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [aad6297]
- Updated dependencies [dad0d41]
- Updated dependencies [538adc2]
- Updated dependencies [f47edd1]
- Updated dependencies [df9530a]
- Updated dependencies [3e6973f]
- Updated dependencies [25e8edf]
- Updated dependencies [2b5e5fc]
- Updated dependencies [3b090de]
- Updated dependencies [da7d792]
- Updated dependencies [612a296]
- Updated dependencies [fb14dfa]
- Updated dependencies [8ae97f6]
- Updated dependencies [4af6f39]
- Updated dependencies [ca8b50d]
- Updated dependencies [b00a889]
- Updated dependencies [b53d64f]
- Updated dependencies [66fd712]
- Updated dependencies [9c3d524]
- Updated dependencies [738e7a1]
- Updated dependencies [4801cac]
- Updated dependencies [1b2d53a]
- Updated dependencies [25fe13d]
- Updated dependencies [0852290]
- Updated dependencies [0589dbe]
- Updated dependencies [2e2d8c0]
- Updated dependencies [856f5ce]
- Updated dependencies [18aa5aa]
- Updated dependencies [cfd86b3]
- Updated dependencies [8ff96c9]
- Updated dependencies [4c46199]
- Updated dependencies [eef4932]
- Updated dependencies [6de8686]
- Updated dependencies [d7892ea]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [6d20355]
- Updated dependencies [6907cbe]
- Updated dependencies [b64c3ee]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [a158b74]
- Updated dependencies [ff25d68]
  - @nifrajs/core@4.0.0

## 3.5.0

### Patch Changes

- d5b7c22: Harden request boundaries, error handling, resource limits, signing, and cross-runtime adapters for safer production releases.

## 3.4.0

## 3.3.0

## 3.2.0

### Minor Changes

- 36fe66b: Add `@nifrajs/graphql`: mount a GraphQL endpoint on a nifra app. A spec-compliant GraphQL-over-HTTP
  handler (`respondGraphql`) you mount at `POST /graphql`, `graphql-transport-ws` subscriptions over
  nifra's native WebSocket lane (`graphqlWebSocket`), an in-memory subscription source (`createPubSub`)
  you can swap for a durable bus, and a `mountGraphql` one-call helper that wires POST/GET (and,
  optionally, subscriptions) while injecting the nifra route context into resolvers. Executes with the
  `graphql` package's own `parse`/`validate`/`execute`/`subscribe`; the request body reuses core's single
  bounded, prototype-guarded trust boundary. `graphql` is a required peer, `graphql-ws` an optional one.

# @nifrajs/graphql

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

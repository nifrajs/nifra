---
"@nifrajs/core": minor
"@nifrajs/client": major
---

WebSocket routes join the end-to-end type chain, and client failures discriminate by status.

- `app.ws()` now enters the type-level registry (pseudo-method `"WS"`). The typed client grows a
  `.ws()` handle per WS route: `send()` accepts the route's `messageSchema` input type, received
  frames are typed from the new `sendSchema` option (an outbound, type-level contract), and both
  fall back to `unknown` when undeclared. The handle queues sends until open, exposes
  `messages()` (async iteration), `onMessage()`, `opened`, `close()`, and `raw`. Params, path
  literals, and `client<App>` inference work exactly like HTTP routes. Calling `.ws()` on the
  in-process client throws with an explanation (an in-process app has no socket to upgrade).
- The client's `Result` failure union is now DISCRIMINATED BY STATUS when a route declares an
  `errors` record: `res.status === 404` narrows `res.data` to the declared 404 body. Undeclared
  statuses (and `0` for transport errors) fall into a fallback arm whose `data` is `unknown`;
  routes with no `errors` contract keep the single `unknown` failure arm. Contract operations'
  non-2xx `responses` discriminate the same way. Breaking for type-level consumers only: code that
  read the failure `data` after checking just `ok` must also narrow on `status` (the runtime shape
  is unchanged).
- `testClient(app, { validateResponses: true })` asserts every JSON response against the route's
  declared contract - `response` for 2xx, `errors[status]` for declared failures - and throws a
  `ResponseContractViolation` on mismatch, so a handler whose real output drifts from its schema
  fails the test instead of passing silently. Off by default; statuses with no declared schema,
  non-JSON bodies, and 204/205/HEAD pass through unchecked.

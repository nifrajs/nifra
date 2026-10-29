# @nifrajs/auth

## 5.9.0

### Minor Changes

- 9942748: `createSessions({ identity })` names the data keys that say who the visitor is, such as a user id, an organization or a role. The session cookie's tag then changes only when one of them does, in either mode, so `@nifrajs/web` keep-alive keeps the pages it holds across a commit that writes other data, a cart say. Unset, every key counts. Once `identity` is set, a cookie-mode cookie carries the tag in its signed payload, and an earlier version still reads it.

### Patch Changes

- 0445564: Trailing trims, base64 padding strips and a few parsers run in time linear in their input. `parseByteRange` reads the range set after `bytes=` without its two quantifiers trading spaces, the srcset reader in server components, the keep-alive `:has(> ...)` check, the OpenAPI `$defs` reference reader and the build secret scan's credential-URL check no longer backtrack over a long run of one character, and a trailing run of slashes, dashes, commas, semicolons, underscores, newlines or `=` padding is stripped without retrying the run at every position.
- 9942748: A store-mode session cookie changes whenever the session's data does. It carries the session id with a tag that a commit renews only when the data changed, so a commit with the same data writes the same cookie and a sign-in, an account switch or `clear()` under a kept session id writes a new one. A response that changes who is signed in now shows it, and `@nifrajs/web` keep-alive drops the pages kept for the previous visitor even when the app does not regenerate the id. A cookie from an earlier version still loads and keeps its form until the data changes; a cookie with a tag reads as signed out on an earlier version.

## 5.8.0

No changes in this release.

## 5.7.0

### Minor Changes

- b141cf4: `csrf()` takes `exempt`: route patterns whose requests skip the Origin check, for a route no browser
  calls that verifies its sender another way, such as a signed payment webhook arriving with no
  `Origin`. Patterns are written as routes are (`/inbound/:vendor`) and matched against the path the
  server routes, so any other path stays checked.

## 5.6.0

### Patch Changes

- 2eabd83: `etag()` keeps an `ETag` the handler already set and answers `If-None-Match` against it, instead of replacing an app-managed version with a content hash. `etag()`, `conditionalResponse()` and `rangeResponse()` read an `If-None-Match` list with a comma inside a quoted ETag as one tag.
  
  `env.number()` reads plain decimal text only (`0x10`, `1e3` and `Infinity` are refused), and `env.number()` and `env.port()` treat a value of only spaces as unset, so a `default` applies. `env.boolean({ default })` returns the default for a variable that is set but empty.
  
  `serverFunctions()` mounts a second module under a namespace already in use, so `admin/todos.fn.ts` and `user/todos.fn.ts` are both served; an export name both modules use fails at boot as a duplicate route. Before, the second module was skipped and its functions answered 404. A module no app uses any more is not kept in memory by its namespace. The client build fails on a `*.fn.ts` file whose name `serverFunctions()` would refuse as a namespace, naming the file.
  
  `requireSession()` documents that it passes any non-empty session, which a visitor can have before signing in; `requireUser()` is the signed-in guard.

## 5.5.1

No changes in this release.

## 5.5.0

### Security and migration

- 8debc4c: Session managers refuse eventually consistent stores, including `KVSessionStore`. Cached session records and missing revocation markers could restore a logged-out session and let it keep renewing. Existing KV-backed session applications must migrate to a strongly consistent shared `SessionStore`; the legacy KV adapter remains exported for reading and migration. Custom adapters may declare `consistency: "strong"`; omitting it asserts the same required contract.

### Minor Changes

- 662afb0: A store-backed session that `regenerate()` rotates while a logout of it runs can no longer come out of that race as a live session. A rotated ID is now the session's original ID, `~`, and a new random part, and logout with any generation's cookie revokes every generation, so the rotating request either sends no cookie or sends one that loads as an empty session. `SessionStore` gains an optional `rotate(previousId, nextId, record, marker)` that moves an existing, unrevoked record to its new ID in one atomic step and resolves whether it did. `MemorySessionStore` implements it, and drops every generation's record when one is revoked, so evicting a revocation marker cannot bring them back. A store without `rotate` keeps working: rotation writes an `<id>.rotated` marker beside the `<id>.revoked` one, and the store must keep both until their `expiresAt`. A load reads the rotation marker, and for a rotated ID the original ID's revocation marker, in parallel with the record.
- f6a71bc: `SessionStore` gains an optional `replace(id, record)` method that overwrites `id` only while it still holds a record and resolves whether it wrote. When a store implements it, a loaded session renews through `replace` instead of `set`, so a logout that lands between the commit's checks and its write wins, even once the logout's revocation marker is gone. Implement it as one atomic step that also sets the new expiry, such as Redis `SET key value XX PXAT <record.expiresAt>` (a bare `XX` drops the key's TTL) or a SQL `UPDATE ... WHERE id = ?` that reports the rows it changed. `MemorySessionStore` implements it. A store without it works as before and must keep each revocation marker until its `expiresAt`, as `KVSessionStore` does: Workers KV has no conditional write.

### Patch Changes

- b747034: A store-backed session renewal on a store without `replace()` can no longer undo a logout. When the record it renews expires while the write is in flight, a logout in that gap finds nothing to revoke; the renewal now deletes what it wrote and sends no cookie instead of restoring the session.
- 32c701e: In store mode, `destroy(c)` called with a cookie that a `regenerate()` rotation has already replaced ends the whole session family only within 60 seconds of that rotation, while the rotating response may still be on its way to the browser. After that it drops only the replaced ID, so a pre-login cookie kept elsewhere can no longer end the session that replaced it. A cookie naming the live session, and `destroy(c, session)` with a loaded session, end the family as before.
- e14bc02: A store-backed session that a request loaded before a logout or rotation can no longer be written back by that request's later `commit()`. A loaded session now commits only while its record still exists and no revocation marker names it, so the guarantee no longer depends on the logout's marker outliving the request: other revocations pushing that marker out of a bounded `MemorySessionStore` cannot bring the session back, and neither can a commit that reads between a logout's marker write and its delete. The commit reads the record and the marker in parallel, so it waits on no extra store round trip. A `MemorySessionStore`, which can evict markers, also makes the renewal itself conditional: it writes only while the record still exists, in one step with the check, so a logout that lands after the commit's reads still wins.

## 5.4.0

No changes in this release.

## 5.3.0

### Patch Changes

- Refuse renewal or rotation of a loaded session after its original expiry, including when a KV revocation marker has expired. Rejected commits keep their previous expiry so retrying cannot restore a logged-out session.

- a32b33e: A store-mode session ended by `destroy` or rotated by `regenerate` stays ended. A request that loaded the session before the logout and committed after it (a rolling renewal, a slow handler) used to write the record back, so a copy of the cookie taken before logout worked again. Logout and rotation now also write a revocation marker under `<id>.revoked`, every load checks it, and a commit of a revoked session removes its write and sets no cookie, so it cannot replace a session the browser obtained since. A custom `SessionStore` must accept that key like any other; loading a store-mode session reads two keys in parallel.
- 88f91aa: `MemorySessionStore` keeps revocation markers apart from sessions, each bounded by `max`, so sessions written after a logout can no longer evict its marker. Once `max` newer sessions had been written, a request that loaded the session before the logout and committed after it brought the logged-out session back and re-issued its cookie. Markers also no longer take capacity from live sessions. The `SessionStore` contract now says a custom store must keep a marker until its `expiresAt`.
- 55b9a41: `destroy(c, session)` empties and detaches the session object it is passed. Committing that object later in the same request now starts a new session holding only what was set after the call. In store mode, that commit used to vanish against the revocation marker, so a flash message set after logout was lost without an error. In cookie mode, it signed the logged-out data, user id included, into a fresh cookie. The 5.3.0 upgrade notes say so.

## 5.2.1

No changes in this release.

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.

## 5.1.0

### Patch Changes

- efd2102: `createSessions` no longer accepts a session cookie signed in the pre-5.0 form (without the cookie name in the signature) unless you pass the new `acceptLegacyCookies: true`. Before, that fallback was always on, so any value the app signed with the session secret through `@nifrajs/core`'s `signValue` that parsed as a cookie-mode session (a signed preference cookie built from a form field, say) read as a session of the attacker's choosing, with an expiry of its own. A cookie-mode session's expiry is now also capped at `now + maxAge` on load, so no cookie can name a longer life. Migration: if you are upgrading from 4.x, or from 5.0 with sessions that have not been committed since, set `acceptLegacyCookies: true` to keep those users signed in, and remove it once one `maxAge` (7 days by default) has passed; each such session is re-signed in the current form on its next commit. Without it, those users are signed out once.

## 5.0.0

### Minor Changes

- 7a169c9: The session guards take `unauthenticated: { status, body, headers }` to set the response they deny a missing session with, in place of the default `401` JSON: `requireSession` and `requireUser` in `@nifrajs/auth`, `requireSession`, `requirePrincipal` and `authed` in `@nifrajs/better-auth`, and `requireAuthUser` in `@nifrajs/authjs`. The status must be 400-599, and a guard given both `redirectTo` and `unauthenticated` throws. `UnauthenticatedResponse` is exported from each package.

### Patch Changes

- 2e331b1: Session cookies are now signed together with their cookie name, so when two session managers share a secret, a cookie issued by one no longer verifies as the other's. Cookies signed by earlier versions still load and are re-signed on their next commit, so upgrading signs no one out.
- 8606fa4: `csrf()` (middleware and auth) accepts a same-origin HTML form POST sent under `Referrer-Policy: no-referrer`, which `securityHeaders()` sets by default. Such a form arrives with `Origin: null`, and every one was refused with 403. A request with `Origin: null` now passes only when the browser's own `Sec-Fetch-Site` header says `same-origin`, and only in the default same-origin mode; an explicit `origins` allowlist still refuses it.
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

- 6daaa05: Each guard you build is its own plugin: `bearer()`, `basicAuth()`, `jwt()`, `ipRestriction()`, `rateLimit()`, `csrf()` and `bodyLimit()`. A second, stricter one before later routes or inside a `group()` applies alongside the first. The same instance passed to `use()` twice still applies once.
- 8e52704: fix(middleware, auth): CSRF behind TLS proxies, CORS caching, and token parsing

  The CSRF same-origin default in `csrf()` from both packages accepts an `https:` Origin on an `http:`
  request URL, which is what a TLS-terminating proxy presents. A downgrade or another host is still
  rejected.

  `cors()` with an allowlist or predicate sends `Vary: Origin` on every response, including ones that
  carry no `Access-Control-Allow-Origin`. An existing `Origin` member is not repeated, and `Vary: *` is
  kept as it is.

  `jwt()` and `verifyCsrfToken()` accept only canonical base64url signatures. `jwt()` and `bearer()`
  match the `Bearer` auth-scheme case-insensitively.

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

### Patch Changes

- 7551709: Harden runtime boundaries and defaults: clean up subprocess abort listeners, support short Cloudflare
  KV sessions, bound and incrementally sweep the default memory cache, make image reads and cancellation
  safe, emit content-derived image validators, require trusted forwarded hosts, avoid caching dynamic SSR
  metadata, and reject invalid upload or image limits.

## 3.1.0

## 3.0.0

### Minor Changes

- 99fc683: A thrown `status(...)` now costs close to what a returned one costs, and the guards throw one.

  `status(...)` is meant to be **returned** - from a `beforeHandle`, from a `derive`, from the handler. The one place a return cannot work is a helper called for effect: `requireSession(c)` decides the request is over from inside a call the handler makes, and only unwinding gets out of a half-finished handler. That is the whole remaining use of `throw`, and it now runs on the same lane as the return:

  - The lifecycle error path is synchronous again. It was `async`, so a thrown `status(...)` - which needs no `await` at all - still allocated a promise and resumed a microtask later. The `onError` hook loop moved to its own async method, so only routes that registered a hook pay for one.
  - The two remaining sites that turned a thrown `status(...)` into a `Response` before rendering it (the bare and contextless fast paths) now render it as the plain data it is, through the request's own finalizer.
  - `requireSession` / `requireUser` / `requireAuthorization` throw a `status(...)` render instead of building a `Response`. The bytes on the wire are unchanged - a 401 JSON envelope, or a 302 with a `location` - and on Node they now carry a `content-length` instead of being drained back out as a stream.

  **Behavior change:** what the guards throw is a `status(...)` render, not a `Response`. Code that catches a guard and tests `err instanceof Response` needs to stop doing that; nifra itself treats the two identically as control flow, so a guard thrown through a route behaves exactly as before.

  Measured on the Linux rig (4 server cores, 50 connections, medians of 5 x 2s; a `derive` that rejects, returning vs throwing the same `status(401, ...)`). Only within-runtime deltas are readable - the host was under other load, and the return arm is included in both columns as the control:

  | runtime | return | throw, before | throw, after |
  | ------- | ------ | ------------- | ------------ |
  | node    | 85904  | 74471         | 80136        |
  | deno    | 139477 | 85970         | 90355        |

  On Node a throw now lands within the run's own spread of a return. On Deno it does not: a throw still costs ~35%, and it costs the same whether the thrown value is a `status(...)` render or a `Response` - so what remains there is the unwind itself, not the rendering.

  That remainder is the runtime's, not the framework's. The same arms with no framework at all - a bare `Deno.serve` / `Bun.serve` / `node:http` handler answering identical bytes, one returning its payload and one throwing it - reproduce it, in CPU-microseconds per request:

  |      | return | throw | throw across await |
  | ---- | ------ | ----- | ------------------ |
  | node | 49.35  | +3.85 | +2.85              |
  | bun  | 22.55  | +1.83 | +3.99              |
  | deno | 18.89  | +7.62 | +11.03             |

  Against that, nifra's own rejection arms cost +3.35 (node), +3.41 (bun), +15.59 (deno). On node and bun the framework's entire remaining throw penalty _is_ the runtime's throw. On deno the runtime's throw-across-await alone accounts for ~70% of it, and the percentage reads worse than the others only because deno's baseline request is the cheapest of the three. Two candidate explanations were tested and ruled out: `Error.stackTraceLimit = 0` changes nothing (so it is not stack capture), and throwing three frames below the handler is no cheaper (so it is not proximity to the runtime boundary).

### Patch Changes

- f0fd370: The same-origin check behind `redirect()` and the guards' `redirectTo` now rejects the paths a URL parser resolves onto another origin, and lives in one place.

  A leading `/` that is not `//` is not sufficient to keep a destination on this origin. Under a special scheme a backslash parses as a path separator, and tab, CR and LF are stripped from the input before parsing, so `/\evil.example` and `/<TAB>/evil.example` both pass a `//` test and then resolve to the host `evil.example` - an open redirect reachable from any unvalidated `?next=` parameter. Both forms are now refused: `redirect()` throws as it already did for `//host`, and an auth guard falls back to its configured destination instead of honouring the value.

  New export `isSameOriginPath` from `@nifrajs/core/server`, which is the single implementation the three gates now share - a security predicate kept in three copies is three chances for one of them to be hardened alone. It answers about a path, so an absolute URL is false even when it names the current origin: the point of the gate is that the value never got to name a host at all.

  A percent-encoded backslash (`/%5Cevil.example`) is still a same-origin path, because that is what it resolves to.

- Updated dependencies [f3d2a35]
- Updated dependencies [6e43c15]
- Updated dependencies [f0fd370]
- Updated dependencies [86a555b]
- Updated dependencies [8c5f4cf]
- Updated dependencies [f0fd370]
- Updated dependencies [381bbf3]
- Updated dependencies [36801ae]
- Updated dependencies [9acadba]
- Updated dependencies [99fc683]
- Updated dependencies [73d894d]
  - @nifrajs/core@3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

### Minor Changes

- dbc0b79: Signing-secret rotation. `signValue`/`unsignValue` (and the new `CookieSecret` type), session `secret`, and CSRF `secret` now also accept a rotation list: the first secret signs, any listed secret verifies, so keys rotate without invalidating live cookies, sessions, or CSRF tokens. Every listed secret must meet the 32-byte floor and an empty list throws; the single-secret path is unchanged.

### Patch Changes

- 023891a: `destroy(c)` called without a `Session` object now revokes the stored record addressed by the request's
  signed session cookie, instead of only clearing the cookie. A logout handler that had not first loaded
  the session cleared the browser's copy while the server-side record stayed valid for its full TTL, so a
  copy of the cookie taken before logout still authenticated. The id comes from the signed cookie, so
  only a session the caller actually presented can be deleted.

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

### Patch Changes

- f7d68e8: Numeric limit options (body/payload byte caps, TTLs, cache sizes, concurrency, ISR revalidate windows) are now validated at construction and throw a `RangeError` on non-finite or out-of-range values instead of silently disabling the bound - a `NaN` cap previously made `size > max` comparisons fail open. JWT `requiredClaims` now checks own properties only, so inherited names like `toString` no longer satisfy a required claim. `@nifrajs/mcp-db` gates multi-statement input with a real tokenizer, bounds `run_query` materialization to `maxRows + 1` via a wrapping subquery, and skips SQLite planner pseudo-nodes when verifying the table allowlist. `nifra scaffold` refuses to write through symlinked route directories.

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

## 2.3.0

## 2.2.0

## 2.1.0

## 2.0.0

### Patch Changes

- ade0c7a: Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
  contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
  package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
  eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.
- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.0

### Patch Changes

- Updated dependencies [f1f0e18]
- Updated dependencies [3efb7cd]
- Updated dependencies [de9675b]
  - @nifrajs/core@1.0.0

## 1.0.0-beta.4

### Patch Changes

- @nifrajs/core@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/core@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- @nifrajs/core@0.1.0-beta.2

# @nifrajs/testing

Testing helpers for nifra apps. [`@nifrajs/client`](../client)'s **`testClient`** is already the typed,
no-network in-process request client (nifra's supertest / `inject`). This package adds what it doesn't: a
**cookie jar** and a **cookie-persisting `testSession`**, so a login → authenticated-request flow tests as
easily as a single request.

```ts
import { testSession } from "@nifrajs/testing"
import { app } from "../src/app"

const { client, cookies } = testSession<typeof app>(app)

await client.auth.login.post({ email, password }) // Set-Cookie captured into the jar
const me = await client.me.get()                   // Cookie sent automatically
expect(me.ok && me.data.id).toBeDefined()
expect(cookies.get("sid")).toBeDefined()           // inspect the jar

await client.auth.logout.post()                    // a Max-Age=0 Set-Cookie clears it
expect(cookies.get("sid")).toBeUndefined()
```

Same in-process client as `testClient` — the app's own `fetch`, no server/port/network, the full real
lifecycle (validation, middleware, contracts, auth) and end-to-end types from `App`. The only addition is
that every call carries and captures cookies via a shared jar.

## API

- `testSession<App>(app, { origin?, cookies? })` → `{ client: Treaty<App>, cookies: CookieJar }`.
- `cookieJar()` → `CookieJar` — `header()` · `applyTo(headers)` · `store(response)` · `set` · `get` · `clear` · `size`.
  Honours removal (`Max-Age=0` / past `Expires`); other cookie attributes are ignored (in-process, same-origin).

For a **stateless** request (no cookies), use `testClient` from `@nifrajs/client` directly.

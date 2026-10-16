/** The /play examples. The route server-renders the first one and the island swaps between them, so
 * both read this one list and the first paint matches the first run. In `shows` and `tryThis`,
 * backticks mark inline code. */
export interface PlaygroundPreset {
  readonly id: string
  readonly label: string
  /** What the example demonstrates. */
  readonly shows: string
  /** One edit worth making next. */
  readonly tryThis: string
  readonly code: string
  /** The requests.json the example sends: `{ method?, path, headers?, body?, label? }[]`. */
  readonly requests: string
}

/** The example /play opens on. */
export const PLAYGROUND_FIRST: PlaygroundPreset = {
  id: "routes",
  label: "Routes",
  shows:
    "Each `.get()` adds a route. A `:name` segment arrives on `c.params`, and a returned object is sent as JSON.",
  tryThis: "Change `/hello/world` in requests.json to your own name.",
  code: `// server, t, and status are in scope. Return the app.
const app = server()
  .get("/hello/:name", (c) => ({ hello: c.params.name }))
  .get(
    "/add",
    { query: t.query({ a: t.number(), b: t.number() }) },
    (c) => ({ sum: c.query.a + c.query.b }),
  )

return app`,
  requests: `[
  {
    "path": "/hello/world",
    "label": "c.params.name is read from the URL"
  },
  {
    "path": "/add?a=2&b=3",
    "label": "t.query parses a and b into numbers"
  }
]`,
}

export const PLAYGROUND_PRESETS: readonly PlaygroundPreset[] = [
  PLAYGROUND_FIRST,
  {
    id: "validation",
    label: "Validation",
    shows:
      "The route declares its body with `t`. A request that does not match gets a 422 listing every issue, and the handler never runs.",
    tryThis: "Make `age` a number in the second request and it passes.",
    code: `// The schema is checked before the handler runs.
const User = t.object({
  name: t.string({ minLength: 1 }),
  age: t.number(),
})

const app = server().post("/users", { body: User }, (c) => ({
  id: crypto.randomUUID(),
  ...c.body,
}))

return app`,
    requests: `[
  {
    "method": "POST",
    "path": "/users",
    "body": { "name": "Ada", "age": 36 },
    "label": "Matches the schema, so the handler runs"
  },
  {
    "method": "POST",
    "path": "/users",
    "body": { "name": "", "age": "36" },
    "label": "Empty name, string age: 422, no handler"
  }
]`,
  },
  {
    id: "status",
    label: "Status codes",
    shows:
      "A returned value is a 200. `status(code, body)` sends any other status, and a `Response` passes through untouched.",
    tryThis: 'Add a user with id `"2"` to `users` and the 404 becomes a 200.',
    code: `// A value is a 200. status() sets any other code.
const users = { "1": { id: "1", name: "Ada" } }

const app = server()
  .get("/users/:id", (c) =>
    users[c.params.id] ?? status(404, { error: "no_such_user" }),
  )
  .get("/teapot", () =>
    new Response("short and stout", { status: 418 }),
  )

return app`,
    requests: `[
  {
    "path": "/users/1",
    "label": "Found: the object is sent as JSON"
  },
  {
    "path": "/users/2",
    "label": "Missing: status(404, ...) sets the code"
  },
  {
    "path": "/teapot",
    "label": "A raw Response is sent as-is"
  },
  {
    "path": "/nope",
    "label": "No route matches: Nifra answers 404"
  }
]`,
  },
  {
    id: "middleware",
    label: "Middleware",
    shows:
      "`.derive()` runs before every route and adds what it returns to `c`. Here it turns a bearer token into `c.user`.",
    tryThis: "Change the token in the third request and `/me` answers 401.",
    code: `// derive() runs first. What it returns is added to c.
const TOKEN = "Bearer demo-token"

const app = server()
  .derive((c) => ({
    user: c.request.headers.get("authorization") === TOKEN
      ? { id: "u_1", name: "Ada" }
      : null,
  }))
  .get("/public", () => ({ open: true }))
  .get("/me", (c) =>
    c.user ?? status(401, { error: "sign_in_required" }),
  )

return app`,
    requests: `[
  {
    "path": "/public",
    "label": "No token needed"
  },
  {
    "path": "/me",
    "label": "No token, so c.user is null: 401"
  },
  {
    "path": "/me",
    "headers": { "authorization": "Bearer demo-token" },
    "label": "Valid token: c.user is set"
  }
]`,
  },
]

/** Split prose on backticks into text and inline-code runs, so the server and the island render the
 * same markup without either one parsing HTML. */
export function codeRuns(
  text: string,
): ReadonlyArray<{ readonly code: boolean; readonly text: string }> {
  return text
    .split("`")
    .map((part, index) => ({ code: index % 2 === 1, text: part }))
    .filter((run) => run.text !== "")
}

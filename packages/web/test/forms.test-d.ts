/**
 * Type-level tests for `@nifrajs/web/forms` - verified by `tsc --noEmit`. Each `@ts-expect-error` FAILS
 * the build if the error it expects is absent: if a bad field name or path ever stops being caught, this
 * breaks. A real `server()` builds the `App` type so we exercise the genuine route registry.
 */
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import { formFor } from "../src/forms.ts"

const app = server()
  .post("/todos", { body: t.object({ text: t.string(), count: t.integer() }) }, () => ({
    ok: true,
  }))
  .get("/reports", () => ({ ok: true }))
  .post("/users/:id", { body: t.object({ name: t.string() }) }, () => ({ ok: true }))
type App = typeof app

const f = formFor<App>()("/todos") // method defaults to "post"

// Valid field names compile.
f.field("text")
f.field("count")
f.field("text", { id: "text", placeholder: "new todo" })

// @ts-expect-error - "txet" is not a field on the /todos body
f.field("txet")

const fd = new FormData()
f.read(fd, "text")
f.readAll(fd, "count")

// @ts-expect-error - "userId" is an orphan read (not in the schema)
f.read(fd, "userId")

// @ts-expect-error - "/nope" is not a route the app declares
formFor<App>()("/nope")

// The handle's action and method are the route's own.
export const action: string = f.action
export const method: "post" = f.method

// @ts-expect-error - /todos declares POST only, so a form for it cannot use "delete"
formFor<App>()("/todos", "delete")

// A route with no POST handler has no default method: a form for it names one.
// @ts-expect-error - /reports declares GET only, so the method cannot default to "post"
formFor<App>()("/reports")
export const reportMethod: "get" = formFor<App>()("/reports", "get").method

// A path with params takes them, so the action is a URL the browser can submit to.
export const userAction: string = formFor<App>()("/users/:id", { id: "7" }).action
export const userMethod: "post" = formFor<App>()("/users/:id", "post", { id: "7" }).method
// @ts-expect-error - /users/:id needs its id
formFor<App>()("/users/:id")
// @ts-expect-error - "name" is not a param of /users/:id
formFor<App>()("/users/:id", { name: "x" })

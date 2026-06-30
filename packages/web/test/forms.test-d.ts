/**
 * Type-level tests for `@nifrajs/web/forms` — verified by `tsc --noEmit`. Each `@ts-expect-error` FAILS
 * the build if the error it expects is absent: if a bad field name or path ever stops being caught, this
 * breaks. A real `server()` builds the `App` type so we exercise the genuine route registry.
 */
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import { formFor } from "../src/forms.ts"

const app = server().post(
  "/todos",
  { body: t.object({ text: t.string(), count: t.integer() }) },
  () => ({ ok: true }),
)
type App = typeof app

const f = formFor<App, "/todos">() // method defaults to "post"

// Valid field names compile.
f.field("text")
f.field("count")
f.field("text", { id: "text", placeholder: "new todo" })

// @ts-expect-error — "txet" is not a field on the /todos body
f.field("txet")

const fd = new FormData()
f.read(fd, "text")
f.readAll(fd, "count")

// @ts-expect-error — "userId" is an orphan read (not in the schema)
f.read(fd, "userId")

// @ts-expect-error — "/nope" is not a route the app declares
formFor<App, "/nope">()

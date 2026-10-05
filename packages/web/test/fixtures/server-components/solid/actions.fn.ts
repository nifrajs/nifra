import { t } from "@nifrajs/schema"
import { serverFn } from "@nifrajs/web/fn"
export const save = serverFn(
  { input: t.object({ fail: t.boolean() }), output: t.object({ ok: t.boolean() }) },
  (input, ctx) => {
    if (!input.fail) ctx.set.headers["set-cookie"] = "fixture-revision=2; Path=/; SameSite=Lax"
    return { ok: !input.fail }
  },
)

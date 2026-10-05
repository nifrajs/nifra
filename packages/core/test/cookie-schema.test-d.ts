/** Type-level contract for the `cookies` route slot. Checked by `tsc`, not run. */
import { t } from "@nifrajs/schema"
import type { Equal, Expect } from "@nifrajs/test-utils"
import type { Context } from "../src/index.ts"
import { server } from "../src/index.ts"
import { defineContract, implement } from "../src/server/contract.ts"

const cookies = t.cookies({ session: t.string(), page: t.optional(t.integer()) })

export type _Untyped = Expect<Equal<Context["cookies"], Readonly<Record<string, string>>>>

export const typed = server()
  .get("/typed", { cookies }, (c) => {
    const session: string = c.cookies.session
    const page: number | undefined = c.cookies.page
    // @ts-expect-error a cookie the schema does not declare is not on the validated type
    return { session, page, other: c.cookies.other }
  })
  .get("/raw", (c) => {
    const value: string | undefined = c.cookies.anything
    return { value: value ?? null }
  })

export const contracted = implement(
  defineContract({ me: { method: "GET", path: "/me", cookies } }),
  {
    me: (c) => {
      const session: string = c.cookies.session
      // @ts-expect-error the contract's cookie schema types c.cookies too
      const wrong: number = c.cookies.session
      return { session, wrong }
    },
  },
)

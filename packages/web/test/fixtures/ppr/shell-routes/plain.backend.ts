import { sessionUser } from "../shell-lib/session.ts"

export const loader = (ctx: { request: Request }) => ({ user: sessionUser(ctx.request) })

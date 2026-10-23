import { sessionUser } from "../shell-lib/session.ts"

export const shellLoader = async () => ({ user: sessionUser(new Request("https://x.test")) })

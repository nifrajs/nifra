import { sessionUser } from "../shell-lib/session.ts"

// The shell renders the page's meta too, so a read only meta makes still reaches every visitor.
export const meta = () => ({ title: sessionUser(new Request("https://x.test")) ?? "guest" })

export default function MetaLeak() {
  return null
}

import { sessionUser } from "../../shell-lib/session.ts"

export const meta = () => ({ title: sessionUser(new Request("https://x.test")) ?? "guest" })

export default function Layout(props: { readonly children?: unknown }) {
  return props.children
}

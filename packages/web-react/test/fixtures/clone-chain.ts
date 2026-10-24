import { cloneElement, createElement as h, type ReactElement } from "react"

type Props = { children: ReactElement<{ injected?: string }>; injected?: string }
export const Layout = ({ children }: Props) =>
  h("main", null, cloneElement(children, { injected: "from-layout" }))
export const Nested = ({ children, injected }: Props) =>
  h("section", null, cloneElement(children, { injected: `${injected}/nested` }))
export const Page = ({ injected }: { injected?: string }) =>
  h("p", { id: "result" }, injected ?? "MISSING")
export const Other = ({ injected }: { injected?: string }) =>
  h("p", { id: "other" }, injected ?? "MISSING")

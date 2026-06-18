import { type ComponentChildren, h, type VNode } from "preact"

// Root layout — wraps the page via `props.children` (the compose fold passes the child there).
export function Layout(props: { children: ComponentChildren }): VNode {
  return h("div", { class: "wrap" }, props.children)
}

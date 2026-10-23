/** @jsxImportSource preact */
import type { ComponentChildren } from "preact"

export default function Members(props: {
  readonly data?: unknown
  readonly children?: ComponentChildren
}) {
  return (
    <section
      id="members"
      data-member={
        typeof props.data === "object" && props.data !== null && "member" in props.data
          ? "yes"
          : "no"
      }
    >
      {props.children}
    </section>
  )
}

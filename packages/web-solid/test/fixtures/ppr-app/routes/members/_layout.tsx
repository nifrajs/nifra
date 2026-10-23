import type { JSX } from "solid-js"

export default function Members(props: {
  readonly data?: unknown
  readonly children?: JSX.Element
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

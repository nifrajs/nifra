import type { JSX } from "@solidjs/web"

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

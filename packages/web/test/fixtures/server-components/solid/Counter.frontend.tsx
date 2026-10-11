import { componentPortalTarget } from "@nifrajs/web/server-components/portal"
import { createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
export default function Counter(props: {
  title: string
  prefix?: string
  slots?: Record<string, string>
}) {
  let root!: HTMLElement
  let target!: HTMLDivElement
  const [portal, setPortal] = createSignal<Element>()
  onMount(() => setPortal(componentPortalTarget(root, target)))
  const [count, setCount] = createSignal(0)
  onMount(() => window.dispatchEvent(new Event("fixture:mounted")))
  onCleanup(() => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("fixture:disposed"))
  })
  return (
    <article ref={root}>
      <h2>{props.title}</h2>
      <button
        type="button"
        id={`${props.prefix ?? ""}counter`}
        onClick={() => setCount(count() + 1)}
      >
        Count {count()}
      </button>
      <input id={`${props.prefix ?? ""}value`} value="original" />
      <div innerHTML={props.slots?.summary ?? ""} />
      <div ref={target} data-nifra-portal="details" />
      {portal() && (
        <Portal mount={portal()!}>
          <span id={`${props.prefix ?? ""}portal`}>Portal {props.title}</span>
        </Portal>
      )}
    </article>
  )
}

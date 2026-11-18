import { componentPortalTarget } from "@nifrajs/web/server-components/portal"
import { Portal } from "@solidjs/web"
import { createSignal, onSettled } from "solid-js"
export default function Counter(props: {
  title: string
  prefix?: string
  slots?: Record<string, string>
}) {
  let root!: HTMLElement
  let target!: HTMLDivElement
  const [portal, setPortal] = createSignal<Element>()
  onSettled(() => setPortal(componentPortalTarget(root, target)))
  const [count, setCount] = createSignal(0)
  onSettled(() => {
    window.dispatchEvent(new Event("fixture:mounted"))
    return () => {
      if (typeof window !== "undefined") window.dispatchEvent(new Event("fixture:disposed"))
    }
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

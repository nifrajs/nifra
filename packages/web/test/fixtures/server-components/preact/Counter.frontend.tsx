import { componentPortalTarget } from "@nifrajs/web/server-components/portal"
import { createPortal } from "preact/compat"
import { useLayoutEffect, useRef, useState } from "preact/hooks"
export default function Counter(props: {
  title: string
  prefix?: string
  slots?: Record<string, string>
}) {
  const root = useRef<HTMLElement>(null)
  const target = useRef<HTMLDivElement>(null)
  const [portal, setPortal] = useState<Element>()
  const [count, setCount] = useState(0)
  useLayoutEffect(() => {
    if (root.current !== null && target.current !== null)
      setPortal(componentPortalTarget(root.current, target.current))
    window.dispatchEvent(new Event("fixture:mounted"))
    return () => window.dispatchEvent(new Event("fixture:disposed"))
  }, [])
  return (
    <article ref={root}>
      <h2>{props.title}</h2>
      <button type="button" id={`${props.prefix ?? ""}counter`} onClick={() => setCount(count + 1)}>
        Count {count}
      </button>
      <input id={`${props.prefix ?? ""}value`} defaultValue="original" />
      <div dangerouslySetInnerHTML={{ __html: props.slots?.summary ?? "" }} />
      <div ref={target} data-nifra-portal="details" />
      {portal &&
        createPortal(<span id={`${props.prefix ?? ""}portal`}>Portal {props.title}</span>, portal)}
    </article>
  )
}

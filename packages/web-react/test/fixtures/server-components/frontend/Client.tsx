"use client"
import { componentPortalTarget } from "@nifrajs/web/server-components/portal"
import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
export function Counter({
  title,
  summary,
  prefix = "",
}: {
  title: string
  prefix?: string
  summary?: ReactNode
}) {
  const root = useRef<HTMLElement>(null)
  const target = useRef<HTMLDivElement>(null)
  const [portal, setPortal] = useState<Element>()
  useLayoutEffect(() => setPortal(componentPortalTarget(root.current!, target.current!)), [])
  const [count, setCount] = useState(0)
  useLayoutEffect(() => {
    window.dispatchEvent(new Event("fixture:mounted"))
    return () => {
      window.dispatchEvent(new Event("fixture:disposed"))
    }
  }, [])
  return (
    <article ref={root}>
      <h2>{title}</h2>
      <button type="button" id={`${prefix}counter`} onClick={() => setCount(count + 1)}>
        Count {count}
      </button>
      <input id={`${prefix}value`} defaultValue="original" />
      {summary}
      <div ref={target} data-nifra-portal="details" />
      {portal && createPortal(<span id={`${prefix}portal`}>Portal {title}</span>, portal)}
    </article>
  )
}

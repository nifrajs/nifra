"use client"
import { createElement, useRef } from "react"

/** The outer Flight root preserves this host; the controller owns the complete nested range. */
export function NestedServerComponent({
  instance,
  html,
}: {
  readonly instance: string
  readonly html: string
}) {
  const initial = useRef({ __html: html })
  return createElement("nifra-component", {
    "data-nifra-component": instance,
    // biome-ignore lint/security/noDangerouslySetInnerHtml: Parent rendering provides the verified server-owned nested range.
    dangerouslySetInnerHTML: initial.current,
  })
}

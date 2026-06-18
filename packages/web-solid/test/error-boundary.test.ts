import { describe, expect, test } from "bun:test"
import { type Component, createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
import { errorBoundary } from "../src/error.ts"

type BoundaryComponent = Component<{ children?: unknown }>

// Solid components may return a string; this fallback renders the serialized error as text.
const Fallback = (props: { data: { name: string; message: string } }) =>
  `ERR ${props.data.name}: ${props.data.message}`

const wrap = (Boundary: BoundaryComponent, child: () => unknown): string =>
  renderToString(() =>
    createComponent(Boundary, {
      get children() {
        return child()
      },
    }),
  )

describe("@nifrajs/web-solid errorBoundary", () => {
  test("catches a render error in the subtree → renders the fallback with { name, message }", () => {
    const Boundary = errorBoundary(Fallback) as unknown as BoundaryComponent
    const Throwing = () => {
      throw new Error("boom")
    }
    expect(wrap(Boundary, () => createComponent(Throwing, {}))).toContain("ERR Error: boom")
  })

  test("wraps a non-Error throw in an Error (name/message still available)", () => {
    const Boundary = errorBoundary(Fallback) as unknown as BoundaryComponent
    const Throwing = () => {
      throw "plain string"
    }
    expect(wrap(Boundary, () => createComponent(Throwing, {}))).toContain("ERR Error: plain string")
  })

  test("transparent: renders children unchanged when nothing throws", () => {
    const Boundary = errorBoundary(Fallback) as unknown as BoundaryComponent
    const Ok = () => "ok-content"
    const html = wrap(Boundary, () => createComponent(Ok, {}))
    expect(html).toContain("ok-content")
    expect(html).not.toContain("ERR")
  })
})

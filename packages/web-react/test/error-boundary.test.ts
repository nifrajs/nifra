import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { errorBoundary } from "../src/error.ts"
import { reactAdapter } from "../src/index.ts"

const toText = (
  s: ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>,
): Promise<string> => Promise.resolve(s).then((stream) => new Response(stream).text())

const Fallback = (props: { data: { name: string; message: string } }) =>
  createElement("div", { id: "err" }, `${props.data.name}: ${props.data.message}`)

// React error boundaries are a CLIENT-side recovery mechanism — `renderToReadableStream` rejects on a
// shell throw rather than rendering the boundary fallback (that path is nifra's 3a server catch). So the
// catch behavior is unit-tested on the class directly here, and browser-verified end-to-end in the
// example; SSR only confirms the boundary is transparent (renders children, adds no DOM).
describe("@nifrajs/web-react errorBoundary", () => {
  test("getDerivedStateFromError captures the error; render shows the fallback with { name, message }", () => {
    const Boundary = errorBoundary(Fallback) as unknown as {
      new (props: { children?: unknown }): { state: { error: Error | null }; render: () => unknown }
      getDerivedStateFromError: (e: Error) => { error: Error | null }
    }
    const err = new Error("boom")
    expect(Boundary.getDerivedStateFromError(err)).toEqual({ error: err })
    // The constructor's field initializer sets the idle state.
    const idle = new Boundary({ children: "kids" })
    expect(idle.state).toEqual({ error: null })
    expect(idle.render()).toBe("kids") // no error → children, untouched
    // With an error → the fallback element carrying the serialized { name, message }.
    const caught = new Boundary({})
    caught.state = { error: err }
    const el = caught.render() as {
      type: unknown
      props: { data: { name: string; message: string } }
    }
    expect(el.type).toBe(Fallback)
    expect(el.props.data).toEqual({ name: "Error", message: "boom" })
  })

  test("transparent on SSR: renders children unchanged, adds no wrapper element", async () => {
    const Boundary = errorBoundary(Fallback)
    const Ok = () => createElement("p", null, "ok")
    const html = await toText(reactAdapter.renderToStream([Boundary, Ok], { data: null }))
    expect(html).toContain("<p>ok</p>")
    expect(html).not.toContain('id="err"')
  })
})

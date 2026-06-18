import { describe, expect, test } from "bun:test"
import { h } from "preact"
import { errorBoundary } from "../src/error.ts"
import { preactAdapter } from "../src/index.ts"

const toText = (
  s: ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>,
): Promise<string> => Promise.resolve(s).then((stream) => new Response(stream).text())

const Fallback = (props: { data: { name: string; message: string } }) =>
  h("div", { id: "err" }, `${props.data.name}: ${props.data.message}`)

describe("@nifrajs/web-preact errorBoundary", () => {
  test("getDerivedStateFromError captures the error; render shows the fallback with { name, message }", () => {
    const Boundary = errorBoundary(Fallback) as unknown as {
      new (props: { children?: unknown }): { state: { error: Error | null }; render: () => unknown }
      getDerivedStateFromError: (e: Error) => { error: Error | null }
    }
    const err = new Error("boom")
    expect(Boundary.getDerivedStateFromError(err)).toEqual({ error: err })
    const idle = new Boundary({ children: "kids" })
    expect(idle.state).toEqual({ error: null })
    expect(idle.render()).toBe("kids") // no error → children
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
    const Ok = () => h("p", null, "ok")
    const html = await toText(preactAdapter.renderToStream([Boundary, Ok], { data: null }))
    expect(html).toContain("<p>ok</p>")
    expect(html).not.toContain('id="err"')
  })
})

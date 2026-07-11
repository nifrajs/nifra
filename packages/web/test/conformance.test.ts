import { describe, expect, test } from "bun:test"
import {
  assertRenderAdapterConformance,
  type RenderAdapter,
  RenderAdapterConformanceError,
  type RenderAdapterConformanceFixture,
} from "../src/index.ts"

const fixture: RenderAdapterConformanceFixture = {
  page: "PAGE",
  outerLayout: "OUTER",
  innerLayout: "INNER",
  props: { data: "DATA", pending: true },
  markers: {
    page: "PAGE",
    data: "DATA",
    pending: "PENDING:true",
    outer: "OUTER",
    inner: "INNER",
  },
}

const htmlFor = (chain: readonly unknown[], props: { data: unknown; pending?: boolean }): string =>
  `${chain.join("")}:${String(props.data)}:PENDING:${String(props.pending)}`

const streamOf = (html: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(html)
      const midpoint = Math.max(1, Math.floor(bytes.length / 2))
      controller.enqueue(bytes.slice(0, midpoint))
      controller.enqueue(bytes.slice(midpoint))
      controller.close()
    },
  })

const adapter = (overrides: Partial<RenderAdapter> = {}): RenderAdapter => ({
  renderToStream: (chain, props) => streamOf(htmlFor(chain, props)),
  renderToString: (chain, props) => htmlFor(chain, props),
  hydrationHead: () => "<script>hydrate()</script>",
  ...overrides,
})

describe("assertRenderAdapterConformance", () => {
  test("executes the complete RenderAdapter interface without a test-runner dependency", async () => {
    await expect(assertRenderAdapterConformance(adapter(), fixture)).resolves.toBeUndefined()
    const streamingOnly: RenderAdapter = {
      renderToStream: (chain, props) => streamOf(htmlFor(chain, props)),
      hydrationHead: () => "",
    }
    await expect(assertRenderAdapterConformance(streamingOnly, fixture)).resolves.toBeUndefined()
  })

  test("reports missing markers and incorrect layout order through a named check", async () => {
    const missing = assertRenderAdapterConformance(
      adapter({ renderToStream: () => streamOf("no contract markers") }),
      fixture,
    )
    await expect(missing).rejects.toMatchObject({
      name: "RenderAdapterConformanceError",
      check: "page stream",
    })

    const wrongOrder = adapter({
      renderToStream: (chain, props) =>
        streamOf(
          chain.length === 1
            ? htmlFor(chain, props)
            : `INNEROUTERPAGE:${String(props.data)}:PENDING:${String(props.pending)}`,
        ),
    })
    await expect(assertRenderAdapterConformance(wrongOrder, fixture)).rejects.toMatchObject({
      check: "layout order",
    })
  })

  test("enforces Web byte streams and wraps stream failures", async () => {
    const notStream = adapter({
      renderToStream: (() => "html") as unknown as RenderAdapter["renderToStream"],
    })
    await expect(assertRenderAdapterConformance(notStream, fixture)).rejects.toMatchObject({
      check: "page stream",
    })

    const invalidChunk = adapter({
      renderToStream: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue("not bytes" as unknown as Uint8Array)
            controller.close()
          },
        }),
    })
    await expect(assertRenderAdapterConformance(invalidChunk, fixture)).rejects.toBeInstanceOf(
      RenderAdapterConformanceError,
    )

    const rejects = adapter({ renderToStream: () => Promise.reject(new Error("shell")) })
    await expect(assertRenderAdapterConformance(rejects, fixture)).rejects.toMatchObject({
      check: "page stream",
      cause: expect.any(Error),
    })

    const throws = adapter({
      renderToStream: () => {
        throw new Error("sync shell")
      },
    })
    await expect(assertRenderAdapterConformance(throws, fixture)).rejects.toMatchObject({
      check: "page stream",
      cause: expect.any(Error),
    })
  })

  test("enforces buffered equivalence and a stable hydration head", async () => {
    await expect(
      assertRenderAdapterConformance(adapter({ renderToString: () => "different" }), fixture),
    ).rejects.toMatchObject({ check: "hydration equivalence" })

    let calls = 0
    await expect(
      assertRenderAdapterConformance(adapter({ hydrationHead: () => String(calls++) }), fixture),
    ).rejects.toMatchObject({ check: "hydration head" })

    await expect(
      assertRenderAdapterConformance(
        adapter({
          hydrationHead: () => {
            throw new Error("head")
          },
        }),
        fixture,
      ),
    ).rejects.toMatchObject({ check: "hydration head", cause: expect.any(Error) })
  })
})

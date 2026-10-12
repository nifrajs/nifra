/**
 * The runner on **Node itself**: undici's `Request` refuses a stream body without `duplex: "half"`,
 * which Bun accepts, so only this lane proves a streamed POST reaches the app.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { runApp } from "@nifrajs/runner"

test("a ReadableStream body reaches the app on Node", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("streamed-upload"))
      controller.close()
    },
  })
  const [result] = await runApp({ fetch: async (request) => new Response(await request.text()) }, [
    { method: "POST", path: "/upload", body },
  ])
  assert.equal(result?.ok, true, JSON.stringify(result?.error))
  assert.equal(result?.bodyText, "streamed-upload")
})

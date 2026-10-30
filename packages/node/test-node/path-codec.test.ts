/**
 * The path-segment codec on **Node itself**: every spelling it produces reaches a handler as the exact
 * text a client sent, so the path a page links is the path the route sees.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { server } from "@nifrajs/core"
import { browserPathSegment, encodePathSegment } from "@nifrajs/core/pattern"
import { serve } from "@nifrajs/node"
import {
  passThroughMismatches,
  rawCharacters,
  refusalMismatches,
  segmentMismatches,
} from "../../core/test/path-codec-matrix.ts"

test("both spellings hold every codec property on Node", () => {
  assert.deepEqual(segmentMismatches(encodePathSegment, "canonical"), [])
  assert.deepEqual(segmentMismatches(browserPathSegment, "browser"), [])
  assert.deepEqual(refusalMismatches(encodePathSegment), [])
  assert.equal(
    rawCharacters(encodePathSegment),
    "!$&'()*+,-.0123456789:=@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~",
  )
})

test("Node hands every spelling to the handler unchanged", async () => {
  const app = server().get("/*rest", (c) => new Response(new URL(c.req.url).pathname))
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    assert.deepEqual(await passThroughMismatches(running.port), [])
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

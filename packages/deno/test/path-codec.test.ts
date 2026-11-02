import { server } from "@nifrajs/core"
import { browserPathSegment, encodePathSegment } from "@nifrajs/core/pattern"
import {
  passThroughMismatches,
  rawCharacters,
  refusalMismatches,
  segmentMismatches,
} from "../../core/test/path-codec-matrix.ts"
import { serve } from "../src/index.ts"

function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}, got ${a}`)
}

Deno.test("both spellings hold every codec property on Deno", () => {
  assertEquals(segmentMismatches(encodePathSegment, "canonical"), [])
  assertEquals(segmentMismatches(browserPathSegment, "browser"), [])
  assertEquals(refusalMismatches(encodePathSegment), [])
  assertEquals(
    rawCharacters(encodePathSegment),
    "!$&'()*+,-.0123456789:=@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~",
  )
})

Deno.test("Deno hands every spelling to the handler unchanged", async () => {
  const app = server().get("/*rest", (c) => new Response(new URL(c.req.url).pathname))
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    assertEquals(await passThroughMismatches(running.port), [])
  } finally {
    await running.stop()
  }
})

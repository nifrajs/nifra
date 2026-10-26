import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

/**
 * The whole point of `@nifrajs/edge` is a small self-contained bundle. This guards it: bundle the
 * entry with core's lane inlined (an edge worker ships one file), minified, and assert the gzipped
 * size stays under a ceiling. A regression - e.g. accidentally reaching into a heavy corner of
 * `@nifrajs/core` - trips this before it ships.
 *
 * Measured at authoring: ~7.5 KB gz (raw ~22 KB); ~9.4 KB once the lane refused cross-site form
 * bodies; 9,607 B once header reads on Deno skipped building the whole header list (+158 B); 9,766 B
 * with Bun's prototype-guard cursor stack, which ships here unused (+86 B); 9,882 B once a client's
 * body that fails while it is read answers 400 instead of 500 (+120 B); 9,983 B (from 9,885) once a
 * `bigint` in a JSON answer is written as its decimal string, as on core; 10,028 B (from 9,983)
 * once a route that sets a header, cookie or status with no response hook skips the resident-body
 * record; 10,414 B (from 10,028) once a plain `Date` in a JSON answer is written ahead of the
 * serializer, as on core (V8's serializer also slows at a `Date`: Deno -22% instructions on 50 Date
 * rows); 10,569 B (from 10,489) once that writer copies only plain records and lists. The ceiling
 * has headroom for honest growth; a jump past it means something big got pulled in - investigate,
 * don't just bump the number.
 */
const CEILING_GZIP_BYTES = 10_600

test(`self-contained bundle stays under ${CEILING_GZIP_BYTES} B gzipped`, async () => {
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    minify: true,
    target: "browser",
  })
  expect(built.success).toBe(true)

  let raw = 0
  const chunks: Uint8Array[] = []
  for (const output of built.outputs) {
    const bytes = new Uint8Array(await output.arrayBuffer())
    raw += bytes.byteLength
    chunks.push(bytes)
  }
  const merged = new Uint8Array(raw)
  let at = 0
  for (const c of chunks) {
    merged.set(c, at)
    at += c.byteLength
  }
  const gz = Bun.gzipSync(merged, { level: 9 }).byteLength

  // Surfaced on failure so the ratchet says by how much and against what.
  expect({ gz, ceiling: CEILING_GZIP_BYTES, raw }).toMatchObject({
    gz: expect.any(Number),
  })
  expect(gz).toBeLessThanOrEqual(CEILING_GZIP_BYTES)
})

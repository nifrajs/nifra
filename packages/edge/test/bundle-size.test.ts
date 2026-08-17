import { expect, test } from "bun:test"

/**
 * The whole point of `@nifrajs/edge` is a small self-contained bundle. This guards it: bundle the
 * entry with core's lane inlined (an edge worker ships one file), minified, and assert the gzipped
 * size stays under a ceiling. A regression - e.g. accidentally reaching into a heavy corner of
 * `@nifrajs/core` - trips this before it ships.
 *
 * Measured at authoring: ~7.3 KB gz (raw ~20 KB). The ceiling has headroom for honest growth; a
 * jump past it means something big got pulled in - investigate, don't just bump the number.
 */
const CEILING_GZIP_BYTES = 9_000

test(`self-contained bundle stays under ${CEILING_GZIP_BYTES} B gzipped`, async () => {
  const built = await Bun.build({
    entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
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

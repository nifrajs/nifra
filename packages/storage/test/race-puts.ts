import type { FileStorage } from "../src/index.ts"

/** Two instances (two processes) put one key `rounds` times at once; every read is checked against
 * the put its metadata names. Returns the reads that mixed one put's body with another's metadata,
 * and the puts that failed. */
export async function racePuts(
  a: FileStorage,
  b: FileStorage,
  rounds: number,
): Promise<{ readonly mixed: number; readonly failed: readonly string[] }> {
  let mixed = 0
  const failed: string[] = []
  for (let i = 0; i < rounds; i++) {
    const bodies = { a: `AAAA-${i}`, b: `BBBBBBBB-${i}` }
    const settled = await Promise.allSettled([
      a.put("obj", bodies.a, { contentType: "text/a", metadata: { who: "a" } }),
      b.put("obj", bodies.b, { contentType: "text/b", metadata: { who: "b" } }),
    ])
    for (const result of settled)
      if (result.status === "rejected") failed.push(String(result.reason))
    const got = await a.get("obj")
    const who = got?.metadata?.who
    if (got !== null && (who === "a" || who === "b")) {
      if (new TextDecoder().decode(got.body) !== bodies[who] || got.contentType !== `text/${who}`)
        mixed++
    }
  }
  return { mixed, failed }
}

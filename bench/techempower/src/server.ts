/**
 * TechEmpower Framework Benchmarks implementation for nifra.
 *
 * Implements the six required test types against the TFB Postgres database
 * (https://github.com/TechEmpower/FrameworkBenchmarks/wiki/Project-Information-Framework-Tests-Overview):
 *   /json        JSON serialization
 *   /plaintext   plaintext
 *   /db          single query
 *   /queries     multiple queries (?queries=N clamped to 1..500)
 *   /fortunes    server-rendered, HTML-escaped table with a runtime-added row
 *   /updates     read N rows, write new randomNumbers back (?queries=N clamped)
 *
 * Uses Bun's built-in Postgres client - no ORM, no driver dependency - and nifra's
 * public routing exactly as an application would (classification: Fullstack/Realistic).
 */
import { server } from "@nifrajs/core/server"
import { SQL } from "bun"

const sql = new SQL({
  url:
    process.env.DATABASE_URL ??
    "postgres://benchmarkdbuser:benchmarkdbpass@tfb-database:5432/hello_world",
  max: 56,
})

interface World {
  id: number
  randomNumber: number
}

const randomId = (): number => 1 + ((Math.random() * 10000) | 0)

/** TFB rule: any non-numeric/out-of-range ?queries= clamps into 1..500. */
function clampQueries(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10)
  if (Number.isNaN(n) || n < 1) return 1
  return n > 500 ? 500 : n
}

async function oneWorld(): Promise<World> {
  const rows = await sql`SELECT id, randomnumber FROM world WHERE id = ${randomId()}`
  const row = rows[0] as { id: number; randomnumber: number }
  return { id: row.id, randomNumber: row.randomnumber }
}

const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

const app = server()
  // TFB verification requires a Server header on every response (Date comes from Bun.serve).
  .onResponse((res) => {
    res.headers.set("server", "nifra")
    return res
  })
  .get("/json", () => ({ message: "Hello, World!" }))
  .get(
    "/plaintext",
    () =>
      new Response("Hello, World!", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
  )
  .get("/db", () => oneWorld())
  .get("/queries", async (c) => {
    const count = clampQueries(new URL(c.req.url).searchParams.get("queries"))
    return Promise.all(Array.from({ length: count }, oneWorld))
  })
  .get("/fortunes", async () => {
    const rows = (await sql`SELECT id, message FROM fortune`) as Array<{
      id: number
      message: string
    }>
    const fortunes = [...rows, { id: 0, message: "Additional fortune added at request time." }]
    fortunes.sort((a, b) => (a.message < b.message ? -1 : a.message > b.message ? 1 : 0))
    const body =
      "<!DOCTYPE html><html><head><title>Fortunes</title></head><body><table><tr><th>id</th><th>message</th></tr>" +
      fortunes.map((f) => `<tr><td>${f.id}</td><td>${escapeHtml(f.message)}</td></tr>`).join("") +
      "</table></body></html>"
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })
  })
  .get("/updates", async (c) => {
    const count = clampQueries(new URL(c.req.url).searchParams.get("queries"))
    const worlds = await Promise.all(Array.from({ length: count }, oneWorld))
    for (const w of worlds) w.randomNumber = randomId()
    // Update in ascending id order so concurrent requests cannot deadlock each other.
    const ordered = [...worlds].sort((a, b) => a.id - b.id)
    for (const w of ordered) {
      await sql`UPDATE world SET randomnumber = ${w.randomNumber} WHERE id = ${w.id}`
    }
    return worlds
  })

app.listen(8080)
console.log("nifra TFB server listening on :8080")

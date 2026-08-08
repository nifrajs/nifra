import {
  HTTP_REALWORLD,
  HTTP_WORKLOADS,
  type HttpRealworldTable,
  type HttpWorkloadTable,
  MULTIPLIERS,
  SSR_TABLES,
  SSR_TABLES_B,
  type SsrTableRow,
} from "../data/benchmarks"
import { pageMeta } from "../meta"

export const meta = pageMeta(
  "Nifra - Benchmarks",
  "Nifra vs Next.js, Nuxt, SvelteKit, SolidStart, and Remix on full-stack SSR, plus HTTP throughput vs Elysia, Hono, Fastify, and Express across Bun, Node, and Deno.",
  "/benchmarks",
)

// ---- Frontend: full-stack SSR, Nifra vs each framework's own meta-framework ----
// Data + grouping come from site/data/benchmarks.json, which `bun run bench:ssr` refreshes on every
// complete run - the page can't drift from the last measured numbers.
const fmtMs = (ms: number): string => `${ms.toFixed(2)} ms`
const fmtJs = (row: SsrTableRow): string => (row.jsGzKb > 0 ? `${row.jsGzKb} KB` : "n/a")

function SsrRows({ rows }: { rows: readonly SsrTableRow[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Target</th>
          <th className="num">req/s</th>
          <th className="num">p50</th>
          <th className="num">p99</th>
          <th className="num">client JS (gz)</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name} className={row.nifra ? "hl" : undefined}>
            <td>{row.name}</td>
            <td className="num">{row.rps.toLocaleString()}</td>
            <td className="num">{fmtMs(row.p50ms)}</td>
            <td className="num">{fmtMs(row.p99ms)}</td>
            <td className="num">{fmtJs(row)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---- Backend: raw HTTP throughput across runtimes ----
// Two core workloads per framework (path-param GET, validated POST) - see BENCHMARKS.md.
type HttpRow = HttpWorkloadTable["rows"][number]
type RuntimeTable = HttpWorkloadTable

// Bun/Deno: median of 5 full-matrix runs; Node: median-of-3 section run of 2026-08-04 (after the
// Node serving optimizations). Bun 1.3.14 · Node 26 · Deno 2.8 · oha @ 50 conns. Read same-run
// ratios, not absolutes. `bun-native`/`node-raw`/`deno-raw` are the runtime ceilings (no framework)
// the framework rows chase - one ceiling row per runtime.
const HTTP: ReadonlyArray<RuntimeTable> = HTTP_WORKLOADS

/** Rank rows by geometric mean across the workloads - a single strong column (or a single weak
 * one) can't decide the order the way sorting by one workload alone would. */
function geoMean(row: HttpRow): number {
  const values = [row.getUsers, row.postUsers].map((v) => Number(v.replaceAll(",", "")))
  return Math.exp(values.reduce((sum, v) => sum + Math.log(v), 0) / values.length)
}

// ---- Backend: the same routes, carrying what a real API route carries ----
// The bare tables above are the number every framework publishes; this is the one that survives
// contact with an application. Same GET and POST, but the route has security headers, CORS, a
// request-id hook, bearer auth through a derive, and a cookie read - which on nifra specifically
// disqualifies it from every fused fast lane, so this is the pessimistic side of our own numbers.
type RealworldRow = HttpRealworldTable["rows"][number]

function realworldGeoMean(row: RealworldRow): number {
  const values = [row.get, row.post, row.body].map((v) => Number(v.replaceAll(",", "")))
  return Math.exp(values.reduce((sum, v) => sum + Math.log(v), 0) / values.length)
}

function RealworldTable({ table }: { table: HttpRealworldTable }) {
  const ranked = [...table.rows].sort((a, b) => realworldGeoMean(b) - realworldGeoMean(a))
  return (
    <section className="bench-block">
      <h2>{table.title}</h2>
      <table>
        <thead>
          <tr>
            <th>Framework</th>
            <th className="num">GET /api/orders</th>
            <th className="num">POST /api/orders</th>
            <th className="num">GET + body hash</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((row) => (
            <tr key={row.name} className={row.nifra ? "hl" : undefined}>
              <td>{row.name}</td>
              <td className="num">{row.get}</td>
              <td className="num">{row.post}</td>
              <td className="num">{row.body}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function HttpTable({ table }: { table: RuntimeTable }) {
  const ranked = [...table.rows].sort((a, b) => geoMean(b) - geoMean(a))
  return (
    <section className="bench-block">
      <h2>{table.title}</h2>
      <table>
        <thead>
          <tr>
            <th>Framework</th>
            <th className="num">GET /users/:id</th>
            <th className="num">POST /users</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((row) => (
            <tr key={row.name} className={row.nifra ? "hl" : undefined}>
              <td>{row.name}</td>
              <td className="num">{row.getUsers}</td>
              <td className="num">{row.postUsers}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

export default function Benchmarks() {
  return (
    <div className="bench">
      <h1 className="page">Benchmarks</h1>
      <p className="lead">
        Local <code>oha</code> runs on the same machine, same window, same runtime version. Read
        ratios inside a section before absolutes: laptop thermals and warmup move raw req/s more
        than the framework order. Reproduce with <code>bun run bench:ssr</code> and{" "}
        <code>bun run bench:http</code>.
      </p>

      {/* ---- Frontend: full-stack SSR vs the meta-frameworks ---- */}
      <h2 style={{ marginTop: 40 }}>Full-stack SSR - Nifra vs the meta-frameworks</h2>
      <p className="lead">
        One section per UI framework, each with two explicitly-labelled tables:{" "}
        <b>A - dynamic SSR</b> (the page rendered on every request, no caching) and{" "}
        <b>B - cacheable</b> (the same page from each framework's SSG/ISR mode). Meta-frameworks run
        on Node through their own production server. Nifra shows <b>Bun</b> and <b>Node</b> rows (
        <code>@nifrajs/node</code>) so the Node rows compare apples-to-apples. The headline
        multipliers below are Table A only.
      </p>
      <div className="mult-grid" style={{ margin: "20px 0 8px" }}>
        {MULTIPLIERS.map((m) => (
          <div className="mult-item" key={m.fw}>
            <strong>{m.mult}</strong>
            <span>{`Nifra + ${m.fw} vs ${m.rival} (Node)`}</span>
          </div>
        ))}
      </div>
      {SSR_TABLES.map((table) => {
        const tableB = SSR_TABLES_B.find((b) => b.framework === table.framework)
        return (
          <div key={table.framework}>
            <h3 style={{ marginTop: 28 }}>{table.framework}</h3>
            <p className="note" style={{ margin: "6px 0 8px" }}>
              <b>A - Dynamic SSR.</b> The page is rendered on <b>every request</b>, no caching: the
              per-request cost, the number that matters for pages that can't be cached.
            </p>
            <SsrRows rows={table.rows} />
            {tableB !== undefined && (
              <>
                <p className="note" style={{ margin: "14px 0 8px" }}>
                  <b>B - Cacheable.</b> The same page served from each framework's cached mode -
                  SSG, and ISR where supported (cache warmed before measuring). A cached row is not
                  an SSR row: compare within this table only.
                </p>
                <SsrRows rows={tableB.rows} />
              </>
            )}
          </div>
        )
      })}
      <div className="caveat">
        Meta-frameworks are Node-only in this matrix; compare them against Nifra's <b>Node</b> row
        (the headline multipliers above do exactly that). Preact has no maintained meta-framework,
        so its section is Nifra-only - Bun vs Node on the same app. A client-JS of <code>n/a</code>{" "}
        means the run couldn't account that framework's payload from the SSR HTML.
      </div>

      {/* ---- Backend: HTTP throughput across runtimes ---- */}
      <h2 style={{ marginTop: 48 }}>Backend - HTTP throughput across runtimes</h2>
      <p className="lead">
        Nifra is also a standalone API framework. Two core workloads - a path-param GET and a
        validated POST - each runtime through Nifra's real adapter, next to that runtime's raw
        handler and the popular libraries. Rows are ordered by the geometric mean of the workloads,
        so no single column decides the ranking.
      </p>
      <div className="bench-grid">
        {HTTP.map((table) => (
          <HttpTable key={table.title} table={table} />
        ))}
      </div>

      {HTTP_REALWORLD.length > 0 && (
        <>
          <h2 style={{ marginTop: 48 }}>Backend - the same routes with a real route's work</h2>
          <p className="lead">
            The tables above are the shape every framework publishes: a bare route doing nothing but
            routing. This is the same GET and POST after the route gains what an actual API route
            has - security headers, CORS, a request-id hook, bearer auth through a derive, and a
            cookie read. That combination disqualifies the route from every one of Nifra's fused
            fast lanes, so these are the pessimistic numbers, not the flattering ones. The third
            column adds one body-observing middleware to the same GET.
          </p>
          <div className="bench-grid">
            {HTTP_REALWORLD.map((table) => (
              <RealworldTable key={table.title} table={table} />
            ))}
          </div>
        </>
      )}

      <p className="lead" style={{ marginTop: 32 }}>
        Reproduce locally with <code>bun run bench:http:update</code>,{" "}
        <code>bun run bench:http:realworld:update</code>, and <code>bun run bench:ssr</code>.
        Same-run ratios matter more than absolute req/s.
      </p>
    </div>
  )
}

import { MULTIPLIERS, SSR_TABLES, type SsrTableRow } from "../data/benchmarks"
import { pageMeta } from "../meta"

export const meta = pageMeta(
  "Nifra - Benchmarks",
  "Nifra vs Next.js, Nuxt, SvelteKit, SolidStart, and Remix on full-stack SSR, plus HTTP throughput vs Elysia, Hono, Fastify, and Express across Bun, Node, and Deno.",
)

// ---- Frontend: full-stack SSR, Nifra vs each framework's own meta-framework ----
// Data + grouping come from site/data/benchmarks.json, which `bun run bench:ssr` refreshes on every
// complete run - the page can't drift from the last measured numbers.
const fmtMs = (ms: number): string => `${ms.toFixed(2)} ms`
const fmtJs = (row: SsrTableRow): string => (row.jsGzKb > 0 ? `${row.jsGzKb} KB` : "n/a")

// ---- Backend: raw HTTP throughput across runtimes ----
// Four identical workloads per framework - see BENCHMARKS.md.
type HttpRow = {
  name: string
  getRoot: string
  getUsers: string
  getSearch: string
  postUsers: string
  nifra?: boolean
}
type RuntimeTable = { title: string; rows: ReadonlyArray<HttpRow> }

// Median of 3 full-matrix runs · Bun 1.3.14 · Node 26 · Deno 2.8 · oha @ 50 conns. Read same-run
// ratios, not absolutes. `bun-native`/`*-raw` are the runtime ceilings the framework rows chase.
const HTTP: ReadonlyArray<RuntimeTable> = [
  {
    title: "Bun",
    rows: [
      {
        name: "Nifra",
        getRoot: "139,844",
        getUsers: "138,511",
        getSearch: "123,893",
        postUsers: "106,734",
        nifra: true,
      },
      {
        name: "bun-native",
        getRoot: "139,520",
        getUsers: "142,178",
        getSearch: "115,621",
        postUsers: "119,128",
      },
      {
        name: "Elysia",
        getRoot: "139,034",
        getUsers: "132,913",
        getSearch: "125,707",
        postUsers: "105,706",
      },
      {
        name: "bun-raw",
        getRoot: "135,590",
        getUsers: "133,114",
        getSearch: "112,745",
        postUsers: "113,874",
      },
      {
        name: "Hono",
        getRoot: "116,702",
        getUsers: "107,738",
        getSearch: "86,604",
        postUsers: "83,997",
      },
    ],
  },
  {
    title: "Node",
    rows: [
      {
        name: "node-raw",
        getRoot: "88,775",
        getUsers: "89,051",
        getSearch: "78,394",
        postUsers: "77,388",
      },
      {
        name: "Nifra",
        getRoot: "84,390",
        getUsers: "84,349",
        getSearch: "82,776",
        postUsers: "62,883",
        nifra: true,
      },
      {
        name: "Fastify",
        getRoot: "81,957",
        getUsers: "83,047",
        getSearch: "82,520",
        postUsers: "61,332",
      },
      {
        name: "Elysia",
        getRoot: "77,512",
        getUsers: "77,313",
        getSearch: "75,236",
        postUsers: "52,340",
      },
      {
        name: "Express",
        getRoot: "53,479",
        getUsers: "52,738",
        getSearch: "52,457",
        postUsers: "44,588",
      },
      {
        name: "Hono",
        getRoot: "52,305",
        getUsers: "51,805",
        getSearch: "48,926",
        postUsers: "37,654",
      },
    ],
  },
  {
    title: "Deno",
    rows: [
      {
        name: "deno-raw",
        getRoot: "123,251",
        getUsers: "123,099",
        getSearch: "108,010",
        postUsers: "102,906",
      },
      {
        name: "Elysia",
        getRoot: "122,532",
        getUsers: "121,774",
        getSearch: "111,815",
        postUsers: "81,372",
      },
      {
        name: "Nifra",
        getRoot: "120,548",
        getUsers: "118,821",
        getSearch: "104,283",
        postUsers: "83,705",
        nifra: true,
      },
      {
        name: "Hono",
        getRoot: "102,890",
        getUsers: "98,236",
        getSearch: "86,650",
        postUsers: "76,925",
      },
    ],
  },
]

function HttpTable({ table }: { table: RuntimeTable }) {
  return (
    <section className="bench-block">
      <h2>{table.title}</h2>
      <table>
        <thead>
          <tr>
            <th>Framework</th>
            <th className="num">GET /</th>
            <th className="num">GET /users/:id</th>
            <th className="num">GET /search</th>
            <th className="num">POST /users</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.name} className={row.nifra ? "hl" : undefined}>
              <td>{row.name}</td>
              <td className="num">{row.getRoot}</td>
              <td className="num">{row.getUsers}</td>
              <td className="num">{row.getSearch}</td>
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
        A data-loaded HTML page rendered on <b>every request</b> (no caching), one section per UI
        framework. Meta-frameworks run on Node through their own production server. Nifra shows two
        rows per framework - <b>Bun</b> (its fastest path) and <b>Node</b> via{" "}
        <code>@nifrajs/node</code> - so the Node rows compare apples-to-apples.
      </p>
      <div className="mult-grid" style={{ margin: "20px 0 8px" }}>
        {MULTIPLIERS.map((m) => (
          <div className="mult-item" key={m.fw}>
            <strong>{m.mult}</strong>
            <span>{`Nifra + ${m.fw} vs ${m.rival} (Node)`}</span>
          </div>
        ))}
      </div>
      {SSR_TABLES.map((table) => (
        <div key={table.framework}>
          <h3 style={{ marginTop: 28 }}>{table.framework}</h3>
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
              {table.rows.map((row) => (
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
        </div>
      ))}
      <div className="caveat">
        Meta-frameworks are Node-only in this matrix; compare them against Nifra's <b>Node</b> row
        (the headline multipliers above do exactly that). Preact has no maintained meta-framework,
        so its section is Nifra-only - Bun vs Node on the same app. A client-JS of{" "}
        <code>n/a</code> means the run couldn't account that framework's payload from the SSR HTML.
      </div>

      {/* ---- Backend: HTTP throughput across runtimes ---- */}
      <h2 style={{ marginTop: 48 }}>Backend - HTTP throughput across runtimes</h2>
      <p className="lead">
        Nifra is also a standalone API framework. Four workloads - root JSON, path params, validated
        query, validated POST - each runtime through Nifra's real adapter, next to that runtime's
        raw handler and the popular libraries.
      </p>
      <div className="bench-grid">
        {HTTP.map((table) => (
          <HttpTable key={table.title} table={table} />
        ))}
      </div>

      <p className="lead" style={{ marginTop: 32 }}>
        Reproduce locally with <code>bun run bench:http:update</code> and{" "}
        <code>bun run bench:ssr</code>. Same-run ratios matter more than absolute req/s.
      </p>
    </div>
  )
}

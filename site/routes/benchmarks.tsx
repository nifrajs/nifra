import { pageMeta } from "../meta"

export const meta = pageMeta(
  "Nifra - Benchmarks",
  "Nifra vs Next.js, Nuxt, SvelteKit, SolidStart, and Remix on full-stack SSR, plus HTTP throughput vs Elysia, Hono, Fastify, and Express across Bun, Node, and Deno.",
)

// ---- Frontend: full-stack SSR, Nifra vs each framework's own meta-framework ----
// Dynamic per-request render of a data-loaded page. Meta-frameworks run on Node through their
// production server; Nifra rows show Bun, Node, and Deno (@nifrajs/bun · @nifrajs/node · @nifrajs/deno).
// oha median-of-3 × 5s @ 50 conns. `js` = gzipped client JS.
type SsrRow = {
  name: string
  rps: string
  p50: string
  p99: string
  js: string
  nifra?: boolean
}

const SSR_DYNAMIC: ReadonlyArray<SsrRow> = [
  // React
  {
    name: "Nifra + React (Bun)",
    rps: "31,800",
    p50: "1.50 ms",
    p99: "3.10 ms",
    js: "58.9 KB",
    nifra: true,
  },
  {
    name: "Nifra + React (Node)",
    rps: "22,714",
    p50: "2.10 ms",
    p99: "4.31 ms",
    js: "58.9 KB",
    nifra: true,
  },
  {
    name: "Nifra + React (Deno)",
    rps: "28,400",
    p50: "1.68 ms",
    p99: "3.45 ms",
    js: "58.9 KB",
    nifra: true,
  },
  { name: "Next.js (Node)", rps: "1,038", p50: "47.3 ms", p99: "60.3 ms", js: "182.4 KB" },
  { name: "Remix (Node)", rps: "1,532", p50: "32.3 ms", p99: "45.4 ms", js: "99.2 KB" },
  // Solid
  {
    name: "Nifra + Solid (Bun)",
    rps: "30,400",
    p50: "1.55 ms",
    p99: "3.15 ms",
    js: "6.0 KB",
    nifra: true,
  },
  {
    name: "Nifra + Solid (Node)",
    rps: "21,712",
    p50: "2.18 ms",
    p99: "4.47 ms",
    js: "6.0 KB",
    nifra: true,
  },
  {
    name: "Nifra + Solid (Deno)",
    rps: "27,100",
    p50: "1.75 ms",
    p99: "3.58 ms",
    js: "6.0 KB",
    nifra: true,
  },
  { name: "SolidStart (Node)", rps: "6,430", p50: "6.76 ms", p99: "20.2 ms", js: "18.3 KB" },
  // Svelte
  {
    name: "Nifra + Svelte (Bun)",
    rps: "27,200",
    p50: "1.65 ms",
    p99: "3.90 ms",
    js: "20.7 KB",
    nifra: true,
  },
  {
    name: "Nifra + Svelte (Node)",
    rps: "19,418",
    p50: "2.33 ms",
    p99: "5.52 ms",
    js: "20.7 KB",
    nifra: true,
  },
  {
    name: "Nifra + Svelte (Deno)",
    rps: "24,300",
    p50: "1.86 ms",
    p99: "4.35 ms",
    js: "20.7 KB",
    nifra: true,
  },
  { name: "SvelteKit (Node)", rps: "6,014", p50: "7.67 ms", p99: "15.9 ms", js: "n/a" },
  // Vue
  {
    name: "Nifra + Vue (Bun)",
    rps: "21,000",
    p50: "2.18 ms",
    p99: "4.75 ms",
    js: "26.5 KB",
    nifra: true,
  },
  {
    name: "Nifra + Vue (Node)",
    rps: "15,017",
    p50: "3.06 ms",
    p99: "6.76 ms",
    js: "26.5 KB",
    nifra: true,
  },
  {
    name: "Nifra + Vue (Deno)",
    rps: "18,800",
    p50: "2.45 ms",
    p99: "5.40 ms",
    js: "26.5 KB",
    nifra: true,
  },
  { name: "Nuxt (Node)", rps: "2,090", p50: "20.5 ms", p99: "83.7 ms", js: "67.6 KB" },
  // Preact
  {
    name: "Nifra + Preact (Bun)",
    rps: "30,100",
    p50: "1.58 ms",
    p99: "3.20 ms",
    js: "7.4 KB",
    nifra: true,
  },
  {
    name: "Nifra + Preact (Node)",
    rps: "21,476",
    p50: "2.23 ms",
    p99: "4.53 ms",
    js: "7.4 KB",
    nifra: true,
  },
  {
    name: "Nifra + Preact (Deno)",
    rps: "26,800",
    p50: "1.78 ms",
    p99: "3.62 ms",
    js: "7.4 KB",
    nifra: true,
  },
  { name: "preact-ssr (Node)", rps: "31,924", p50: "1.46 ms", p99: "3.28 ms", js: "4.6 KB" },
]

const MULTIPLIERS = [
  { mult: "22×", label: "Nifra + React vs Next.js (Node)" },
  { mult: "7×", label: "Nifra + Vue vs Nuxt (Node)" },
  { mult: "3.4×", label: "Nifra + Solid vs SolidStart (Node)" },
  { mult: "3.2×", label: "Nifra + Svelte vs SvelteKit (Node)" },
]

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
        name: "Elysia",
        getRoot: "127,708",
        getUsers: "126,622",
        getSearch: "121,474",
        postUsers: "92,559",
      },
      {
        name: "Nifra",
        getRoot: "125,558",
        getUsers: "125,242",
        getSearch: "115,079",
        postUsers: "97,039",
        nifra: true,
      },
      {
        name: "bun-native",
        getRoot: "124,919",
        getUsers: "125,191",
        getSearch: "105,739",
        postUsers: "100,054",
      },
      {
        name: "bun-raw",
        getRoot: "125,555",
        getUsers: "121,112",
        getSearch: "108,411",
        postUsers: "102,351",
      },
      {
        name: "Hono",
        getRoot: "107,184",
        getUsers: "95,564",
        getSearch: "75,954",
        postUsers: "72,455",
      },
    ],
  },
  {
    title: "Node",
    rows: [
      {
        name: "Nifra",
        getRoot: "72,362",
        getUsers: "70,402",
        getSearch: "66,317",
        postUsers: "52,410",
        nifra: true,
      },
      {
        name: "Fastify",
        getRoot: "72,220",
        getUsers: "69,799",
        getSearch: "70,139",
        postUsers: "51,052",
      },
      {
        name: "node-raw",
        getRoot: "71,673",
        getUsers: "72,313",
        getSearch: "67,654",
        postUsers: "63,722",
      },
      {
        name: "Elysia",
        getRoot: "66,751",
        getUsers: "65,596",
        getSearch: "66,365",
        postUsers: "43,348",
      },
      {
        name: "Express",
        getRoot: "44,122",
        getUsers: "43,260",
        getSearch: "43,807",
        postUsers: "37,423",
      },
      {
        name: "Hono",
        getRoot: "43,801",
        getUsers: "43,083",
        getSearch: "41,140",
        postUsers: "31,806",
      },
    ],
  },
  {
    title: "Deno",
    rows: [
      {
        name: "deno-raw",
        getRoot: "112,048",
        getUsers: "106,840",
        getSearch: "89,102",
        postUsers: "91,214",
      },
      {
        name: "Elysia",
        getRoot: "109,081",
        getUsers: "102,147",
        getSearch: "102,544",
        postUsers: "71,523",
      },
      {
        name: "Nifra",
        getRoot: "107,896",
        getUsers: "106,631",
        getSearch: "90,079",
        postUsers: "71,862",
        nifra: true,
      },
      {
        name: "Hono",
        getRoot: "85,693",
        getUsers: "85,885",
        getSearch: "76,317",
        postUsers: "67,011",
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
        A data-loaded HTML page rendered on <b>every request</b> (no caching). Meta-frameworks run
        on Node through their own production server. Nifra runs on <b>Bun</b>, <b>Node</b>, and{" "}
        <b>Deno</b> - three rows per UI library - so you can see Nifra at its best (Bun) and compare
        apples-to-apples on Node.
      </p>
      <div className="mult-grid" style={{ margin: "20px 0 8px" }}>
        {MULTIPLIERS.map((m) => (
          <div className="mult-item" key={m.label}>
            <strong>{m.mult}</strong>
            <span>{m.label}</span>
          </div>
        ))}
      </div>
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
          {SSR_DYNAMIC.map((row) => (
            <tr key={row.name} className={row.nifra ? "hl" : undefined}>
              <td>{row.name}</td>
              <td className="num">{row.rps}</td>
              <td className="num">{row.p50}</td>
              <td className="num">{row.p99}</td>
              <td className="num">{row.js}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="caveat">
        Meta-frameworks are Node-only in this matrix. Nifra's <b>Bun</b> rows are its fastest path
        (e.g. Nifra + React ≈ 32k req/s vs Next.js at 1k on Node). <b>Node</b> and <b>Deno</b> rows
        use the same app through <code>@nifrajs/node</code> and <code>@nifrajs/deno</code>.{" "}
        <code>preact-ssr</code> is a hand-written template with no framework, included as a floor.
        SvelteKit's client-JS number didn't report cleanly in this run (shown <code>n/a</code>).
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

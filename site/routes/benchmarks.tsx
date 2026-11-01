import {
  type CapturedMeta,
  type CaptureMachine,
  HTTP_MEMORY,
  HTTP_REALWORLD,
  HTTP_REALWORLD_CAPTURED,
  HTTP_WORKLOADS,
  HTTP_WORKLOADS_CAPTURED,
  type HttpRealworldTable,
  type HttpWorkloadTable,
  MULTIPLIERS,
  SSR_CAPTURED,
  SSR_TABLES,
  SSR_TABLES_B,
  type SsrTableRow,
} from "../shared/data/benchmarks"
import { pageMeta } from "../shared/meta"

export const meta = pageMeta(
  "Nifra - Benchmarks",
  "Nifra vs Next.js, Nuxt, SvelteKit, SolidStart, and Remix on full-stack SSR, plus HTTP throughput vs Elysia, Hono, Fastify, and Express across Bun, Node, and Deno.",
  "/benchmarks",
)

// ---- Frontend: full-stack SSR, Nifra vs each framework's own meta-framework ----
// Data + grouping come from site/shared/data/benchmarks.json, which `bun run bench:ssr` refreshes on every
// complete run - the page can't drift from the last measured numbers.
const fmtMs = (ms: number): string => `${ms.toFixed(2)} ms`
const fmtJs = (row: SsrTableRow): string => (row.jsGzKb > 0 ? `${row.jsGzKb} KB` : "n/a")

function Captured({ meta }: { meta: CapturedMeta }) {
  const runtimes = [`Bun ${meta.bun}`, `Node ${meta.node}`]
  if (meta.deno !== undefined) runtimes.push(`Deno ${meta.deno}`)
  const machines = [
    ...(meta.machine === undefined ? [] : [`All runtimes: ${describeMachine(meta.machine)}`]),
    ...(["node", "bun", "deno"] as const).flatMap((runtime) => {
      const machine = meta.machines?.[runtime]
      return machine === undefined
        ? []
        : [`${runtime[0]?.toUpperCase()}${runtime.slice(1)}: ${describeMachine(machine)}`]
    }),
  ]
  const source =
    meta.sourceUrl === undefined ? (
      (meta.source ?? "Source not recorded")
    ) : (
      <a href={meta.sourceUrl}>{meta.source ?? "Benchmark run"}</a>
    )
  return (
    <p className="note">
      {meta.date} · {source} · {machines.join("; ") || "Machine not recorded"} ·{" "}
      {runtimes.join(", ")} · <code>oha</code> {meta.oha} · 50 connections
    </p>
  )
}

function describeMachine(machine: CaptureMachine): string {
  return `${machine.runner} · ${machine.cpu} · ${machine.vcpus} vCPU`
}

function Named({ name, version }: { name: string; version: string }) {
  return (
    <>
      {name}
      <span className="bench-version">v{version}</span>
    </>
  )
}

function SsrRows({ rows }: { rows: readonly SsrTableRow[] }) {
  const ranked = [...rows].sort((a, b) => b.rps - a.rps || a.name.localeCompare(b.name))
  return (
    <table>
      <thead>
        <tr>
          <th>Target</th>
          <th className="num" aria-sort="descending">
            Median req/s
          </th>
          <th className="num">p50</th>
          <th className="num">p99</th>
          <th className="num">client JS (gz)</th>
        </tr>
      </thead>
      <tbody>
        {ranked.map((row) => (
          <tr key={row.name} className={row.nifra ? "hl" : undefined}>
            <td>
              <Named name={row.name} version={row.version} />
            </td>
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

// ---- Backend: HTTP throughput across runtimes ----
// Two core workloads per framework (path-param GET, validated POST) - see BENCHMARKS.md.
type HttpRow = HttpWorkloadTable["rows"][number]
type RuntimeTable = HttpWorkloadTable

type MemoryCapture = (typeof HTTP_MEMORY)[number]
type MemoryMetric = "readyRssMiB" | "getRssMiB" | "postRssMiB" | "peakRssMiB" | "postHeapMiB"

const MEMORY_COLUMNS: ReadonlyArray<{ key: MemoryMetric; label: string }> = [
  { key: "readyRssMiB", label: "Ready RSS" },
  { key: "getRssMiB", label: "After GET" },
  { key: "postRssMiB", label: "After POST" },
  { key: "peakRssMiB", label: "Peak RSS" },
  { key: "postHeapMiB", label: "POST heap" },
]

function MemoryTable({ capture }: { capture: MemoryCapture }) {
  const ranked = [...capture.rows].sort(
    (a, b) => a.postRssMiB - b.postRssMiB || a.name.localeCompare(b.name),
  )
  const lowest: Record<MemoryMetric, number> = {
    readyRssMiB: Math.min(...capture.rows.map((row) => row.readyRssMiB)),
    getRssMiB: Math.min(...capture.rows.map((row) => row.getRssMiB)),
    postRssMiB: Math.min(...capture.rows.map((row) => row.postRssMiB)),
    peakRssMiB: Math.min(...capture.rows.map((row) => row.peakRssMiB)),
    postHeapMiB: Math.min(...capture.rows.map((row) => row.postHeapMiB)),
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>Framework</th>
            {MEMORY_COLUMNS.map(({ key, label }) => (
              <th key={key} className="num">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ranked.map((row) => (
            <tr key={row.name} className={row.nifra ? "hl" : undefined}>
              <td>
                <Named name={row.name} version={row.version} />
              </td>
              {MEMORY_COLUMNS.map(({ key }) => {
                const value = row[key]
                const isLowest = value === lowest[key]
                return (
                  <td
                    key={key}
                    className={isLowest ? "num memory-best" : "num"}
                    title={
                      key === "postRssMiB"
                        ? `Observed range: ${row.postRssMinMiB.toFixed(1)}-${row.postRssMaxMiB.toFixed(1)} MiB`
                        : undefined
                    }
                  >
                    {value.toFixed(1)} MiB
                    {isLowest && <span className="memory-best-label">Low</span>}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

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
// request-id hook, bearer auth through a derive, and a cookie read - the shape most deployed API
// routes have, which nifra compiles into its fused derive-and-before lane.
type RealworldRow = HttpRealworldTable["rows"][number]

function realworldGeoMean(row: RealworldRow): number {
  const values = [row.get, row.post, row.body].map((v) => Number(v.replaceAll(",", "")))
  return Math.exp(values.reduce((sum, v) => sum + Math.log(v), 0) / values.length)
}

function RealworldTable({ table }: { table: HttpRealworldTable }) {
  const ranked = [...table.rows].sort((a, b) => realworldGeoMean(b) - realworldGeoMean(a))
  return (
    <section className="bench-block">
      <h2>{`${table.title} ${table.version}`}</h2>
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
              <td>
                <Named name={row.name} version={row.version} />
              </td>
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
      <h2>{`${table.title} ${table.version}`}</h2>
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
              <td>
                <Named name={row.name} version={row.version} />
              </td>
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
        Median results from interleaved rounds. Compare within each runtime; absolute rates vary by
        runner.
      </p>

      {/* ---- Frontend: full-stack SSR vs the meta-frameworks ---- */}
      <h2 style={{ marginTop: 40 }}>Full-stack SSR - Nifra vs the meta-frameworks</h2>
      <Captured meta={SSR_CAPTURED} />
      <p className="lead">
        Each framework has uncached SSR and cached SSG/ISR rows. Compare Nifra's Node app with the
        Node meta-frameworks; multipliers use the uncached rows.
      </p>
      <p className="note">
        Nifra's loader rows include the documented <code>loaderOutput</code> projection and schema
        check.
      </p>
      <div className="mult-grid" style={{ margin: "20px 0 8px" }}>
        {MULTIPLIERS.map((m) => (
          <div className="mult-item" key={m.fw}>
            <strong>{m.mult}</strong>
            <span>{`Nifra + ${m.fw} vs ${m.rival} ${m.rivalVersion} (Node)`}</span>
          </div>
        ))}
      </div>
      <p className="note" style={{ margin: "0 0 8px" }}>
        The static-host row is a plain Bun file server; no Nifra code runs per request.
      </p>
      {SSR_TABLES.map((table) => {
        const tableB = SSR_TABLES_B.find((b) => b.framework === table.framework)
        return (
          <div key={table.framework}>
            <h3 style={{ marginTop: 28 }}>{table.framework}</h3>
            <p className="note" style={{ margin: "6px 0 8px" }}>
              <b>A · Dynamic SSR</b>
            </p>
            <SsrRows rows={table.rows} />
            {tableB !== undefined && (
              <>
                <p className="note" style={{ margin: "14px 0 8px" }}>
                  <b>B · Cached SSG/ISR</b> (cache warmed before measurement)
                </p>
                <SsrRows rows={tableB.rows} />
              </>
            )}
          </div>
        )
      })}
      <div className="caveat">
        Preact uses a renderer-only baseline because Fresh is Deno-only. Bun and Node SSR use
        separate runners; compare rates within each runtime. <code>n/a</code> means client JS could
        not be measured from the HTML.
      </div>

      {/* ---- Backend: HTTP throughput across runtimes ---- */}
      <h2 style={{ marginTop: 48 }}>Backend - HTTP throughput across runtimes</h2>
      <Captured meta={HTTP_WORKLOADS_CAPTURED} />
      <p className="lead">
        Path-param GET and schema-validated POST, ranked by their geometric mean.
      </p>
      <p className="note">
        Fastify on Bun/Deno uses <code>node:http</code> compatibility, not native ingress.
      </p>
      <div className="bench-grid">
        {HTTP.map((table) => (
          <HttpTable key={table.title} table={table} />
        ))}
      </div>

      {HTTP_REALWORLD.length > 0 && (
        <>
          <h2 style={{ marginTop: 48 }}>Backend - the same routes with a real route's work</h2>
          <Captured meta={HTTP_REALWORLD_CAPTURED} />
          <p className="lead">
            The same routes with security headers, CORS, request ID, bearer auth, and cookie
            handling.
          </p>
          <p className="note">
            Allowed-origin GET/POST only; CORS preflight and rejected origins are excluded.
          </p>
          <div className="bench-grid">
            {HTTP_REALWORLD.map((table) => (
              <RealworldTable key={table.title} table={table} />
            ))}
          </div>
        </>
      )}

      {HTTP_MEMORY.length > 0 && (
        <>
          <h2 style={{ marginTop: 48 }}>Backend - memory footprint across runtimes</h2>
          <p className="note">
            RSS is process-wide after GC; POST heap is retained JavaScript memory.
          </p>
          <p className="note">
            <a href="https://github.com/nifrajs/nifra/actions/runs/41327120547">
              Accuracy CI · 2026-11-01
            </a>{" "}
            · median of 5 fresh processes · 50k GETs + POSTs per process · 50 connections · sorted
            by after-POST RSS; <b>Low</b> marks each column&apos;s minimum.
          </p>
          {HTTP_MEMORY.map((capture) => (
            <div key={capture.runtime}>
              <h3 style={{ marginTop: 24 }}>
                {capture.runtime[0]?.toUpperCase()}
                {capture.runtime.slice(1)} {capture.runtimeVersion}
              </h3>
              <p className="note">{capture.cpu}</p>
              <MemoryTable capture={capture} />
            </div>
          ))}
        </>
      )}
    </div>
  )
}

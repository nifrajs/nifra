import type { CSSProperties } from "react"
import {
  BUNDLE,
  formatRps,
  HERO_SSR,
  HTTP_RUNTIME,
  httpWorkloadRps,
  MULTIPLIERS,
  PROOF,
} from "../shared/data/benchmarks"
import { CodeBlock } from "../shared/highlight"
import { pageMeta, softwareApplication } from "../shared/meta"

export const meta = pageMeta(
  "Nifra - the AI-native full-stack TypeScript framework",
  "Nifra is the AI-native full-stack TypeScript framework. The route is the contract: the typed client, the docs, the MCP tools, and the security policy are all checked against it, so a change made by you or by a coding agent cannot half-land. One app across Bun, Node, Deno, and the edge.",
  "/",
  // The one page that describes the project rather than a document, so the SoftwareApplication and
  // the site-wide Organization record both live here and nowhere else.
  {
    structuredData: [
      softwareApplication(),
      {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Nifra",
        url: "https://nifra.dev",
        logo: "https://nifra.dev/assets/og.jpg",
        sameAs: ["https://github.com/nifrajs/nifra", "https://www.npmjs.com/org/nifrajs"],
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "technical support",
          url: "https://nifra.dev/contact",
        },
      },
    ],
  },
)

// ---- The hero walkthrough: one change, followed through every gate. ----
// Every output line is the CLI's own format (`nifra check` / `nifra assure`), so the demo cannot
// promise a message the tool does not print.
type DemoKind = "ask" | "ctx" | "add" | "del" | "cmd" | "err" | "ok" | "dim" | "out"

interface DemoLine {
  readonly kind: DemoKind
  readonly text: string
  /** Leading columns, kept as padding so a wrapped line keeps its indent. */
  readonly indent?: number
  /** Starts a new block: a little air above. */
  readonly gap?: boolean
  /** A file label printed above this line. */
  readonly file?: string
}

interface DemoFrame {
  readonly label: string
  readonly caption: string
  readonly lines: readonly DemoLine[]
}

const DEMO_FRAMES: readonly DemoFrame[] = [
  {
    label: "Prompt",
    caption: "A coding agent gets a plain request, and edits two routes.",
    lines: [
      {
        kind: "ask",
        text: "Rename title to heading on the note route, and add a route that creates notes.",
      },
      { kind: "ctx", text: '.get("/notes/:id", async (c) => {', file: "src/server.ts" },
      { kind: "ctx", text: "const note = await notes.find(c.params.id)", indent: 2 },
      { kind: "del", text: "return { id: note.id, title: note.title }", indent: 2 },
      { kind: "add", text: "return { id: note.id, heading: note.title }", indent: 2 },
      { kind: "ctx", text: "})" },
      { kind: "add", text: '.post("/notes", {' },
      { kind: "add", text: "body: NoteInput,", indent: 2 },
      { kind: "add", text: "}, (c) => notes.insert(c.body))" },
    ],
  },
  {
    label: "Check",
    caption:
      "The page that still reads the old field stops compiling, and the write nobody declared is flagged.",
    lines: [
      { kind: "cmd", text: "nifra check" },
      { kind: "err", text: "✗ typecheck failed - the frontend/backend contract is broken" },
      {
        kind: "out",
        text: "routes/note.tsx:14  Property 'title' does not exist on type '{ id: string; heading: string; }'.",
        indent: 4,
      },
      { kind: "dim", text: "..." },
      { kind: "err", text: "✗ effect/capability assurance: 1" },
      { kind: "out", text: "POST /notes evidence exceeds its declaration: db.write", indent: 4 },
      { kind: "err", text: "✗ check failed: 2 errors", gap: true },
    ],
  },
  {
    label: "Assure",
    caption:
      "Client fixed, write declared. Now policy objects: a domain write with no authentication.",
    lines: [
      { kind: "ctx", text: '.post("/notes", {', file: "src/server.ts" },
      { kind: "ctx", text: "body: NoteInput,", indent: 2 },
      { kind: "add", text: 'capabilities: ["db.write"],', indent: 2 },
      { kind: "ctx", text: "}, (c) => notes.insert(c.body))" },
      { kind: "cmd", text: "nifra assure", gap: true },
      { kind: "err", text: "✖ POST /notes (authenticated-write) is missing nifra.authenticated" },
      { kind: "out", text: "1 assurance failure across 2 routes.", gap: true },
    ],
  },
  {
    label: "Ship",
    caption: "One middleware supplies the evidence. Every gate agrees, and the change ships.",
    lines: [
      { kind: "add", text: ".use(jwt({", file: "src/server.ts" },
      { kind: "add", text: "key: env.JWT_SECRET,", indent: 2 },
      { kind: "add", text: 'algorithms: ["HS256"],', indent: 2 },
      { kind: "add", text: "}))" },
      { kind: "cmd", text: "nifra check", gap: true },
      { kind: "ok", text: "✓ typecheck passed" },
      { kind: "dim", text: "..." },
      { kind: "ok", text: "✓ effect/capability assurance: none" },
      { kind: "ok", text: "✓ check passed" },
      { kind: "cmd", text: "nifra assure", gap: true },
      {
        kind: "ok",
        text: "✓ route assurance: 2 routes classified; all required evidence is present. Capability assurance covered 2 routes. No declared response/error schemas were found.",
      },
    ],
  },
]

const DEMO_GUTTER: Partial<Record<DemoKind, string>> = { ask: ">", add: "+", del: "-", cmd: "$" }

/** CSS custom properties are not in React's `CSSProperties`; this is the one place that says so. */
function cssVars(vars: Record<`--${string}`, number>): CSSProperties {
  return vars as CSSProperties
}

// One honest row per shipped capability - the stack you'd otherwise assemble vs the package that
// covers it. No overselling: rows only exist where the Nifra package genuinely does that job.
const REPLACE_GROUPS: ReadonlyArray<{
  title: string
  rows: ReadonlyArray<readonly [string, string]>
}> = [
  {
    title: "API & server",
    rows: [
      ["express / fastify / hono", "@nifrajs/core"],
      ["helmet + cors + express-rate-limit", "@nifrajs/middleware"],
      ["swagger-jsdoc", "@nifrajs/schema/openapi"],
    ],
  },
  {
    title: "Typed client & data",
    rows: [
      ["tRPC / OpenAPI client codegen", "@nifrajs/client"],
      ["TanStack Query (loader cache + mutations)", "@nifrajs/web"],
    ],
  },
  {
    title: "Background work",
    rows: [
      ["BullMQ (single-node jobs)", "@nifrajs/jobs"],
      ["node-cron", "@nifrajs/cron"],
    ],
  },
  {
    title: "Files & media",
    rows: [
      ["multer", "@nifrajs/uploads"],
      ["flydrive (fs + R2 blob storage)", "@nifrajs/storage"],
      ["sharp + srcset glue (responsive images)", "@nifrajs/image"],
    ],
  },
  {
    title: "App services",
    rows: [
      ["dotenv + envalid", "@nifrajs/env"],
      ["keyv / node-cache", "@nifrajs/cache"],
      ["i18next (locale + ICU formatting)", "@nifrajs/i18n"],
      ["contentlayer", "@nifrajs/content"],
    ],
  },
  {
    title: "Testing & mocks",
    rows: [
      ["supertest", "@nifrajs/testing"],
      ["json-server (contract mocks)", "@nifrajs/mock"],
    ],
  },
]

// One row per category for the strip under the hero; the full table is the ecosystem section.
const REPLACE_TOP = REPLACE_GROUPS.flatMap((group) => group.rows.slice(0, 1))
const REPLACE_TOTAL = REPLACE_GROUPS.reduce((total, group) => total + group.rows.length, 0)

// The proof strip reads its two measured numbers from the benchmark dataset, so a re-run moves them.
const BUN_HTTP = HTTP_RUNTIME.find((row) => row.runtime === "Bun")
const REACT_MULTIPLIER = MULTIPLIERS.find((row) => row.fw === "React")
const PROOF_STATS: ReadonlyArray<{ value: string; label: string }> = [
  ...(REACT_MULTIPLIER !== undefined
    ? [
        {
          value: REACT_MULTIPLIER.mult,
          label: `dynamic SSR vs ${REACT_MULTIPLIER.rival} (React on Node, same machine)`,
        },
      ]
    : []),
  ...(BUN_HTTP !== undefined
    ? [
        {
          value: `${Math.round(BUN_HTTP.reqs / 1000)}k`,
          label: `requests per second on Bun - ${BUN_HTTP.pctOfRaw}% of the raw-runtime ceiling`,
        },
      ]
    : []),
  ...PROOF.slice(2),
]

interface Bar {
  readonly name: string
  readonly value: number
  readonly you: boolean
}

interface RankedBar extends Bar {
  /** Width as a percentage of the fastest row. */
  readonly pct: number
}

/** Fastest first, each bar sized against the fastest. */
function rankBars(rows: readonly Bar[]): readonly RankedBar[] {
  const sorted = [...rows].sort((a, b) => b.value - a.value)
  const max = sorted[0]?.value ?? 1
  return sorted.map((row) => ({ ...row, pct: Math.round((row.value / max) * 1000) / 10 }))
}

const SSR_BARS = rankBars(
  HERO_SSR.map((row) => ({ name: row.name, value: row.reqs, you: row.you === true })),
)

const NODE_API_FRAMEWORKS = ["Nifra", "Fastify", "Elysia", "Express", "Hono"] as const
const NODE_API_BARS = rankBars(
  NODE_API_FRAMEWORKS.flatMap((name) => {
    const value = httpWorkloadRps("Node", name, "getUsers")
    return value === undefined ? [] : [{ name, value, you: name === "Nifra" }]
  }),
)

const getRps = (runtime: string, framework: string): string =>
  formatRps(httpWorkloadRps(runtime, framework, "getUsers"))
const bundleKb = (name: string): string => {
  const kb = BUNDLE.find((row) => row.name === name)?.kb
  return kb === undefined ? "n/a" : `${kb} KB`
}

// One card per comparison page. Each states the measured number and the case for the other tool.
const VERSUS = [
  {
    slug: "nextjs",
    name: "Next.js",
    body: `${REACT_MULTIPLIER?.mult ?? ""} the dynamic SSR throughput on the same machine, and five UI frameworks instead of one. Building around React Server Components? Pick Next.js.`,
  },
  {
    slug: "fastify",
    name: "Fastify",
    body: `On Node, ${getRps("Node", "Nifra")} vs ${getRps("Node", "Fastify")} requests per second on the same route. Nifra adds the typed client, the UI layer, and three more runtimes.`,
  },
  {
    slug: "elysia",
    name: "Elysia",
    body: `On Bun, ${getRps("Bun", "Nifra")} vs ${getRps("Bun", "Elysia")} requests per second on the same route. Elysia is a backend; Nifra adds the UI layer and the gates.`,
  },
  {
    slug: "hono",
    name: "Hono",
    body: `Hono is the smaller server bundle: ${bundleKb("Hono")} vs ${bundleKb("Nifra")} gzipped. Pick it for a minimal router, and Nifra for the full stack.`,
  },
] as const

const BACKEND_CODE = `import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

const body = t.object({ name: t.string() })

// A typed API. No frontend required.
export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body }, (c) => {
    // c.body is validated and typed before this runs.
    return { id: crypto.randomUUID(), name: c.body.name }
  })

// Bun. Node, Deno, and the edge are one line each.
export default { fetch: app.fetch }`

const CLIENT_CODE = `import { client } from "@nifrajs/client"
// A type import: server code never ships to the client.
import type { app } from "./server"

const api = client<typeof app>("https://api.example.com")

// The path autocompletes. Params and body are typed.
const res = await api.users({ id: "42" }).get()

if (res.ok) {
  res.data.id   // typed from the route's return
} else {
  res.error     // failures are returned, never thrown
}`

const ASSURE_CODE = `// nifra.assurance.ts - security posture as policy, not convention
import {
  defineAssuranceConfig,
  NIFRA_ASSURANCE,
} from "@nifrajs/core/assurance"
import { app } from "./src/app"

export default defineAssuranceConfig({
  source: app,
  capabilities: {
    definitions: [{ id: "db.write", zone: "domain", access: "write" }],
    provenance: {
      // Classification needs a capability definition and static
      // provenance coverage for the effect it protects.
      imports: [{ specifier: "./db/write.ts", capabilities: ["db.write"] }],
      forbiddenImports: [],
    },
  },
  policy: {
    rules: [
      {
        // Every domain write must prove authentication.
        name: "authenticated-write",
        match: { access: "write", zone: "domain" },
        require: [NIFRA_ASSURANCE.AUTHENTICATED],
      },
    ],
  },
})

// $ nifra assure
// ✖ POST /notes (authenticated-write) is missing nifra.authenticated`

// The five UI adapters, shown as a CSS-only switcher: the SAME routes/loaders/actions/islands -
// only the adapter import changes. Real packages (@nifrajs/web-<fw>), so the swap is truthful.
const FW_TABS = [
  {
    key: "react",
    label: "React",
    code: `// The adapter is the one line that changes per framework:
import { reactAdapter } from "@nifrajs/web-react"
export default createWebApp({ adapter: reactAdapter, manifest, clientEntry })

// routes/hello.tsx - your page, written in React
export function Page({ data }: { data: { name: string } }) {
  return <h1>Hello {data.name}</h1>
}`,
  },
  {
    key: "solid",
    label: "Solid",
    code: `// The adapter is the one line that changes per framework:
import { solidAdapter } from "@nifrajs/web-solid"
export default createWebApp({ adapter: solidAdapter, manifest, clientEntry })

// routes/hello.tsx - same page, Solid's fine-grained JSX
export function Page(props: { data: { name: string } }) {
  return <h1>Hello {props.data.name}</h1>
}`,
  },
  {
    key: "vue",
    label: "Vue",
    code: `// The adapter is the one line that changes per framework:
import { vueAdapter } from "@nifrajs/web-vue"
export default createWebApp({ adapter: vueAdapter, manifest, clientEntry })

<!-- routes/hello.vue - same page, as a Vue SFC -->
<script setup lang="ts">defineProps<{ data: { name: string } }>()</script>
<template><h1>Hello {{ data.name }}</h1></template>`,
  },
  {
    key: "preact",
    label: "Preact",
    code: `// The adapter is the one line that changes per framework:
import { preactAdapter } from "@nifrajs/web-preact"
export default createWebApp({ adapter: preactAdapter, manifest, clientEntry })

// routes/hello.tsx - same page; Preact's 3 KB runtime, identical React API
export function Page({ data }: { data: { name: string } }) {
  return <h1>Hello {data.name}</h1>
}`,
  },
  {
    key: "svelte",
    label: "Svelte",
    code: `// The adapter is the one line that changes per framework:
import { svelteAdapter } from "@nifrajs/web-svelte"
export default createWebApp({ adapter: svelteAdapter, manifest, clientEntry })

<!-- routes/hello.svelte - same page, as a Svelte component -->
<script lang="ts">export let data: { name: string }</script>
<h1>Hello {data.name}</h1>`,
  },
] as const

// Runtime targets - the same app ships everywhere via Web-standard fetch.
const RUNTIME_CARDS = [
  { name: "Bun", note: "Native dev speed", deploy: "export default { fetch: app.fetch }" },
  { name: "Node", note: "Mature, everywhere", deploy: "serve(app, { port: 3000 })" },
  { name: "Deno", note: "Secure by default", deploy: "serve(app, { port: 3000 })" },
  { name: "Cloudflare", note: "Workers / Pages", deploy: "export default toFetchHandler(app)" },
  { name: "Vercel", note: "Edge functions", deploy: "export default toFetchHandler(app)" },
] as const

const AGENT_LOOP = [
  {
    step: "01",
    command: "nifra_context",
    phase: "context",
    title: "Read the live app",
    body: "Routes, schemas, middleware, and conventions - the real API surface, not stale docs.",
  },
  {
    step: "02",
    command: "nifra_scaffold",
    phase: "scaffold",
    title: "Write in the right place",
    body: "URL patterns resolve to framework-correct files, handlers, loaders, and typed clients.",
  },
  {
    step: "03",
    command: "nifra_run",
    phase: "runtime",
    title: "Verify the behavior",
    body: "HTTP, SSR, and WebSocket checks run against the current workspace.",
  },
  {
    step: "04",
    command: "nifra_check",
    phase: "contract",
    title: "Block drift",
    body: "Typecheck and route-contract checks, with the fix suggested, before CI goes green.",
  },
  {
    step: "05",
    command: "nifra_assure",
    phase: "assurance",
    title: "Prove the security posture",
    body: "Policy classifies every route - an unauthenticated write fails the build, named.",
  },
] as const

const GATES = [
  {
    command: "nifra check",
    body: "Typecheck plus contract rules: hand-rolled fetch to your own API, interpolated SQL, server-only imports in a route module.",
  },
  {
    command: "nifra assure",
    body: "Classifies every route against policy and lists the evidence each one is missing.",
  },
  {
    command: "nifra levels",
    body: "Reports which assurance levels the app reaches: L0 typed contract, L1 route assurance, L2 capability lockfile.",
  },
] as const

const MORE_LINKS = [
  { href: "/docs/types-first", label: "Types-first guide" },
  { href: "/docs/security", label: "Security model" },
  { href: "/benchmarks", label: "Benchmarks and method" },
  { href: "/docs/webmcp", label: "WebMCP" },
  { href: "/compare", label: "Compare" },
] as const

function InstallWidget(props: { command: string; label: string }) {
  return (
    <button
      className="install-widget"
      type="button"
      data-copy-command={props.command}
      aria-label={props.label}
    >
      <span className="prompt">$</span>
      <span className="command">{props.command}</span>
      <span className="copy-btn">
        <span className="copied-toast">Copied</span>
        <svg
          className="copy-icon"
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      </span>
    </button>
  )
}

// Four frames in one grid cell. Two hidden "autoplay" radios run the timed pass (the second exists
// so Replay can restart it: a CSS animation only restarts when the rule that names it changes), and
// one radio per step holds a frame still. No script.
function HeroDemo() {
  return (
    <figure className="demo">
      <input
        type="radio"
        name="demo-step"
        id="demo-auto"
        className="demo-radio"
        aria-label="Play the walkthrough"
        defaultChecked
      />
      <input
        type="radio"
        name="demo-step"
        id="demo-auto-b"
        className="demo-radio"
        aria-label="Replay the walkthrough"
      />
      {DEMO_FRAMES.map((frame, index) => (
        <input
          key={frame.label}
          type="radio"
          name="demo-step"
          id={`demo-${index + 1}`}
          className="demo-radio"
          aria-label={`Step ${index + 1}: ${frame.label}`}
        />
      ))}
      <div className="demo-bar" aria-hidden="true">
        <span className="code-window-dots">
          <span className="code-window-dot red" />
          <span className="code-window-dot yellow" />
          <span className="code-window-dot green" />
        </span>
        <span className="demo-title">my-app - coding agent</span>
        <span />
      </div>
      <div className="demo-steps">
        {DEMO_FRAMES.map((frame, index) => (
          <label
            key={frame.label}
            className="demo-step"
            htmlFor={`demo-${index + 1}`}
            data-step={index + 1}
            style={cssVars({ "--n": index })}
          >
            <b>{index + 1}</b>
            {frame.label}
          </label>
        ))}
        <label className="demo-replay demo-replay-a" htmlFor="demo-auto">
          Replay
        </label>
        <label className="demo-replay demo-replay-b" htmlFor="demo-auto-b">
          Replay
        </label>
      </div>
      <div className="demo-screen">
        {DEMO_FRAMES.map((frame, index) => (
          <div
            key={frame.label}
            className="demo-frame"
            data-step={index + 1}
            style={cssVars({ "--n": index })}
          >
            <div className="demo-body">
              {frame.lines.map((line, i) => (
                <div key={`${line.kind}:${line.text}`}>
                  {line.file !== undefined ? <p className="demo-file">{line.file}</p> : null}
                  <div
                    className={line.gap === true ? "demo-line demo-gap" : "demo-line"}
                    data-k={line.kind}
                    style={cssVars({ "--i": i })}
                  >
                    <i aria-hidden="true">{DEMO_GUTTER[line.kind] ?? ""}</i>
                    <span
                      style={
                        line.indent !== undefined ? { paddingLeft: `${line.indent}ch` } : undefined
                      }
                    >
                      {line.text}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <p className="demo-cap">{frame.caption}</p>
          </div>
        ))}
      </div>
      <figcaption className="sr-only">
        One request followed through every gate: a coding agent is asked to rename a field and add a
        route, nifra check fails on the stale client and the undeclared write, nifra assure names
        the unauthenticated write, and one auth middleware turns every gate green.
      </figcaption>
    </figure>
  )
}

function BarChart(props: { title: string; unit: string; bars: readonly RankedBar[] }) {
  return (
    <figure className="home-bars">
      <h3>{props.title}</h3>
      <p className="home-bars-unit">{props.unit}</p>
      <ol>
        {props.bars.map((bar) => (
          <li key={bar.name} className="home-bar" data-you={bar.you ? "" : undefined}>
            <span className="home-bar-name">{bar.name}</span>
            <span className="home-bar-value">{formatRps(bar.value)}</span>
            <span className="home-bar-track" aria-hidden="true">
              <span className="home-bar-fill" style={cssVars({ "--w": bar.pct })} />
            </span>
          </li>
        ))}
      </ol>
    </figure>
  )
}

function FrameworkSwitcher() {
  return (
    <div className="home-fw">
      {FW_TABS.map((tab, i) => (
        <input
          key={tab.key}
          type="radio"
          name="home-fw"
          id={`home-fw-${tab.key}`}
          className="home-fw-radio"
          aria-label={tab.label}
          defaultChecked={i === 0}
        />
      ))}
      <div className="home-fw-tabs">
        {FW_TABS.map((tab) => (
          <label key={tab.key} htmlFor={`home-fw-${tab.key}`}>
            {tab.label}
          </label>
        ))}
      </div>
      <div className="home-fw-panels">
        {FW_TABS.map((tab) => (
          <div key={tab.key} className="home-fw-panel" data-fw={tab.key}>
            <CodeBlock code={tab.code} lang="ts" />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Home() {
  return (
    <>
      <section id="hero" className="home-hero">
        <div className="home-hero-copy">
          <p className="hero-badge">
            <span className="badge-dot" aria-hidden="true" />
            Open source, MIT licensed
          </p>
          <h1>
            The <b className="nowrap">AI-native</b> <span className="nowrap">full-stack</span>{" "}
            TypeScript framework.
          </h1>
          <p className="home-lede">
            Change a route, and the build fails until the client, the docs, the agent tools, and the
            security policy agree. A change made by you or by a coding agent cannot{" "}
            <span className="nowrap">half-land</span>.
          </p>
          <div className="home-install">
            <InstallWidget command="bun create nifra my-app" label="Copy the install command" />
          </div>
          <div className="home-actions">
            <a className="button primary" href="/docs">
              Read the docs
            </a>
            <a className="button ghost" href="/play">
              Open the playground
            </a>
          </div>
          <p className="home-fine">Runs on Bun, Node, Deno, and the edge.</p>
        </div>
        <HeroDemo />
      </section>

      <ul className="home-proof" aria-label="Measured results">
        {PROOF_STATS.map((item) => (
          <li key={item.label}>
            <strong>{item.value}</strong>
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
      <p className="home-proof-note">
        <a href="/benchmarks">How these were measured</a>
      </p>

      <section id="sec-replaces" className="home-swap" aria-labelledby="sec-replaces-title">
        <h2 id="sec-replaces-title" className="home-swap-title">
          One framework in place of a stack you wire together.
        </h2>
        <ul className="home-swap-list">
          {REPLACE_TOP.map(([old, pkg]) => (
            <li key={old}>
              <span className="replace-old">{old}</span>
              <span className="replace-arrow" aria-hidden="true">
                →
              </span>
              <code className="replace-pkg">{pkg}</code>
            </li>
          ))}
        </ul>
        <a className="home-link" href="#sec-ecosystem">
          All {REPLACE_TOTAL} replacements
        </a>
      </section>

      <section id="sec-agent" className="home-band">
        <div className="home-copy">
          <p className="kicker">01 · Agent-native</p>
          <h2>The same gates hold when an agent writes the code.</h2>
          <p>
            <code>nifra mcp</code> gives Claude Code, Cursor, and other MCP clients the live route
            table, a scaffolder that puts files in the right place, and the same check and assure
            gates your CI runs.
          </p>
          <InstallWidget
            command="claude mcp add nifra -- bunx nifra mcp"
            label="Copy the MCP setup command"
          />
          <div className="home-band-links">
            <a href="/docs/agents">Agent guide</a>
            <a href="/docs/webmcp">WebMCP</a>
          </div>
        </div>
        <ol className="home-tools">
          {AGENT_LOOP.map((tool) => (
            <li key={tool.command}>
              <span className="n" aria-hidden="true">
                {tool.step}
              </span>
              <div>
                <code>{tool.command}</code>
                <strong>{tool.title}</strong>
                <p>{tool.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <figure className="home-film">
          {/* biome-ignore lint/a11y/useMediaCaption: a silent recording, so there is no audio to caption; the label and the figcaption describe it. */}
          <video
            controls
            preload="none"
            playsInline
            poster="/assets/media/agent-gate.jpg"
            width={1280}
            height={840}
            aria-label="Terminal recording: an agent's change fails nifra check, then nifra assure, then passes both"
          >
            <source src="/assets/media/agent-gate.mp4" type="video/mp4" />
          </video>
          <figcaption>
            A 60-second terminal recording against a real app. The agent's edits are replayed from
            commits; every line of output is the CLI's own.
          </figcaption>
        </figure>
      </section>

      <section id="sec-client" className="home-section">
        <div className="home-head">
          <p className="kicker">02 · End-to-end types</p>
          <h2>The client is inferred from the server.</h2>
          <p>
            Import the app's type and the path, params, body, and response are typed. There is no
            codegen step to forget and no schema file to drift.
          </p>
        </div>
        <div className="home-duo">
          <CodeBlock code={BACKEND_CODE} lang="ts" filename="server.ts" />
          <CodeBlock code={CLIENT_CODE} lang="ts" filename="client.ts" />
        </div>
      </section>

      <section id="sec-assure" className="home-section home-split">
        <div className="home-copy">
          <p className="kicker">03 · Assurance</p>
          <h2>Security posture is a policy the build enforces.</h2>
          <p>
            Declare what a route may touch, write the rule once, and{" "}
            <code className="inline">nifra assure</code> names every route that breaks it. An
            unauthenticated write is a failed build, not a review comment.
          </p>
          <ul className="home-list">
            {GATES.map((gate) => (
              <li key={gate.command}>
                <code>{gate.command}</code>
                <span>{gate.body}</span>
              </li>
            ))}
          </ul>
        </div>
        <CodeBlock code={ASSURE_CODE} lang="ts" filename="nifra.assurance.ts" />
      </section>

      <section id="sec-play" className="home-section">
        <div className="home-head">
          <p className="kicker">04 · Try it</p>
          <h2>Run a real Nifra app without installing anything.</h2>
          <p>
            This is the real <code className="inline">@nifrajs/core</code>, running in this tab.
            Nothing is sent to a server. Pick an example or edit the code, then press Run.
          </p>
        </div>
        <div className="home-play">
          <iframe src="/play?embed=1" title="Nifra playground" loading="lazy" />
        </div>
        <a className="home-link" href="/play">
          Open the full playground
        </a>
      </section>

      <section id="sec-perf" className="home-section">
        <div className="home-head">
          <p className="kicker">05 · Performance</p>
          <h2>Measured against the frameworks you would otherwise pick.</h2>
          <p>
            Same machine, same workload, every framework in its production mode. The method and the
            full tables are on the benchmarks page.
          </p>
        </div>
        <div className="home-bars-grid">
          <BarChart
            title="Dynamic SSR, React"
            unit="Requests per second, higher is better"
            bars={SSR_BARS}
          />
          <BarChart
            title="JSON API on Node"
            unit="Requests per second on GET /users/:id, higher is better"
            bars={NODE_API_BARS}
          />
        </div>
        <p className="home-bars-note">
          Node is shown for the API chart. The Bun and Deno tables, including the rows where Nifra
          is not first, are on the <a href="/benchmarks">benchmarks page</a>.
        </p>
        <ul className="home-vs" aria-label="Nifra compared with other frameworks">
          {VERSUS.map((item) => (
            <li key={item.slug}>
              <a href={`/compare/${item.slug}`}>
                <strong>Nifra vs {item.name}</strong>
                <p>{item.body}</p>
                <span className="home-vs-go">
                  Read the comparison <span aria-hidden="true">→</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section id="sec-runtime" className="home-section home-split">
        <div className="home-copy">
          <p className="kicker">06 · Portable</p>
          <h2>One app. Five UI frameworks, four runtime families.</h2>
          <p>
            The adapter is one line. Loaders, actions, streaming, and islands stay the same across
            React, Solid, Vue, Preact, and Svelte, and the same app runs on Bun, Node, Deno, and the
            edge.
          </p>
          <ul className="home-runtimes">
            {RUNTIME_CARDS.map((runtime) => (
              <li key={runtime.name}>
                <strong>{runtime.name}</strong>
                <div>
                  <span>{runtime.note}</span>
                  <code>{runtime.deploy}</code>
                </div>
              </li>
            ))}
          </ul>
          <a className="home-link" href="/frameworks">
            See the five-framework demo
          </a>
        </div>
        <FrameworkSwitcher />
      </section>

      <section id="sec-ecosystem" className="home-section">
        <div className="home-head">
          <p className="kicker">07 · Ecosystem</p>
          <h2>Fewer dependencies to keep in agreement.</h2>
          <p>
            The common parts of a TypeScript stack ship as optional @nifrajs packages that share one
            set of types.
          </p>
        </div>
        <div className="replace-groups">
          {REPLACE_GROUPS.map((group) => (
            <div key={group.title} className="replace-cat">
              <div className="replace-cat-head">{group.title}</div>
              {group.rows.map(([old, pkg]) => (
                <div key={old} className="replace-row">
                  <span className="replace-old">{old}</span>
                  <span className="replace-arrow" aria-hidden="true">
                    →
                  </span>
                  <code className="replace-pkg">{pkg}</code>
                </div>
              ))}
            </div>
          ))}
        </div>
        <a className="home-link" href="/docs/integrations">
          Browse every package
        </a>
      </section>

      <section id="sec-cta" className="home-end">
        <div className="home-copy">
          <h2>Start with one route.</h2>
          <p>
            Scaffold an app, change a route, and watch the build tell you what else has to change.
          </p>
          <div className="home-actions">
            <InstallWidget command="bun create nifra my-app" label="Copy the install command" />
            <a className="button primary" href="/docs">
              Read the docs
            </a>
          </div>
        </div>
        <ul className="home-more">
          {MORE_LINKS.map((link) => (
            <li key={link.href}>
              <a href={link.href}>
                {link.label}
                <span aria-hidden="true">→</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}

import { FRONTEND, HTTP_BENCH, PROOF } from "../data/benchmarks"
import { CodeBlock } from "../highlight"
import { HOME_COUNTER_ENTRY } from "../islands/entries"
import { pageMeta } from "../meta"

export const meta = pageMeta(
  "Nifra — the TypeScript framework for AI-edited codebases",
  "Build typed APIs and full-stack apps that humans and coding agents can change safely. Nifra combines live MCP project context, verified scaffolds, a no-codegen typed client, multi-framework SSR, and one app across Bun, Node, Deno, and the edge.",
)

// Static page — ships zero framework JS. The only client code is a tiny enhancer (the install
// command's copy button), loaded through `islandScripts`. The framework switcher + runtime grid
// below are CSS-only (`:checked` radio tabs), so they stay interactive with zero added JS.
export const hydrate = false
export const islandScripts = [HOME_COUNTER_ENTRY]

const BACKEND_CODE = `import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"

// A typed API — no frontend required. Use nifra like Hono or Elysia.
export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body: t.object({ name: t.string() }) }, (c) => {
    // c.body is validated + typed — invalid input is rejected before this runs.
    return { id: crypto.randomUUID(), name: c.body.name }
  })

export default { fetch: app.fetch }   // Bun. Node, Deno, and the edge are one line each.`

const CLIENT_CODE = `import { client } from "@nifrajs/client"
import type { app } from "./server"   // a type import — server code never ships to the client

const api = client<typeof app>("https://api.example.com")

// The path autocompletes. Params and body are typed. No codegen, ever.
const res = await api.users({ id: "42" }).get()

if (res.ok) {
  res.data.name      // typed from the route return or response schema
} else {
  res.error          // client-call failures are returned, never thrown
}`

const AGENT_CODE = `$ nifra context        # the project's live API surface — pipe into any agent prompt
  GET  /users/:id   → response { id: string, name: string }
  POST /users       body { name: string } → response { id: string, name: string }

$ nifra mcp            # same data as an MCP server — Claude Code & Cursor read it automatically

# The typed client is the safety lock — an agent physically can't call a route that changed:
const res = await api.users({ id: "42" }).get()
if (res.ok) res.data.name
//              ^ tsc error here the moment the route or response shape changes

$ nifra check          # CI gate: typecheck + typed-client lint — drift fails the build`

const RUNTIME_CODE = `import { app } from "./app"   // one app, defined once

// Bun
export default { port: 3000, fetch: app.fetch }

// Node            import { serve } from "@nifrajs/node"   → serve(app, { port: 3000 })
// Deno            import { serve } from "@nifrajs/deno"   → serve(app, { port: 3000 })

// Cloudflare Workers / Pages · Vercel edge
import { toFetchHandler } from "@nifrajs/core"
export default toFetchHandler(app)`

// The five UI adapters, shown as a CSS-only switcher: the SAME routes/loaders/actions/islands —
// only the adapter import changes. Real packages (@nifrajs/web-<fw>), so the swap is truthful.
const FW_TABS = [
  {
    key: "react",
    label: "React",
    code: `// The adapter is the one line that changes per framework:
import { reactAdapter } from "@nifrajs/web-react"
export default createWebApp({ adapter: reactAdapter, manifest, clientEntry })

// routes/hello.tsx — your page, written in React
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

// routes/hello.tsx — same page, Solid's fine-grained JSX
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

<!-- routes/hello.vue — same page, as a Vue SFC -->
<script setup lang="ts">defineProps<{ data: { name: string } }>()</script>
<template><h1>Hello {{ data.name }}</h1></template>`,
  },
  {
    key: "preact",
    label: "Preact",
    code: `// The adapter is the one line that changes per framework:
import { preactAdapter } from "@nifrajs/web-preact"
export default createWebApp({ adapter: preactAdapter, manifest, clientEntry })

// routes/hello.tsx — same page; Preact's 3 KB runtime, identical React API
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

<!-- routes/hello.svelte — same page, as a Svelte component -->
<script lang="ts">export let data: { name: string }</script>
<h1>Hello {data.name}</h1>`,
  },
] as const

// Runtime targets — the same app ships everywhere via Web-standard fetch.
const RUNTIME_CARDS = [
  { name: "Bun", note: "Native dev speed", deploy: "export default { fetch: app.fetch }" },
  { name: "Node", note: "Mature, everywhere", deploy: "serve(app, { port: 3000 })" },
  { name: "Deno", note: "Secure by default", deploy: "serve(app, { port: 3000 })" },
  { name: "Cloudflare", note: "Workers / Pages", deploy: "export default toFetchHandler(app)" },
  { name: "Vercel", note: "Edge functions", deploy: "export default toFetchHandler(app)" },
] as const

// One schema → five aligned outputs. The "single source of truth" story, as a small fan diagram.
const SOURCE_OUTPUTS = [
  { title: "Runtime validation", note: "Bad input → 400 before your handler" },
  { title: "TypeScript types", note: "Inferred params, body, response" },
  { title: "Typed client", note: "No codegen — drift is a compile error" },
  { title: "OpenAPI spec", note: "Generated, never hand-written" },
  { title: "MCP tools", note: "Agents read the live contract" },
] as const

const AGENT_LOOP = [
  {
    step: "01",
    command: "nifra_context",
    title: "Read the live app",
    body: "Routes, schemas, middleware, package versions, and project conventions in a compact payload.",
  },
  {
    step: "02",
    command: "nifra_scaffold",
    title: "Write in the right place",
    body: "URL patterns resolve to framework-correct files, handlers, loaders, and typed clients.",
  },
  {
    step: "03",
    command: "nifra_run",
    title: "Verify the behavior",
    body: "HTTP, SSR, WebSocket, and subprocess checks run against the current workspace.",
  },
  {
    step: "04",
    command: "nifra_check",
    title: "Block drift",
    body: "Typecheck, route-contract checks, and conservative fix suggestions before CI goes green.",
  },
] as const

const TIMELINE_STEPS = [
  {
    step: "01",
    pkg: "@nifrajs/schema",
    title: "Define the Data Contracts",
    body: "Model request inputs and response payloads with compiled validation. A single schema handles runtime validation, exports TypeScript types, and builds OpenAPI specifications automatically.",
    code: `import { t } from "@nifrajs/schema"

// A contract schema for your routes
export const GetUserSchema = {
  params: t.object({ id: t.string() }),
  response: t.object({
    id: t.string(),
    name: t.string(),
    role: t.union([t.literal("admin"), t.literal("user")])
  })
}`,
  },
  {
    step: "02",
    pkg: "@nifrajs/core",
    title: "Mount the Typed Router",
    body: "Implement the endpoint. Path parameters are automatically parsed from the literal path, and the incoming request body and query parameters are typechecked at the runtime boundary.",
    code: `import { server } from "@nifrajs/core"
import { GetUserSchema } from "./schema"

export const app = server()
  .get("/users/:id", GetUserSchema, (c) => {
    // c.params.id is typed as string
    return { id: c.params.id, name: "Ada", role: "admin" }
  })`,
  },
  {
    step: "03",
    pkg: "@nifrajs/client",
    title: "Call from Frontend (No-Codegen)",
    body: "Build the client using only the server's type signature. Autocomplete handles the paths, parameters, and payloads, while TypeScript ensures the frontend never goes out of sync with the backend.",
    code: `import { client } from "@nifrajs/client"
import type { app } from "./server"

const api = client<typeof app>("https://api.example.com")

// Typed call, autocompleted paths, compile-time checked
const res = await api.users({ id: "123" }).get()
if (res.ok) console.log(res.data.name)`,
  },
  {
    step: "04",
    pkg: "nifra mcp",
    title: "Feed AI Agents Live Context",
    body: "Coding agents write better code when they know the actual codebase rules. Nifra feeds Claude Code, Cursor, or Copilot your live routes and call signatures directly through a Model Context Protocol (MCP) server.",
    code: `# Run once to register the Nifra MCP server with Claude Code
$ claude mcp add nifra -- bunx nifra mcp

# Claude can now query:
# - nifra_context (live routes & schemas)
# - nifra_run (in-process verification)`,
  },
  {
    step: "05",
    pkg: "nifra check",
    title: "Enforce Seams in CI",
    body: "Block breaking changes from merging. The nifra linter analyzes client-server bindings and flags frontend-backend drift in a single command, keeping your pipeline green.",
    code: `# Run linter and typecheck in your GitHub actions
$ nifra check

# Fails CI if a route signature was changed on the backend
# but remains un-updated on the frontend client.`,
  },
]

const ECOSYSTEM_FEATURES = [
  {
    pkg: "@nifrajs/auth",
    title: "Session Authentication",
    badge: "Better-Auth",
    body: "First-class integration with Better-Auth. Preconfigured session middlewares, social logins, and typed roles.",
    code: `import { auth } from "@nifrajs/auth"\n\nexport const app = server()\n  .use(auth.session())\n  .get("/me", (c) => c.session.user)`,
  },
  {
    pkg: "@nifrajs/uploads",
    title: "Direct S3/R2 Uploads",
    badge: "Storage",
    body: "Secure direct-to-cloud file uploads. Generates signed URLs for S3, Cloudflare R2, or Backblaze without proxying heavy buffers.",
    code: `import { storage } from "@nifrajs/uploads"\n\nconst url = await storage.presign("avatars", {\n  key: "user-42.png",\n  maxSize: "5mb"\n})`,
  },
  {
    pkg: "@nifrajs/cron",
    title: "Cron & Background Tasks",
    badge: "Scheduler",
    body: "Define periodic cron tasks alongside HTTP handlers. Runs on serverless (Cloudflare triggers) and standalone Node/Bun.",
    code: `import { cron } from "@nifrajs/cron"\n\nexport const job = cron("0 0 * * *", async () => {\n  await db.sessions.deleteExpired()\n})`,
  },
  {
    pkg: "@nifrajs/otel",
    title: "OpenTelemetry Tracing",
    badge: "Observability",
    body: "Request tracing and custom spans. Export traces to Honeycomb, Datadog, or Grafana Tempo with zero complex boilerplates.",
    code: `import { otel } from "@nifrajs/otel"\n\nconst app = server()\n  .use(otel.trace({ serviceName: "nifra-api" }))`,
  },
  {
    pkg: "@nifrajs/env",
    title: "Safe Env Verification",
    badge: "Validation",
    body: "Verify environment variables at startup. Validates that API keys and configurations are present and correctly typed at boot.",
    code: `import { checkEnv } from "@nifrajs/env"\nimport { t } from "@nifrajs/schema"\n\nexport const env = checkEnv({\n  DATABASE_URL: t.string(),\n  PORT: t.number({ default: 3000 })\n})`,
  },
  {
    pkg: "@nifrajs/image",
    title: "Dynamic Image Optimizer",
    badge: "Media",
    body: "On-the-fly resizing, WebP/AVIF formatting, quality compression, and CDN caching to optimize LCP load priority.",
    code: `import { Image } from "@nifrajs/image"\n\n// optimized image component\n<Image src="/logo.png" width={800} height={400} priority />`,
  },
  {
    pkg: "@nifrajs/i18n",
    title: "Type-Safe i18n",
    badge: "Localization",
    body: "Dynamic pluralization and translations dictionary with automatic HTTP header language negotiation.",
    code: `import { i18n } from "@nifrajs/i18n"\n\nconst { t } = i18n(c.locale)\nreturn { msg: t("welcome", { name: "Ada" }) }`,
  },
  {
    pkg: "@nifrajs/content",
    title: "MDX Documents Parser",
    badge: "MDX Engine",
    body: "Read Markdown/MDX files, parse frontmatter, validate schemas, and compile them to interactive UI components.",
    code: `import { content } from "@nifrajs/content"\n\nconst posts = await content("posts")\n  .where({ status: "published" })\n  .all()`,
  },
  {
    pkg: "@nifrajs/islets",
    title: "Zero-JS Islands",
    badge: "Performance",
    body: "Static HTML pages with dynamic island scripts. Restores client interactivity without large JS hydration overhead.",
    code: `import { islet } from "@nifrajs/islets"\n\n// zero client runtime by default\nexport const hydrate = false\nexport const islandScripts = [counter]`,
  },
]

const max = (rows: ReadonlyArray<Record<string, number | string | boolean>>, key: string): number =>
  Math.max(...rows.map((r) => (typeof r[key] === "number" ? (r[key] as number) : 0)))

function Bar(props: { name: string; value: string; pct: number; you?: boolean }) {
  return (
    <div className={props.you ? "bar-row you" : "bar-row"}>
      <span className="bar-name">{props.name}</span>
      <span className="bar-track">
        <span className="bar-fill" style={{ width: `${Math.max(props.pct, 3)}%` }} />
      </span>
      <span className="bar-value">{props.value}</span>
    </div>
  )
}

function InstallWidget() {
  const command = "bun create nifra my-app"
  return (
    <button
      className="install-widget"
      type="button"
      data-copy-command={command}
      aria-label="Copy installation command"
    >
      <span className="prompt">$</span>
      <span className="command">{command}</span>
      <span className="copy-btn">
        <span className="copied-toast">Copied!</span>
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

function FrameworkSwitcher() {
  return (
    <div className="fw-switcher">
      {FW_TABS.map((tab, i) => (
        <input
          key={tab.key}
          type="radio"
          name="fw-switch"
          id={`fw-${tab.key}`}
          className="fw-radio"
          defaultChecked={i === 0}
        />
      ))}
      <div className="fw-tabs" role="tablist" aria-label="UI framework">
        {FW_TABS.map((tab) => (
          <label key={tab.key} htmlFor={`fw-${tab.key}`} className="fw-tab">
            {tab.label}
          </label>
        ))}
      </div>
      <div className="fw-panels">
        {FW_TABS.map((tab) => (
          <div key={tab.key} className={`fw-panel fw-panel-${tab.key}`}>
            <CodeBlock code={tab.code} lang="ts" />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Home() {
  const frontendMax = max(FRONTEND, "reqs")
  const httpMax = max(HTTP_BENCH, "reqs")
  return (
    <>
      <section id="hero" className="hero">
        <div className="hero-copy">
          <div className="hero-badge">
            <span className="badge-dot" />
            Agent-native framework · typed APIs · verified edits
          </div>
          <h1>
            The <em>AI-Native</em> TypeScript Framework.
          </h1>
          <p className="tagline">
            Nifra gives agents the live map they need: MCP context, route-aware scaffolds,
            self-verifying tools, and a <strong>no-codegen typed client</strong>. Start with a fast
            API, grow into SSR across React, Solid, Vue, Preact, or Svelte, and deploy on Bun, Node,
            Deno, or the edge.
          </p>
          <div className="hero-actions">
            <InstallWidget />
            <a className="button primary" href="/docs">
              Get started <span aria-hidden="true">→</span>
            </a>
            <a className="button ghost" href="/play">
              Try the playground
            </a>
          </div>
          <p className="hero-fineprint">
            No generated SDK. No stale route docs. No framework lock-in.
          </p>
        </div>
        <div className="agent-board">
          <div className="agent-board-head">
            <span className="agent-led" />
            <span>agent loop</span>
          </div>
          <div className="agent-board-grid">
            {AGENT_LOOP.map((item) => (
              <article className="agent-step" key={item.command}>
                <span className="agent-step-no">{item.step}</span>
                <div>
                  <code>{item.command}</code>
                  <h2>{item.title}</h2>
                  <p>{item.body}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* VALUE ROW — lead with the why */}
      <section className="value-row">
        <div className="value-item">
          <strong>Agents read your live API</strong>
          <span>
            An MCP server exposes your real routes and schemas to coding agents; a typed client lets
            them call those routes with full autocomplete.
          </span>
        </div>
        <div className="value-item">
          <strong>One schema, everything typed</strong>
          <span>
            A single schema produces runtime validation, the typed client, OpenAPI, and TypeScript
            types. Change a route and the frontend stops compiling until you update it.
          </span>
        </div>
        <div className="value-item">
          <strong>Ship to any runtime</strong>
          <span>
            The same app runs on Bun, Node, Deno, Cloudflare, and Vercel — switching targets is one
            line of adapter code.
          </span>
        </div>
      </section>

      {/* PROOF STRIP */}
      <section className="proof">
        {PROOF.map((p) => (
          <div className="proof-item" key={p.label}>
            <strong>{p.value}</strong>
            <span>{p.label}</span>
          </div>
        ))}
      </section>

      {/* FEATURE 1: AI-AGENT FIRST */}
      <section id="sec-agent" className="feature-showcase">
        <div className="feature-info">
          <span className="kicker">01 · Agent-Native</span>
          <h2>Your agent reads the live app, not stale documentation.</h2>
          <p>
            Run <code>nifra mcp</code> and point Claude Code or Cursor at it: an integrated MCP
            server plus a conventions file expose your project's live routes, schemas, examples, and
            drift checks, so the agent reads the real API surface directly.
          </p>
          <a href="/docs/cli" className="perf-link">
            Read about Agent MCP →
          </a>
        </div>
        <CodeBlock code={AGENT_CODE} lang="ts" />
      </section>

      {/* FEATURE 2: NO-CODEGEN CLIENT */}
      <section id="sec-client" className="feature-showcase reverse">
        <div className="feature-info">
          <span className="kicker">02 · Type-Safe Client</span>
          <h2>A client that makes API drift a compile error.</h2>
          <p>
            No code generators, no build steps, and no stale SDKs.{" "}
            <code>client&lt;typeof app&gt;</code> infers paths, parameters, request bodies, and
            responses directly from your server type. Any mismatch fails the build.
          </p>
          <a href="/docs/api" className="perf-link">
            Explore the Typed Client →
          </a>
        </div>
        <CodeBlock code={CLIENT_CODE} lang="ts" />
      </section>

      {/* FEATURE 3: MULTI-UI SSR — CSS-only framework switcher */}
      <section id="sec-frontend" className="feature-showcase">
        <div className="feature-info">
          <span className="kicker">03 · Unified Frontend</span>
          <h2>One full-stack engine. Five UI libraries.</h2>
          <p>
            React, Solid, Vue, Preact, and Svelte all sit on the same render engine. Loaders,
            actions, streaming, prefetching, and islands are identical across all five — switching
            is a single import. No meta-framework lock-in.
          </p>
          <a href="/docs/frameworks" className="perf-link">
            Compare the adapters →
          </a>
        </div>
        <FrameworkSwitcher />
      </section>

      {/* FEATURE 4: MULTI-RUNTIME */}
      <section id="sec-runtime" className="feature-showcase reverse">
        <div className="feature-info">
          <span className="kicker">04 · Multi-Runtime</span>
          <h2>Deploy anywhere. Bun, Node, Deno, or the Edge.</h2>
          <p>
            Nifra is built on Web-standard routing and fetch APIs. Run on Bun for blazing-fast
            development, then deploy to Node, Deno, Cloudflare Workers, or Vercel Edge with a single
            line of adapter code.
          </p>
          <a href="/docs/deployment" className="perf-link">
            View deployment targets →
          </a>
        </div>
        <CodeBlock code={RUNTIME_CODE} lang="ts" />
      </section>

      {/* RUNTIME GRID */}
      <section className="section runtime-section">
        <div className="runtime-grid">
          {RUNTIME_CARDS.map((r) => (
            <article className="runtime-tile" key={r.name}>
              <span className="runtime-tile-name">{r.name}</span>
              <span className="runtime-tile-note">{r.note}</span>
              <code className="runtime-tile-code">{r.deploy}</code>
            </article>
          ))}
        </div>
      </section>

      {/* FEATURE 5: HARDENED BACKEND */}
      <section id="sec-backend" className="feature-showcase">
        <div className="feature-info">
          <span className="kicker">05 · Hardened APIs</span>
          <h2>Production security built into the framework.</h2>
          <p>
            Zero-dependency middleware for security headers, cookies, CSRF, JWT authentication, rate
            limiting, CORS, and WebSocket topic pub/sub ships in the box. Compose it at the app or
            route boundary.
          </p>
          <a href="/docs/security" className="perf-link">
            View Middleware options →
          </a>
        </div>
        <CodeBlock code={BACKEND_CODE} lang="ts" />
      </section>

      {/* FEATURES ECOSYSTEM GRID SECTION */}
      <section id="sec-ecosystem" className="section">
        <div
          className="section-head"
          style={{ textAlign: "center", maxWidth: "760px", margin: "0 auto 48px" }}
        >
          <span className="kicker">Ecosystem Packages</span>
          <h2>A complete framework, batteries included.</h2>
          <p>
            Nifra isn't just a router—it's a modular suite of type-safe packages built for high
            performance, edge scalability, and robust developer ergonomics.
          </p>
          <p className="note" style={{ marginTop: 14 }}>
            Common combos: <code>auth</code> + <code>uploads</code> for user content ·{" "}
            <code>cron</code> + <code>otel</code> for observable background jobs · <code>env</code>{" "}
            + <code>i18n</code> + <code>content</code> for a localized site.
          </p>
        </div>

        <div className="ecosystem-grid">
          {ECOSYSTEM_FEATURES.map((f) => (
            <article className="ecosystem-card" key={f.pkg}>
              <div className="ecosystem-card-head">
                <code className="ecosystem-pkg">{f.pkg}</code>
                <span className="ecosystem-badge">{f.badge}</span>
              </div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
              <CodeBlock code={f.code} lang="ts" chrome={false} />
            </article>
          ))}
        </div>
      </section>

      {/* BENCHMARKS SECTION */}
      <section id="sec-benchmarks" className="section">
        <div
          className="section-head"
          style={{ textAlign: "center", maxWidth: "760px", margin: "0 auto 48px" }}
        >
          <span className="kicker">Performance &amp; Speed</span>
          <h2>Screamingly fast, frontend and backend.</h2>
          <p>
            Nifra runs close to raw Bun/Node speed. Full-stack SSR renders 3× to 22× faster than
            standard meta-frameworks on Node, while the backend router matches the fastest Node
            frameworks — tens of thousands of requests per second on a single core.
          </p>
        </div>

        <div className="bench-duo">
          <figure className="bench-card">
            <figcaption>
              <span className="bench-kicker">Full-stack SSR · req/s</span>
              <span className="bench-sub">
                Dynamic SSR rendering (Nifra on Node vs Meta-frameworks)
              </span>
            </figcaption>
            <div className="bars">
              {FRONTEND.slice(0, 6).map((r) => (
                <Bar
                  key={r.name}
                  name={r.name}
                  value={r.reqs.toLocaleString()}
                  pct={(r.reqs / frontendMax) * 100}
                  you={r.you}
                />
              ))}
            </div>
          </figure>

          <figure className="bench-card">
            <figcaption>
              <span className="bench-kicker">Node Frameworks · req/s</span>
              <span className="bench-sub">JSON GET /users/:id · Same machine throughput</span>
            </figcaption>
            <div className="bars">
              {HTTP_BENCH.map((r) => (
                <Bar
                  key={r.name}
                  name={r.name}
                  value={r.reqs.toLocaleString()}
                  pct={(r.reqs / httpMax) * 100}
                  you={r.you}
                />
              ))}
            </div>
          </figure>
        </div>
        <p className="note" style={{ textAlign: "center", marginTop: 24 }}>
          See detailed memory, cold-boot, and payload size metrics on the{" "}
          <a href="/benchmarks">benchmarks page</a>.
        </p>
      </section>

      {/* THE DEVELOPMENT LIFECYCLE TIMELINE */}
      <section id="sec-timeline" className="section timeline-section">
        <div
          className="section-head"
          style={{ textAlign: "center", maxWidth: "680px", margin: "0 auto 40px" }}
        >
          <span className="kicker">The Anti-Drift Lifecycle</span>
          <h2>One schema is the single source of truth.</h2>
          <p>
            Define a contract once. Nifra keeps validation, types, the typed client, OpenAPI, and
            your agents in sync with it across the stack.
          </p>
        </div>

        <div className="source-fan">
          <div className="source-core">
            <code>t.object(&#123;…&#125;)</code>
            <span>one schema</span>
          </div>
          <div className="source-outputs">
            {SOURCE_OUTPUTS.map((o) => (
              <div className="source-output" key={o.title}>
                <strong>{o.title}</strong>
                <span>{o.note}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="timeline">
          {TIMELINE_STEPS.map((s) => (
            <div className="timeline-step" key={s.step}>
              <div className="timeline-marker">{s.step}</div>
              <div className="timeline-info">
                <code className="package-badge">{s.pkg}</code>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
              <div className="timeline-code">
                <CodeBlock code={s.code} lang={s.step === "04" || s.step === "05" ? "sh" : "ts"} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CLOSING CTA */}
      <section id="sec-cta" className="cta">
        <span className="kicker">Ready when you are</span>
        <h2>Build something that survives the next AI edit.</h2>
        <p>
          One command scaffolds a typed Nifra app — start as a fast API, grow into full-stack SSR,
          and let your agents read the live contract instead of guessing.
        </p>
        <div className="hero-actions">
          <InstallWidget />
          <a className="button primary" href="/docs">
            Get started <span aria-hidden="true">→</span>
          </a>
          <a className="button ghost" href="/benchmarks">
            See the benchmarks
          </a>
        </div>
      </section>
    </>
  )
}

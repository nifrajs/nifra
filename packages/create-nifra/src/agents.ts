/**
 * Generate the `AGENTS.md` a scaffolded app ships with — the conventions file read by coding agents
 * (Claude Code, Cursor, …). It encodes nifra's non-obvious rules so an agent writes correct code from
 * the first prompt: validate at the boundary, the never-throwing client, `app.fetch` as the universal
 * entry, and (for full-stack apps) the one gotcha that bites everyone — never top-level-import
 * server-only code into a route module. Tailored per template so the paths + commands are real.
 */

import { agentsMcpSection } from "./agent-files.ts"
import type { AuthChoice } from "./auth.ts"
import type { Framework, TemplateName } from "./cli.ts"
import { DB_PRESETS, type DbChoice, type DbPreset } from "./db.ts"

const FRAMEWORK_LABEL: Readonly<Record<Framework, string>> = {
  react: "React",
  solid: "Solid",
  vue: "Vue",
  preact: "Preact",
  svelte: "Svelte",
}

/** Shared backend rules — every template is, at its core, a nifra `server()`. */
const API_RULES = `## The backend: \`server()\`

\`\`\`ts
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"

export const app = server()
  .get("/users/:id", { response: t.object({ id: t.string() }) }, (c) => ({ id: c.params.id }))
  .post(
    "/users",
    // body validates the input; response LOCKS the output shape (the contract).
    { body: t.object({ name: t.string() }), response: t.object({ id: t.string(), name: t.string() }) },
    (c) => {
      // c.body is VALIDATED + TYPED. Invalid input was already rejected with a 422 before this ran.
      return { id: crypto.randomUUID(), name: c.body.name }
    },
  )

export type App = typeof app
\`\`\`

Rules an agent must follow:

- **Validate every input at the boundary.** The route schema slots are \`{ body, query }\` (plus
  \`response\`, below) — use \`t\` from \`@nifrajs/schema\` (installed) or any Standard Schema (zod, valibot).
  Read the typed, already-validated \`c.body\` / \`c.query\` (invalid input was rejected with a 422 before the
  handler ran). **Never** hand-parse \`await c.req.json()\` and poke at properties — that's the bug class the
  schema exists to remove.
- **Path params are NOT a schema slot.** \`:id\` etc. are inferred from the path literal as \`string\` and
  read via \`c.params.id\`; there is no \`params\` (or \`headers\`) key in the route schema. Validate a param's
  shape inside the handler (a length/format check), not via \`{ params: ... }\` — that's a type error.
- **Lock the output shape with \`response\` (no drift).** Add \`{ response: t.object({...}) }\` to a route:
  the handler's return is type-checked against it, and the typed client sees exactly that shape. One
  contract, both sides — the frontend physically can't drift from the backend's output.
- **Data-or-error routes: set the status with \`c.set.status\`, then read the error off \`res.error\` (NOT \`res.data\`).**
  The typed client maps \`res.ok\` to the HTTP status. A route that does \`c.set.status = 404; return { ok: false,
  error: "not_found" }\` arrives at the client as \`res.ok === false\`, \`res.data === null\`, and the body on
  \`res.error\` (\`res.error.error === "not_found"\`). So branch on \`res.ok\` FIRST, then read \`res.data\` on success
  or \`res.error\` on failure — never assert a 4xx onto \`res.data\`. Declaring the error arm in \`response\`
  (\`t.union([Item, t.object({ ok: t.literal(false), error: t.string() })])\`) documents the shape and keeps the
  success \`res.data\` precise, but a 4xx still surfaces via \`res.error\`. Do NOT return a raw \`Response\` just to
  set an error status.
- **Raw \`Response\` is for redirects / streams / files** (\`Response.redirect(url, 302)\`, a file body, an
  SSE stream). The typed client infers \`res.data: never\` on such a route and \`nifra check\` emits a
  non-blocking \`response-route\` warning — both are EXPECTED there, not defects.
- **\`app.fetch(request)\` is the whole app** — \`(Request) => Response | Promise<Response>\`. Tests drive it
  directly (\`await app.fetch(new Request("http://x/users/1"))\`); no server needs to be running.
- **Don't reach for a heavy ORM/HTTP layer.** Routing, validation, cookies, and the typed client are
  built in. Parameterize DB queries; use \`timingSafeEqual\` (or WebCrypto) for secret comparison.
- **Cross-cutting concerns — use \`@nifrajs/middleware\`, don't hand-roll.** Rate limiting (\`429\` +
  \`Retry-After\`), CORS, security headers, body limits, auth (\`bearer\`/\`apiKey\`/\`basicAuth\`/\`jwt\`), CSRF,
  IP restriction, response caching, compression — all \`app.use(...)\` plugins in \`@nifrajs/middleware\`.
  Call \`nifra_docs("middleware")\` for the full list + usage before building one of these by hand.

## The client is typed + never throws — ALWAYS use it for internal API calls

\`\`\`ts
import { client } from "@nifrajs/client"
import type { app } from "./app"          // type-only import — server code never ships to the client

const api = client<typeof app>("https://api.example.com")
const res = await api.users({ id: "42" }).get()
if (res.ok) res.data            // typed from the route's return type — zero codegen
else res.error                  // errors are returned, never thrown
\`\`\`

**Never hand-roll \`fetch\` + ad-hoc response types for this app's own API** — that's exactly how a screen
drifts from the backend. \`client<typeof app>\` derives both the request inputs and \`res.data\` from the
route types, so \`tsc\` (and \`nifra build\`) catch any mismatch the moment a route changes. When building a
page that calls the API, reach for the client first.
`

/** File-routing + the server-only gotcha — only for full-stack (site/isr) templates. */
function webRules(framework: Framework): string {
  const label = FRAMEWORK_LABEL[framework]
  return `## The frontend: file routing + loaders (${label})

- Routes live in \`routes/\`. \`index.tsx\` → \`/\`, \`[id].tsx\` → \`/:id\`, \`_layout.tsx\` wraps a subtree,
  \`_404.tsx\` / \`_error.tsx\` are the fallbacks.
- A route file may export: \`default\` (the page component), \`loader\` (server-only data), \`action\`
  (server-only mutation), and \`meta\` (head tags). The \`loader\` returns data typed straight into the page.
- **The \`server()\` backend is IN-PROCESS, not a public HTTP surface.** Loaders/actions call it through
  \`ctx.api\` (the typed client — no network) during SSR; there is no \`GET /your-route\` endpoint on the page
  server to curl. Build features through loaders/actions + the typed client, not direct HTTP calls.
- Swap UI frameworks by changing one import (\`@nifrajs/web-${framework}\` → another adapter); your route,
  loader, and action code do not change.
- **Loaders \`throw redirect(url)\`, actions \`return redirect(url)\`.** Loader redirects abort the
  render server-side; action redirects return a response so client form submits get \`X-Nifra-Redirect\`
  and navigate without a full reload. Throwing in an action or returning in a loader is a silent bug
  that produces a false "operation failed" error on the client.

## ⚠️ The one rule that bites everyone: never import server-only code at a route's top level

A route module's \`loader\`/\`action\` run **only on the server**, but the module is **also bundled for the
browser** (for the component) — and the loader is *not* stripped. So a top-level
\`import db from "./db"\` (or anything touching \`process.env\`, secrets, \`node:\` APIs) ships server code to
the client and crashes hydration. Reach server resources through \`ctx.api\` / \`ctx.env\` (injected via
\`createWebApp\`) inside the loader instead — never as a top-level import in a \`routes/\` file.
`
}

/** Per-ORM body of the DB rules: the query idiom, schema location, and migrate story all differ. */
function dbRulesBody(orm: DbPreset["orm"]): string {
  if (orm === "prisma") {
    return `A Prisma data layer is wired: \`prisma/schema.prisma\` (a starter \`Note\` model) + \`db/index.ts\` (a
singleton \`PrismaClient\`).

- **Wire it into the backend once**, then read \`c.db\` in handlers:
  \`\`\`ts
  import { server } from "@nifrajs/core"
  import { t } from "@nifrajs/schema"
  import { db } from "./db"

  export const app = server()
    .decorate("db", db)
    .get("/notes", async (c) => c.db.note.findMany({ where: { deletedAt: null } }))
    .post("/notes", { body: t.object({ title: t.string({ minLength: 1 }) }) }, async (c) =>
      c.db.note.create({ data: { title: c.body.title } }),
    )
  \`\`\`
- **Migrations:** edit \`prisma/schema.prisma\`, then \`bun run db:migrate\` (\`prisma migrate dev\` — creates +
  applies the migration and regenerates the client). \`bun run db:studio\` opens a DB browser.`
  }
  if (orm === "kysely") {
    return `A Kysely typed query builder is wired in \`db/\`: \`db/schema.ts\` (the DB-shape interface — keep it in
sync with your migrations) + \`db/index.ts\` (the typed client). You own the migrations (\`db/migrations/\`,
run by \`db/migrate.ts\`).

- **Wire it into the backend once**, then read \`c.db\` in handlers:
  \`\`\`ts
  import { server } from "@nifrajs/core"
  import { t } from "@nifrajs/schema"
  import { db } from "./db"

  export const app = server()
    .decorate("db", db)
    .get("/notes", async (c) =>
      c.db.selectFrom("notes").selectAll().where("deleted_at", "is", null).execute())
    .post("/notes", { body: t.object({ title: t.string({ minLength: 1 }) }) }, async (c) =>
      c.db.insertInto("notes").values({ title: c.body.title }).returningAll().executeTakeFirstOrThrow())
  \`\`\`
- **Migrations:** add a file to \`db/migrations/\` (copy the \`0001_create_notes.ts\` shape), update the
  \`db/schema.ts\` interface to match, then \`bun run db:migrate\`.`
  }
  return `A Drizzle data layer is wired in \`db/\`: \`db/schema.ts\` (a starter \`notes\` table) + \`db/index.ts\` (the
typed client).

- **Wire it into the backend once**, then read \`c.db\` in handlers:
  \`\`\`ts
  import { server } from "@nifrajs/core"
  import { t } from "@nifrajs/schema"
  import { db, notes } from "./db"

  export const app = server()
    .decorate("db", db)
    .get("/notes", async (c) => c.db.select().from(notes))
    .post("/notes", { body: t.object({ title: t.string({ minLength: 1 }) }) }, async (c) =>
      (await c.db.insert(notes).values({ title: c.body.title }).returning())[0],
    )
  \`\`\`
- **Migrations:** edit \`db/schema.ts\`, then \`bun run db:generate\` (writes SQL to \`db/migrations\`) +
  \`bun run db:migrate\` (applies it). \`bun run db:studio\` opens a DB browser.`
}

/** DB rules — only when scaffolded with `--db`. Teaches the wired data layer + the `c.db` seam. */
function dbRules(db: DbChoice): string {
  const p = DB_PRESETS[db]
  return `## Database (${p.label})

${dbRulesBody(p.orm)} ${p.note}

- **Query is fully typed** — types flow from the schema/model; \`c.db\` is typed end to end.
- **Never top-level-import \`db\` into a \`routes/\` page file** — it's server-only; reach it via \`c.db\` on
  the backend (or \`ctx.api\` from a loader). A top-level import ships it to the browser and breaks the build.`
}

/** Auth rules — only when scaffolded with `--auth`. Teaches the better-auth mount + the typed guards. */
function authRules(_auth: AuthChoice): string {
  return `## Authentication (better-auth)

better-auth is configured in \`auth.ts\` (email/password + sessions, backed by your scaffolded database via
its ORM adapter). nifra mounts it and gives you typed session guards via \`@nifrajs/better-auth\`.

- **Mount it once** on the backend — it serves every auth endpoint under \`/api/auth/*\`:
  \`\`\`ts
  import { server } from "@nifrajs/core"
  import { betterAuth } from "@nifrajs/better-auth"
  import { auth } from "./auth"
  export const app = server().use(betterAuth(auth))
  \`\`\`
- **Generate the auth tables** once, and after changing the config: \`bunx @better-auth/cli@latest generate\`
  writes them into your schema (\`db/schema.ts\` for Drizzle, \`prisma/schema.prisma\` for Prisma); then
  \`bun run db:migrate\`.
- **Read / require a session** with the typed guards (pass the raw \`Request\` — \`c.req\` in a handler, or a
  loader's \`request\`):
  \`\`\`ts
  import { getSession, requireSession } from "@nifrajs/better-auth"
  app.get("/me", async (c) => (await getSession(auth, c.req))?.user ?? null)
  app.get("/account", async (c) => {
    const { user } = await requireSession(auth, c.req) // throws a 401 Response when signed out
    return { id: user.id }
  })
  \`\`\`
- \`auth\` is **server-only** — never import it into a \`routes/\` page, and keep \`BETTER_AUTH_SECRET\` in \`.env\`.`
}

const SECURITY_RULES = `## Production defaults (don't ship the happy path only)

- **Dependencies: install current, never pin from memory.** Your training data lags npm by months — do
  not hand-write a version range or reach for a remembered (often deprecated or vulnerable) API. Add a
  dependency with \`bun add <pkg>\` so it resolves the **latest stable**, then use *that* version's API —
  if unsure of a signature, read \`node_modules/<pkg>\`'s types or run \`bun pm view <pkg> version\`, don't
  guess. Never **downgrade** versions already in \`package.json\` (especially the pinned \`@nifrajs/*\` ones).
- Validate at every trust boundary (above). Reject unknown fields and out-of-range values.
- Constant-time comparison for secrets/tokens/HMACs (\`timingSafeEqual\` or WebCrypto), never \`===\`.
- Verify ownership/permission on any resource a handler reads or mutates — auth'd ≠ authorized.
- Idempotency on retryable side effects (webhooks, payments): short-circuit on a repeated key.
- Money in integer minor units; timestamps as UTC; parse client dates at the boundary.
- No secrets/PII in logs or error responses.
`

const COMMANDS: Readonly<Record<TemplateName, string>> = {
  api: `- \`bun install\` — install dependencies
- \`bun run dev\` — run the API (watch mode)
- \`bun test\` — drive \`app.fetch\` directly; no server required
- \`nifra check\` — typecheck + typed-client lint (run before you call work done)`,
  site: `- \`bun install\` — install dependencies
- \`nifra dev\` — true-HMR dev server
- \`nifra build\` — content-hashed client bundle + manifest (local build)
- \`nifra start\` — serve the built app (SSR) — pairs with \`nifra build\`
- \`nifra check\` — typecheck + typed-client lint (run before you call work done)

  For a local production run use \`nifra build && nifra start\` (or \`bun run build:bun && bun run start\`). NOTE:
  the bare \`bun run build\` script targets **Cloudflare Pages for DEPLOY** (emits \`dist/\`, a different layout)
  — it does NOT pair with \`nifra start\`/\`bun run start\` (which serve \`dist-bun/\`). Don't mix the two.`,
  isr: `- \`bun install\` — install dependencies
- \`nifra dev\` — true-HMR dev server
- \`nifra build\` — content-hashed client bundle + manifest (local build)
- \`nifra start\` — serve the built app (SSR + ISR cache) — pairs with \`nifra build\`
- \`nifra check\` — typecheck + typed-client lint (run before you call work done)

  For a local production run use \`nifra build && nifra start\`. NOTE: the bare \`bun run build\` script targets
  **Cloudflare Pages for DEPLOY** (\`dist/\`) and does NOT pair with \`nifra start\` — don't mix the two.`,
  fullstack: `- \`bun install\` — install dependencies
- \`bun run dev\` — run the API (watch mode); \`src/index.ts\` also starts the job worker (\`queue.start()\`)
- \`bun test\` — drives \`app.fetch\` directly (pagination, jobs via \`queue.drain()\`, cache, storage); no server required
- \`bun run typecheck\` — run before you call work done

  Wired: cursor pagination (\`t.pageQuery\`/\`t.paginated\`/\`paginate\`), background jobs (\`@nifrajs/jobs\`),
  a TTL cache (\`@nifrajs/cache\`), blob storage (\`@nifrajs/storage\`). Swap the in-memory \`notes\` store for
  your DB, and the memory cache/job/storage adapters for shared ones (Redis / CF KV / R2) when multi-process.`,
}

/** The agent's stop condition — what makes the anti-drift guarantees actually fire. */
const DONE = `## Definition of done — run \`nifra check\`

Before considering any change complete, run **\`nifra check\`**. It (1) typechecks — the frontend↔backend
contract is compiler-enforced, so the typed client deriving \`res.data\` from your routes turns any
mismatch into an error; (2) flags any hand-rolled \`fetch()\` to this app's own API (which bypasses that
check); and (3) flags a server-only import (a DB driver, \`node:\`/\`bun:\`, \`./db\`) at the top level of a
\`routes/\` page — that ships server code to the browser. Use \`nifra check --json\` for machine-readable
diagnostics. A failing \`nifra check\` means the work isn't done — fix it, don't ship around it.`

export interface AgentsMdOptions {
  readonly template: TemplateName
  readonly framework: Framework
  readonly name: string
  /** Drizzle preset, when scaffolded with `--db` — adds a Database section. */
  readonly db?: DbChoice
  /** Auth preset, when scaffolded with `--auth` — adds an Authentication section. */
  readonly auth?: AuthChoice
}

/** Build the full `AGENTS.md` for a freshly scaffolded app. */
export function agentsMd(opts: AgentsMdOptions): string {
  const isWeb = opts.template === "site" || opts.template === "isr"
  const what = isWeb
    ? `a full-stack nifra app — a typed \`server()\` backend plus file-routed, server-rendered ${FRAMEWORK_LABEL[opts.framework]} pages`
    : `a nifra API — a typed, contract-first \`server()\` backend`

  // Each entry is a self-contained markdown block; join with a blank line between blocks. The web-rules
  // block is empty for API templates — dropped before joining so there's no doubled blank line.
  const blocks = [
    `# AGENTS.md — ${opts.name}\n\nGuidance for AI coding agents working in this repo. This is ${what}. nifra is Bun-native, Web-standard, and framework-agnostic; the same app runs on Bun, Node, Deno, and the edge.`,
    `## Commands\n\n${COMMANDS[opts.template]}`,
    // Surface the MCP early — an agent that learns the typechecked tools exist (and that `nifra check`
    // is the done-gate) up front will reach for them instead of writing nifra from stale memory.
    agentsMcpSection(),
    API_RULES.trim(),
    opts.db !== undefined ? dbRules(opts.db) : "",
    opts.auth !== undefined ? authRules(opts.auth) : "",
    isWeb ? webRules(opts.framework).trim() : "",
    SECURITY_RULES.trim(),
    DONE,
    "## Full reference\n\nThe complete, machine-readable API + docs live in **`llms-full.txt`** (served at the nifra site root). When you need an exact signature or a feature you haven't used, read that rather than guessing — it inlines every doc page and the export index.",
  ]
  return `${blocks.filter(Boolean).join("\n\n")}\n`
}

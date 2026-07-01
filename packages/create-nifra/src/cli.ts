#!/usr/bin/env node
/**
 * Scaffold a new nifra app:  `bun create nifra <directory>`  (or `npm create nifra <dir>`).
 *
 *   bun create nifra my-app                      # api backend (default)
 *   bun create nifra my-app --template site      # multi-target SSR site
 *   bun create nifra my-app --template fullstack # api + jobs + cache + storage + cursor pagination
 *   bun create nifra my-app --deploy vercel      # site, with Vercel as the default deploy target
 *
 * Copies the bundled template, restores `.gitignore` (npm strips a literal one from packages), sets the
 * app's `package.json` name, and — with `--deploy <target>` (site template only) — repoints the default
 * `build`/`deploy` scripts at that target and fills the project name into its config. Refuses to overwrite.
 */
import { realpathSync } from "node:fs"
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  CLAUDE_MD_PATH,
  CURSOR_MCP_JSON_PATH,
  claudeMd,
  MCP_JSON_PATH,
  mcpJson,
} from "./agent-files.ts"
import { agentsMd } from "./agents.ts"
import {
  AUTH_CHOICES,
  AUTH_PRESETS,
  type AuthChoice,
  assertAuthableDb,
  writeAuthFiles,
} from "./auth.ts"
import { DB_CHOICES, DB_PRESETS, type DbChoice, writeDbFiles } from "./db.ts"

const TEMPLATES = {
  api: "../template",
  site: "../template-site",
  isr: "../template-isr",
  fullstack: "../template-fullstack",
} as const
export type TemplateName = keyof typeof TEMPLATES

/** Frontend frameworks the `site` template can scaffold. React is the default (`template-site`); the
 * rest live in `template-site-<framework>` siblings — same multi-target deploy story, different adapter
 * + routes. */
const FRAMEWORKS = ["react", "preact", "vue", "solid", "svelte"] as const
export type Framework = (typeof FRAMEWORKS)[number]

/**
 * Deploy targets for the multi-target `site` template. Every target's build + server entry already ships
 * in the template; choosing one repoints the canonical `build`/`deploy` scripts at it (the per-target
 * `build:*` scripts stay, so you can still switch). nifra never runs the deploy or enters credentials —
 * `deploy` shells out to the vendor CLI you've authed yourself.
 */
interface DeployPreset {
  readonly label: string
  readonly build: string
  /** `deploy` script; `NAME` is replaced with the app directory name. */
  readonly deploy: string
  readonly steps: readonly string[]
}
const DEPLOY: Record<string, DeployPreset> = {
  bun: {
    label: "Bun",
    build: "bun run build-bun.ts",
    deploy: "bun run start",
    steps: ["bun run build", "bun run start        # serves on $PORT (default 3000), any host"],
  },
  node: {
    label: "Node (Docker)",
    build: "bun run build-node.ts",
    deploy: "docker build -t NAME . && docker run -p 3000:3000 NAME",
    steps: ["bun run build", "bun run deploy       # docker build + run (or `bun run start:node`)"],
  },
  deno: {
    label: "Deno Deploy",
    build: "bun run build-deno.ts",
    deploy: "deployctl deploy --prod --entrypoint=dist-deno/server-deno.js",
    steps: [
      "bun run build",
      "bun run deploy       # deployctl (install: deno install -A jsr:@deno/deployctl)",
    ],
  },
  "cf-pages": {
    label: "Cloudflare Pages",
    build: "bun run build.ts",
    deploy: "wrangler pages deploy dist",
    steps: ["bun run build", "bun run deploy       # wrangler pages deploy dist"],
  },
  vercel: {
    label: "Vercel Edge",
    build: "bun run build-vercel.ts",
    deploy: "vercel deploy --prebuilt",
    steps: ["bun run build", "bun run deploy       # vercel deploy --prebuilt"],
  },
}

// Self-hosted servers (bun/node) have no canonical push-to-deploy — CI builds + uploads the artifact and
// leaves a host-specific placeholder. The managed targets use the vendor's official action/CLI.
const SELF_HOSTED_STEP = (hint: string): string =>
  `      # Self-hosted: deploy is host-specific. The build output is in dist*/ — add your step here
      # (${hint}). Until then, CI builds on every push and uploads the bundle as an artifact.
      - name: Upload build
        if: github.ref == 'refs/heads/main'
        uses: actions/upload-artifact@v4
        with:
          name: build
          path: dist*`

/** The GitHub Actions deploy step + required secrets + permissions, per deploy target. */
interface CiDeploy {
  /** Lines under the workflow's top-level `permissions:` (2-space indented). */
  readonly permissions: string
  /** Repository secrets the deploy needs — listed in a header comment so the user knows what to set. */
  readonly secrets: readonly string[]
  /** YAML for the deploy step(s), indented to sit under `steps:` (`NAME` → the app name). */
  readonly step: string
}
const CI_DEPLOY: Record<string, CiDeploy> = {
  bun: {
    permissions: "  contents: read",
    secrets: [],
    step: SELF_HOSTED_STEP("flyctl deploy, an SSH/rsync to a VM, a container push, …"),
  },
  node: {
    permissions: "  contents: read",
    secrets: [],
    step: SELF_HOSTED_STEP("the template ships a Dockerfile — push to a registry, or flyctl/SSH"),
  },
  deno: {
    // OIDC: link the repo in the Deno Deploy dashboard (no token needed) — needs id-token: write.
    permissions: "  contents: read\n  id-token: write",
    secrets: [],
    step: `      - name: Publish to Deno Deploy
        if: github.ref == 'refs/heads/main'
        uses: denoland/deployctl@v1
        with:
          project: NAME
          entrypoint: dist-deno/server-deno.js`,
  },
  "cf-pages": {
    permissions: "  contents: read",
    secrets: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    step: `      - name: Publish to Cloudflare Pages
        if: github.ref == 'refs/heads/main'
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy dist --project-name=NAME`,
  },
  vercel: {
    permissions: "  contents: read",
    secrets: ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"],
    step: `      - name: Publish to Vercel
        if: github.ref == 'refs/heads/main'
        run: bunx vercel deploy --prebuilt --prod --token="$VERCEL_TOKEN"
        env:
          VERCEL_TOKEN: \${{ secrets.VERCEL_TOKEN }}
          VERCEL_ORG_ID: \${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: \${{ secrets.VERCEL_PROJECT_ID }}`,
  },
}

/**
 * Build a GitHub Actions workflow that builds on every push/PR and deploys `target` on a push to `main`.
 * Reuses the canonical `bun run build` (the deploy preset repoints it), then runs the target's official
 * deploy mechanism. Exported for unit tests. Throws on an unknown target.
 */
export function githubDeployWorkflow(target: string, appName: string): string {
  const ci = CI_DEPLOY[target]
  if (ci === undefined) {
    throw new Error(`no CI workflow for deploy target "${target}"`)
  }
  const header =
    ci.secrets.length > 0
      ? `# Set these repository secrets (Settings → Secrets and variables → Actions):\n${ci.secrets
          .map((s) => `#   ${s}`)
          .join("\n")}\n`
      : "# No deploy secrets required (see the deploy step below).\n"
  return `${header}name: Deploy
on:
  push:
    branches: [main]
  pull_request:
permissions:
${ci.permissions}
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run build
${ci.step.replaceAll("NAME", appName)}
`
}

export interface ScaffoldOptions {
  /** Destination directory. */
  readonly target: string
  /** Template to copy. Default `"api"`. */
  readonly template?: TemplateName
  /** Frontend framework (site template only). Default `"react"`. */
  readonly framework?: string
  /** Deploy target (site template only) — repoints the default `build`/`deploy` scripts. */
  readonly deploy?: string
  /** Emit a CI deploy workflow for the chosen `--deploy` target. Only `"github"` today. */
  readonly ci?: string
  /** Wire a data layer: `drizzle-{libsql,postgres,sqlite}` | `prisma-{postgres,sqlite}` | `kysely-postgres`. */
  readonly db?: string
  /** Wire authentication: `better-auth` (requires `--db` — auth needs a database). */
  readonly auth?: string
  /** Allow scaffolding into a non-empty directory (copies template, overwrites collisions). */
  readonly force?: boolean
  /** Path to a local nifra monorepo — replaces `@nifrajs/*` semver deps with `file:` refs so
   *  the app runs against the local source before the packages are published to npm. */
  readonly link?: string
}

export interface ScaffoldResult {
  readonly name: string
  readonly template: TemplateName
  readonly framework?: Framework
  readonly deploy?: DeployPreset
  /** The CI provider a workflow was generated for, when `--ci` was passed. */
  readonly ci?: "github"
  /** Repo secrets the generated workflow needs (for the next-steps message). */
  readonly ciSecrets?: readonly string[]
  /** The Drizzle preset wired in, when `--db` was passed. */
  readonly db?: DbChoice
  /** The auth preset wired in, when `--auth` was passed. */
  readonly auth?: AuthChoice
  /** Local nifra monorepo path when `--link` was used; undefined when using published packages. */
  readonly link?: string
}

/**
 * Copy a template into `target` and finalize it (gitignore rename, package name, optional deploy preset).
 * Throws on: unknown template, `--deploy` with a non-site template, unknown deploy target, or an existing
 * destination. Pure enough to unit-test (no argv, no process.exit).
 */
export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const template = opts.template ?? "api"
  if (TEMPLATES[template] === undefined) {
    throw new Error(`unknown template "${template}". options: ${Object.keys(TEMPLATES).join(", ")}`)
  }
  // Framework picker (site only): non-React frameworks live in `template-site-<framework>`.
  let framework: Framework | undefined
  if (opts.framework !== undefined) {
    if (template !== "site") {
      throw new Error(`--framework requires the site template (got "${template}")`)
    }
    if (!FRAMEWORKS.includes(opts.framework as Framework)) {
      throw new Error(`unknown framework "${opts.framework}". options: ${FRAMEWORKS.join(", ")}`)
    }
    framework = opts.framework as Framework
  }
  const templateRel =
    template === "site" && framework !== undefined && framework !== "react"
      ? `../template-site-${framework}`
      : TEMPLATES[template]

  let preset: DeployPreset | undefined
  if (opts.deploy !== undefined) {
    if (template !== "site") {
      throw new Error(`--deploy requires the site template (got "${template}")`)
    }
    preset = DEPLOY[opts.deploy]
    if (preset === undefined) {
      throw new Error(
        `unknown deploy target "${opts.deploy}". options: ${Object.keys(DEPLOY).join(", ")}`,
      )
    }
  }

  if (opts.ci !== undefined) {
    if (opts.ci !== "github") throw new Error(`unknown --ci "${opts.ci}". options: github`)
    if (preset === undefined) {
      throw new Error("--ci requires --deploy <target> (the workflow deploys that target)")
    }
  }

  // DB preset (any template — an API or a site can both want persistence).
  let db: DbChoice | undefined
  if (opts.db !== undefined) {
    if (!DB_CHOICES.includes(opts.db as DbChoice)) {
      throw new Error(`unknown --db "${opts.db}". options: ${DB_CHOICES.join(", ")}`)
    }
    db = opts.db as DbChoice
  }

  // Auth preset — needs a database, so it requires `--db` (the auth tables live in your Drizzle DB).
  let auth: AuthChoice | undefined
  if (opts.auth !== undefined) {
    if (!AUTH_CHOICES.includes(opts.auth as AuthChoice)) {
      throw new Error(`unknown --auth "${opts.auth}". options: ${AUTH_CHOICES.join(", ")}`)
    }
    if (db === undefined) {
      throw new Error(
        "--auth requires --db (better-auth needs a database; e.g. --db drizzle-libsql)",
      )
    }
    assertAuthableDb(db) // reject --auth + an ORM with no drop-in better-auth adapter (e.g. Kysely)
    auth = opts.auth as AuthChoice
  }

  const templateDir = fileURLToPath(new URL(templateRel, import.meta.url))
  // Default: errorOnExist + force:false → reject rather than clobber an existing directory.
  // --force: allow overwriting an existing destination (needed for `bun create nifra .`).
  await cp(templateDir, opts.target, {
    recursive: true,
    ...(opts.force ? { force: true } : { errorOnExist: true, force: false }),
  })

  // The template ships its ignore file as `gitignore` (npm strips a literal `.gitignore`); restore the dot.
  try {
    await rename(join(opts.target, "gitignore"), join(opts.target, ".gitignore"))
  } catch {
    // A template without a `gitignore` — nothing to restore.
  }

  const name = basename(opts.target)
  const pkgPath = join(opts.target, "package.json")
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
    name?: string
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  pkg.name = name
  if (preset !== undefined) {
    // Multi-target stays intact (build:*, deploy:* scripts); just point the canonical aliases at the pick.
    pkg.scripts = { ...(pkg.scripts ?? {}) }
    pkg.scripts.build = preset.build
    pkg.scripts.deploy = preset.deploy.replaceAll("NAME", name)
  }
  if (db !== undefined) {
    // Merge the Drizzle preset's deps + db:* scripts; `bun install` then resolves them.
    const dbp = DB_PRESETS[db]
    pkg.dependencies = { ...(pkg.dependencies ?? {}), ...dbp.deps }
    pkg.devDependencies = { ...(pkg.devDependencies ?? {}), ...dbp.devDeps }
    pkg.scripts = { ...(pkg.scripts ?? {}), ...dbp.scripts }
  }
  if (auth !== undefined) {
    pkg.dependencies = { ...(pkg.dependencies ?? {}), ...AUTH_PRESETS[auth].deps }
  }
  // --link: replace @nifrajs/* semver refs with file: paths pointing at the local monorepo's packages/
  // directory — lets an app consume nifra from a sibling repo before the packages are published.
  if (opts.link !== undefined) {
    const linkPackages = resolve(opts.link, "packages")
    const targetAbs = resolve(opts.target)
    for (const section of ["dependencies", "devDependencies"] as const) {
      const deps = pkg[section]
      if (deps === undefined) continue
      for (const dep of Object.keys(deps)) {
        if (!dep.startsWith("@nifrajs/")) continue
        const pkgDir = join(linkPackages, dep.slice("@nifrajs/".length))
        if (await Bun.file(join(pkgDir, "package.json")).exists()) {
          deps[dep] = `file:${relative(targetAbs, pkgDir)}`
        }
      }
    }
  }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

  // Ship agent guidance so a coding agent (Claude Code, Cursor, …) writes correct nifra code from the
  // first prompt — the conventions + the gotchas, tailored to this template.
  await writeFile(
    join(opts.target, "AGENTS.md"),
    agentsMd({
      template,
      framework: framework ?? "react",
      name,
      ...(db !== undefined ? { db } : {}),
      ...(auth !== undefined ? { auth } : {}),
    }),
  )

  // Register the project's nifra MCP server so a coding agent auto-discovers it. Claude Code reads
  // `.mcp.json` + `CLAUDE.md`; Cursor reads `.cursor/mcp.json`. All three come from one canonical config
  // (agent-files.ts) so they can't drift. CLAUDE.md is a short MCP-first preamble that `@AGENTS.md`-imports
  // the full cookbook rather than duplicating it.
  await writeFile(join(opts.target, MCP_JSON_PATH), mcpJson())
  await writeFile(join(opts.target, CLAUDE_MD_PATH), claudeMd())
  await mkdir(join(opts.target, ".cursor"), { recursive: true })
  await writeFile(join(opts.target, CURSOR_MCP_JSON_PATH), mcpJson())

  // Wire the Drizzle data layer (db/ module + drizzle.config + .env.example + gitignore entries).
  if (db !== undefined) await writeDbFiles(opts.target, db)
  // Wire auth AFTER the DB (it appends to the .env.example the DB preset wrote; --auth requires --db).
  if (auth !== undefined && db !== undefined) await writeAuthFiles(opts.target, auth, db)

  // Fill the project name into the site template's wrangler config (CF Pages project name).
  if (template === "site") {
    const wranglerPath = join(opts.target, "wrangler.toml")
    try {
      const toml = await readFile(wranglerPath, "utf8")
      await writeFile(wranglerPath, toml.replace(/^name = ".*"$/m, `name = "${name}"`))
    } catch {
      // No wrangler.toml — skip the name fill.
    }
  }

  // Emit a CI deploy workflow for the chosen target (validated above to require a deploy preset).
  let ciResult: { ci: "github"; ciSecrets: readonly string[] } | undefined
  if (opts.ci === "github" && opts.deploy !== undefined) {
    const workflowsDir = join(opts.target, ".github", "workflows")
    await mkdir(workflowsDir, { recursive: true })
    await writeFile(join(workflowsDir, "deploy.yml"), githubDeployWorkflow(opts.deploy, name))
    ciResult = { ci: "github", ciSecrets: CI_DEPLOY[opts.deploy]?.secrets ?? [] }
  }

  return {
    name,
    template,
    ...(framework !== undefined ? { framework } : {}),
    ...(preset !== undefined ? { deploy: preset } : {}),
    ...(ciResult !== undefined ? ciResult : {}),
    ...(db !== undefined ? { db } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(opts.link !== undefined ? { link: opts.link } : {}),
  }
}

interface ParsedArgs {
  readonly target?: string
  readonly template?: TemplateName
  readonly framework?: string
  readonly deploy?: string
  readonly ci?: string
  readonly db?: string
  readonly auth?: string
  readonly force?: boolean
  readonly link?: string
}

/** Parse `[dir] [--template|-t <t>] [--framework|-f <fw>] [--deploy|-d <target>] [--ci|-c github]
 *  [--db <preset>] [--auth <preset>] [--force] [--link <path>]`.
 * `--framework`/`--deploy`/`--ci` all default the template to `site`. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const rest = [...argv]
  const take = (...flags: string[]): string | undefined => {
    const i = rest.findIndex((a) => flags.includes(a))
    if (i === -1) return undefined
    const value = rest[i + 1]
    rest.splice(i, 2)
    return value
  }
  const hasFlag = (...flags: string[]): boolean => {
    const i = rest.findIndex((a) => flags.includes(a))
    if (i === -1) return false
    rest.splice(i, 1)
    return true
  }
  const templateFlag = take("--template", "-t")
  const framework = take("--framework", "-f")
  const deploy = take("--deploy", "-d")
  const ci = take("--ci", "-c")
  const db = take("--db")
  const auth = take("--auth")
  const link = take("--link")
  const force = hasFlag("--force")
  const target = rest.find((a) => !a.startsWith("-"))
  // `--framework`/`--deploy`/`--ci` imply the multi-target site template unless one was named explicitly.
  const template = (templateFlag ??
    (framework !== undefined || deploy !== undefined || ci !== undefined ? "site" : undefined)) as
    | TemplateName
    | undefined
  return {
    ...(target !== undefined ? { target } : {}),
    ...(template !== undefined ? { template } : {}),
    ...(framework !== undefined ? { framework } : {}),
    ...(deploy !== undefined ? { deploy } : {}),
    ...(ci !== undefined ? { ci } : {}),
    ...(db !== undefined ? { db } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(link !== undefined ? { link } : {}),
    ...(force ? { force } : {}),
  }
}

const USAGE = `usage: bun create nifra <directory> [--template api|site|isr|fullstack] [--framework react|preact|vue|solid|svelte] [--deploy bun|node|deno|cf-pages|vercel] [--ci github] [--db ${DB_CHOICES.join("|")}] [--auth ${AUTH_CHOICES.join("|")}] [--force] [--link <path-to-nifra-repo>]`

/**
 * Run the CLI for `argv` and return the exit code + the message to print — no `process.exit`, `console`,
 * or `process.argv`, so the whole flow (parse → scaffold → next-steps) is unit-testable in-process.
 */
export async function run(argv: readonly string[]): Promise<{ code: 0 | 1; message: string }> {
  const { target, template, framework, deploy, ci, db, auth, force, link } = parseArgs(argv)
  if (target === undefined) return { code: 1, message: USAGE }

  let result: ScaffoldResult
  try {
    result = await scaffold({
      target,
      ...(template !== undefined ? { template } : {}),
      ...(framework !== undefined ? { framework } : {}),
      ...(deploy !== undefined ? { deploy } : {}),
      ...(ci !== undefined ? { ci } : {}),
      ...(db !== undefined ? { db } : {}),
      ...(auth !== undefined ? { auth } : {}),
      ...(force ? { force } : {}),
      ...(link !== undefined ? { link } : {}),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // A copy failure is almost always "destination exists" — say so plainly.
    const friendly = /exist/i.test(msg)
      ? `refusing to scaffold: "${target}" already exists. Use --force to overwrite.`
      : msg
    return { code: 1, message: `✗ ${friendly}` }
  }

  const steps: string[] = [`cd ${target}`, "bun install", "bun run dev"]
  if (result.ci !== undefined) {
    // CI deploys on push — surface the workflow + the secrets to set first.
    steps[2] = "bun run dev          # local preview"
    if (result.ciSecrets !== undefined && result.ciSecrets.length > 0) {
      steps.push(`# set repo secrets: ${result.ciSecrets.join(", ")}`)
    }
    steps.push(
      "git push             # CI builds + deploys on push to main (.github/workflows/deploy.yml)",
    )
  } else if (result.deploy !== undefined) {
    steps[2] = "bun run dev          # local preview"
    steps.push(...result.deploy.steps)
  }
  if (result.db !== undefined) {
    // After install: set the connection string. When auth is wired, generate its tables into the schema
    // FIRST, then create + apply the migration so the auth tables are included.
    steps.push(
      `cp .env.example .env # then set DATABASE_URL${result.auth ? " + BETTER_AUTH_SECRET" : ""}`,
    )
    if (result.auth !== undefined) {
      steps.push("bunx @better-auth/cli@latest generate # writes auth tables into db/schema.ts")
    }
    steps.push("bun run db:generate  # SQL from db/schema.ts", "bun run db:migrate   # apply it")
  }
  // Tag the chosen framework + deploy target + db + auth, e.g. "(Vue, Drizzle + libSQL, better-auth)".
  const tags = [
    ...(result.framework !== undefined ? [result.framework] : []),
    ...(result.deploy !== undefined ? [result.deploy.label] : []),
    ...(result.db !== undefined ? [DB_PRESETS[result.db].label] : []),
    ...(result.auth !== undefined ? [AUTH_PRESETS[result.auth].label] : []),
  ]
  if (result.link !== undefined) {
    steps.push(
      `# @nifrajs/* packages linked from ${result.link} — move the app and update file: paths if you relocate it`,
    )
  }
  const header =
    tags.length > 0 ? `✓ Created ${target} (${tags.join(", ")})` : `✓ Created ${target}`
  return {
    code: 0,
    message: `\n${header}\n\nNext steps:\n${steps.map((s) => `  ${s}`).join("\n")}\n`,
  }
}

/**
 * True when this module is the program entry point. `import.meta.main` covers Bun, Deno, and Node ≥ 24;
 * on older Node it's `undefined`, so fall back to comparing the resolved entry path — otherwise
 * `npx create-nifra` / `npm create nifra` would silently no-op (the block below never runs).
 */
function isMainModule(): boolean {
  const metaMain = (import.meta as { main?: boolean }).main
  if (metaMain !== undefined) return metaMain
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    // realpath resolves the npm/npx bin symlink so it matches `import.meta.url` (which is realpath-based).
    return pathToFileURL(realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (isMainModule()) {
  const { code, message } = await run(process.argv.slice(2))
  ;(code === 0 ? console.log : console.error)(message)
  process.exit(code)
}

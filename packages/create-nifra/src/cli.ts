#!/usr/bin/env node
/**
 * Scaffold a new nifra app:  `bun create nifra <directory>`  (or `npm create nifra <dir>`).
 *
 *   bun create nifra my-app                      # api backend (default)
 *   bun create nifra my-app --template site      # SSR site, deployed to Bun
 *   bun create nifra my-app --template batteries # api + jobs + cache + storage + cursor pagination
 *   bun create nifra my-app --target vercel      # site, deployed to Vercel
 *
 * Copies the bundled template, restores `.gitignore` (npm strips a literal one from packages), and sets
 * the app's `package.json` name. A site deploys to ONE target (`--target`, default `bun`; `--docker`
 * adds a Dockerfile for bun/node): `nifra build` generates its server entry, and the scaffold writes
 * only that target's config and scripts. Refuses to overwrite.
 */
import { realpathSync } from "node:fs"
import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { AGENT_POINTERS, CURSOR_MCP_JSON_PATH, MCP_JSON_PATH, mcpJson } from "./agent-files.ts"
import { agentsMd } from "./agents.ts"
import {
  AUTH_CHOICES,
  AUTH_PRESETS,
  type AuthChoice,
  assertAuthableDb,
  writeAuthFiles,
} from "./auth.ts"
import { DB_CHOICES, DB_PRESETS, type DbChoice, writeDbFiles } from "./db.ts"
import { applyFeatures, type FeatureContribution } from "./scaffold/features.ts"
import { starterRouteTypes } from "./scaffold/route-types.ts"
import { materializeSite } from "./scaffold/site.ts"
import {
  DEPLOY_TARGETS,
  type DeployTarget,
  deployName,
  isDeployTarget,
  TARGETS,
} from "./scaffold/targets.ts"

const TEMPLATES = {
  api: "../template",
  site: "../template-site",
  isr: "../template-isr",
  batteries: "../template-batteries",
} as const
export type TemplateName = keyof typeof TEMPLATES

/** Frontend frameworks the `site` template can scaffold. React is the default (`template-site`); the
 * rest live in `template-site-<framework>` siblings - same multi-target deploy story, different adapter
 * + routes. */
const FRAMEWORKS = ["react", "preact", "vue", "solid", "svelte"] as const
export type Framework = (typeof FRAMEWORKS)[number]

/** The next-steps lines after `bun run dev`, per deploy target. */
function targetSteps(target: DeployTarget, docker: boolean): string[] {
  const spec = TARGETS[target]
  if (docker) return ["bun run build", "bun run deploy       # docker build + run"]
  return [
    "bun run build",
    ...(spec.deploy !== undefined
      ? [`bun run deploy       # ${spec.deploy}`]
      : [`bun run start        # ${spec.start}, any host`]),
  ]
}

// Self-hosted servers (bun/node) have no canonical push-to-deploy - CI builds + uploads the artifact and
// leaves a host-specific placeholder. The managed targets use the vendor's official action/CLI.
const SELF_HOSTED_STEP = (hint: string): string =>
  `      # Self-hosted: deploy is host-specific. The build output is in dist/ - add your step here
      # (${hint}). Until then, CI builds on every push and uploads the bundle as an artifact.
      - name: Upload build
        if: github.ref == 'refs/heads/main'
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: build
          path: dist`

/** The GitHub Actions deploy step + required secrets + permissions, per deploy target. */
interface CiDeploy {
  /** Lines under the workflow's top-level `permissions:` (2-space indented). */
  readonly permissions: string
  /** Repository secrets the deploy needs - listed in a header comment so the user knows what to set. */
  readonly secrets: readonly string[]
  /** YAML for the deploy step(s), indented to sit under `steps:` (`NAME` → the app name). */
  readonly step: string
}
const CI_DEPLOY: Record<DeployTarget, CiDeploy> = {
  bun: {
    permissions: "  contents: read",
    secrets: [],
    step: SELF_HOSTED_STEP("flyctl deploy, an SSH/rsync to a VM, a container push, …"),
  },
  node: {
    permissions: "  contents: read",
    secrets: [],
    step: SELF_HOSTED_STEP("with --docker, push the image to a registry; or flyctl/SSH"),
  },
  deno: {
    // OIDC: link the repo in the Deno Deploy dashboard (no token needed) - needs id-token: write.
    permissions: "  contents: read\n  id-token: write",
    secrets: [],
    step: `      - name: Publish to Deno Deploy
        if: github.ref == 'refs/heads/main'
        uses: denoland/deployctl@87e43e57b2336bcaf96bcd193687edcb3c5795c1
        with:
          project: NAME
          entrypoint: dist/server.js`,
  },
  cloudflare: {
    permissions: "  contents: read",
    secrets: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    step: `      - name: Publish to Cloudflare Pages
        if: github.ref == 'refs/heads/main'
        uses: cloudflare/wrangler-action@9acf94ace14e7dc412b076f2c5c20b8ce93c79cd
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
 * Runs `bun run build` (`nifra build` for the app's target), then the target's official deploy
 * mechanism. Exported for unit tests. Throws on an unknown target.
 */
export function githubDeployWorkflow(target: string, appName: string): string {
  const ci = isDeployTarget(target) ? CI_DEPLOY[target] : undefined
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
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
        with:
          bun-version: 1.4.2
      - run: bun install --frozen-lockfile
      # The gate, before the build. nifra.assurance.ts states what these routes must prove - an
      # unauthenticated write, a mutation with no body schema, a handler reaching a database it never
      # declared. Shipping that config without ever running it makes it decoration.
      - run: bun run check
      - run: bun run build
${ci.step.replaceAll("NAME", deployName(appName))}
`
}

export interface ScaffoldOptions {
  /** Destination directory. */
  readonly target: string
  /** Template to copy. Default `"api"`. */
  readonly template?: TemplateName
  /** Frontend framework (site template only). Default `"react"`. */
  readonly framework?: string
  /** Where the site deploys (site template only): `bun` (default), `node`, `deno`, `cloudflare` or
   * `vercel`. */
  readonly deployTarget?: string
  /** Add a Dockerfile that builds and runs the server (`bun` and `node` targets). */
  readonly docker?: boolean
  /** Emit a CI deploy workflow for the site's target. Only `"github"` today. */
  readonly ci?: string
  /** Wire a data layer: `drizzle-{libsql,postgres,sqlite}` | `prisma-{postgres,sqlite}` | `kysely-postgres`. */
  readonly db?: string
  /** Wire authentication: `better-auth` (requires `--db` - auth needs a database). */
  readonly auth?: string
  /** Allow scaffolding into a non-empty directory (copies template, overwrites collisions). */
  readonly force?: boolean
  /** Path to a local nifra monorepo - replaces `@nifrajs/*` semver deps with `file:` refs so
   *  the app runs against the local source before the packages are published to npm. */
  readonly link?: string
}

export interface ScaffoldResult {
  readonly name: string
  readonly template: TemplateName
  readonly framework?: Framework
  /** Where a site deploys, and whether it ships a Dockerfile. */
  readonly deploy?: {
    readonly target: DeployTarget
    readonly label: string
    readonly docker: boolean
  }
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
 * Copy a template into `target` and finalize it (gitignore rename, package name, the site's deploy target).
 * Throws on: unknown template, `--target`/`--docker` with a non-site template, unknown deploy target, or
 * an existing destination. Pure enough to unit-test (no argv, no process.exit).
 */
export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  // Validated first, before a single file is copied - a name rejected halfway through would leave a
  // half-written project directory behind. npm's own character set for an unscoped name, wider than
  // lowercase-and-hyphens on purpose: `MyApp` and `my_app` are ordinary directory names, and refusing
  // them aborts a scaffold npm would have accepted. Still narrow, because the name is substituted into
  // deploy scripts (`--name NAME`) that a shell runs - hence no metacharacters, no whitespace, and no
  // leading `-` to be read as a flag.
  // Resolved first, so `bun create nifra . --force` names the project after the directory it is in.
  const name = basename(resolve(opts.target))
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.length > 214) {
    throw new Error(
      `invalid project name ${JSON.stringify(name)}: use letters, digits, "-", "_", and "." ` +
        `(starting with a letter or digit), up to 214 characters`,
    )
  }
  const template = opts.template ?? "api"
  if (TEMPLATES[template] === undefined) {
    // "fullstack" is the one name people guess that means two different things - steer both readings.
    if ((template as string) === "fullstack") {
      throw new Error(
        'no "fullstack" template. For a frontend + backend app use --template site; for the batteries API starter (jobs + cache + storage + pagination) use --template batteries.',
      )
    }
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

  if (template !== "site") {
    for (const [flag, given] of [
      ["--target", opts.deployTarget !== undefined],
      ["--docker", opts.docker === true],
      ["--ci", opts.ci !== undefined],
    ] as const) {
      if (given) throw new Error(`${flag} requires the site template (got "${template}")`)
    }
  }
  let deploy: ScaffoldResult["deploy"]
  if (template === "site") {
    const target = opts.deployTarget ?? "bun"
    if (target === "cf-pages") throw new Error('the deploy target "cf-pages" is now "cloudflare"')
    if (!isDeployTarget(target)) {
      throw new Error(`unknown deploy target "${target}". options: ${DEPLOY_TARGETS.join(", ")}`)
    }
    const docker = opts.docker === true
    if (docker && !TARGETS[target].docker) {
      throw new Error(
        `--docker builds a self-hosting server image (bun or node); ${TARGETS[target].label} runs the app itself`,
      )
    }
    deploy = { target, label: TARGETS[target].label, docker }
  }

  if (opts.ci !== undefined && opts.ci !== "github") {
    throw new Error(`unknown --ci "${opts.ci}". options: github`)
  }

  // DB preset (any template - an API or a site can both want persistence).
  let db: DbChoice | undefined
  if (opts.db !== undefined) {
    if (!DB_CHOICES.includes(opts.db as DbChoice)) {
      throw new Error(`unknown --db "${opts.db}". options: ${DB_CHOICES.join(", ")}`)
    }
    db = opts.db as DbChoice
  }

  // Auth preset - needs a database, so it requires `--db` (the auth tables live in your Drizzle DB).
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

  // An occupied destination is refused before the first write. The template copy alone would refuse
  // only a colliding template file, and every file written after it (.gitignore, AGENTS.md, the agent
  // and MCP configs) would still replace one of the user's.
  if (opts.force !== true && (await readdir(opts.target).catch(() => [])).length > 0) {
    throw new Error(`"${opts.target}" already exists and is not empty`)
  }

  // The site scaffold is COMPOSED rather than copied: thirteen of its files are identical whatever you
  // render with, eight are emitted from the framework model, and five are the framework's own. The
  // other templates are still a plain copy - they have no framework axis to collapse.
  // Either way the default refuses an occupied destination rather than clobbering it; --force is what
  // `bun create nifra .` needs.
  if (deploy !== undefined) {
    await materializeSite(opts.target, framework ?? "react", {
      force: opts.force === true,
      target: deploy.target,
      docker: deploy.docker,
      name,
    })
  } else {
    const templateDir = fileURLToPath(new URL(TEMPLATES[template], import.meta.url))
    // The destination is empty or --force was given (checked above), so nothing here replaces a file of
    // the user's; Bun's errorOnExist would also refuse an existing empty directory.
    await cp(templateDir, opts.target, { recursive: true, force: true })
    if (template === "isr") {
      for (const [file, contents] of starterRouteTypes("tsx")) {
        await mkdir(dirname(join(opts.target, file)), { recursive: true })
        await writeFile(join(opts.target, file), contents)
      }
    }
  }

  // The template ships its ignore file as `gitignore` (npm strips a literal `.gitignore`); restore the dot.
  try {
    await rename(join(opts.target, "gitignore"), join(opts.target, ".gitignore"))
  } catch {
    // A template without a `gitignore` - nothing to restore.
  }

  const pkgPath = join(opts.target, "package.json")
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
    name?: string
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  pkg.name = name
  // Every feature states what it contributes and the merge refuses an undeclared collision, so which
  // flag was handled first stops deciding what a project ends up with.
  const features: FeatureContribution[] = []
  if (db !== undefined) {
    // Merge the Drizzle preset's deps + db:* scripts; `bun install` then resolves them.
    const dbp = DB_PRESETS[db]
    features.push({
      label: `--db ${db}`,
      dependencies: dbp.deps,
      devDependencies: dbp.devDeps,
      scripts: dbp.scripts,
    })
  }
  if (auth !== undefined) {
    features.push({ label: `--auth ${auth}`, dependencies: AUTH_PRESETS[auth].deps })
  }
  applyFeatures(pkg, features)
  // --link: replace @nifrajs/* semver refs with file: paths pointing at the local monorepo's packages/
  // directory - lets an app consume nifra from a sibling repo before the packages are published.
  if (opts.link !== undefined) {
    // realpath both ends before computing the relative file: path - otherwise a symlinked
    // segment on either side (macOS tmpdir: /var/folders → /private/var/folders) skews the
    // ../ count and every linked dependency resolves to a nonexistent directory.
    const real = (p: string): string => {
      try {
        return realpathSync(p)
      } catch {
        return p
      }
    }
    const linkPackages = real(resolve(opts.link, "packages"))
    const targetAbs = real(resolve(opts.target))
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
  // first prompt - the conventions + the gotchas, tailored to this template.
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

  // Every agent's own file points at AGENTS.md, and both MCP registries launch the same server - all from
  // agent-files.ts, which `nifra init-agents` shares, so none of them can drift.
  await writeFile(join(opts.target, MCP_JSON_PATH), mcpJson())
  await mkdir(join(opts.target, ".cursor"), { recursive: true })
  await writeFile(join(opts.target, CURSOR_MCP_JSON_PATH), mcpJson())
  for (const pointer of AGENT_POINTERS) {
    const path = join(opts.target, pointer.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, pointer.content())
  }

  // Wire the Drizzle data layer (db/ module + drizzle.config + .env.example + gitignore entries).
  if (db !== undefined) await writeDbFiles(opts.target, db)
  // Wire auth AFTER the DB (it appends to the .env.example the DB preset wrote; --auth requires --db).
  if (auth !== undefined && db !== undefined) await writeAuthFiles(opts.target, auth, db)

  // Emit a CI deploy workflow for the site's target.
  let ciResult: { ci: "github"; ciSecrets: readonly string[] } | undefined
  if (opts.ci === "github" && deploy !== undefined) {
    const workflowsDir = join(opts.target, ".github", "workflows")
    await mkdir(workflowsDir, { recursive: true })
    await writeFile(join(workflowsDir, "deploy.yml"), githubDeployWorkflow(deploy.target, name))
    ciResult = { ci: "github", ciSecrets: CI_DEPLOY[deploy.target].secrets }
  }

  return {
    name,
    template,
    ...(framework !== undefined ? { framework } : {}),
    ...(deploy !== undefined ? { deploy } : {}),
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
  readonly deployTarget?: string
  readonly docker?: boolean
  readonly ci?: string
  readonly db?: string
  readonly auth?: string
  readonly force?: boolean
  readonly link?: string
}

/** Parse `[dir] [--template|-t <t>] [--framework|-f <fw>] [--target <t>] [--docker] [--ci|-c github]
 *  [--db <preset>] [--auth <preset>] [--force] [--link <path>]`.
 * `--framework`/`--target`/`--docker`/`--ci` all default the template to `site`. Throws on the retired
 * `--deploy`. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.includes("--deploy") || argv.includes("-d")) {
    throw new Error("--deploy is now --target (bun | node | deno | cloudflare | vercel)")
  }
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
  const deployTarget = take("--target")
  const docker = hasFlag("--docker")
  const ci = take("--ci", "-c")
  const db = take("--db")
  const auth = take("--auth")
  const link = take("--link")
  const force = hasFlag("--force")
  const target = rest.find((a) => !a.startsWith("-"))
  // `--framework`/`--target`/`--docker`/`--ci` imply the site template unless one was named explicitly.
  const template = (templateFlag ??
    (framework !== undefined || deployTarget !== undefined || docker || ci !== undefined
      ? "site"
      : undefined)) as TemplateName | undefined
  return {
    ...(target !== undefined ? { target } : {}),
    ...(template !== undefined ? { template } : {}),
    ...(framework !== undefined ? { framework } : {}),
    ...(deployTarget !== undefined ? { deployTarget } : {}),
    ...(docker ? { docker } : {}),
    ...(ci !== undefined ? { ci } : {}),
    ...(db !== undefined ? { db } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(link !== undefined ? { link } : {}),
    ...(force ? { force } : {}),
  }
}

const USAGE = `usage: bun create nifra <directory> [--template api|site|isr|batteries] [--framework react|preact|vue|solid|svelte] [--target bun|node|deno|cloudflare|vercel] [--docker] [--ci github] [--db ${DB_CHOICES.join("|")}] [--auth ${AUTH_CHOICES.join("|")}] [--force] [--link <path-to-nifra-repo>]`

/**
 * Run the CLI for `argv` and return the exit code + the message to print - no `process.exit`, `console`,
 * or `process.argv`, so the whole flow (parse → scaffold → next-steps) is unit-testable in-process.
 */
export async function run(argv: readonly string[]): Promise<{ code: 0 | 1; message: string }> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (err) {
    return { code: 1, message: `✗ ${err instanceof Error ? err.message : String(err)}` }
  }
  const { target, template, framework, deployTarget, docker, ci, db, auth, force, link } = parsed
  if (target === undefined) return { code: 1, message: USAGE }

  let result: ScaffoldResult
  try {
    result = await scaffold({
      target,
      ...(template !== undefined ? { template } : {}),
      ...(framework !== undefined ? { framework } : {}),
      ...(deployTarget !== undefined ? { deployTarget } : {}),
      ...(docker ? { docker } : {}),
      ...(ci !== undefined ? { ci } : {}),
      ...(db !== undefined ? { db } : {}),
      ...(auth !== undefined ? { auth } : {}),
      ...(force ? { force } : {}),
      ...(link !== undefined ? { link } : {}),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // A copy failure is almost always "destination exists" - say so plainly.
    const friendly = /exist/i.test(msg)
      ? `refusing to scaffold: "${target}" already exists. Use --force to overwrite.`
      : msg
    return { code: 1, message: `✗ ${friendly}` }
  }

  const steps: string[] = [`cd ${target}`, "bun install", "bun run dev"]
  if (result.ci !== undefined) {
    // CI deploys on push - surface the workflow + the secrets to set first.
    steps[2] = "bun run dev          # local preview"
    if (result.ciSecrets !== undefined && result.ciSecrets.length > 0) {
      steps.push(`# set repo secrets: ${result.ciSecrets.join(", ")}`)
    }
    steps.push(
      "git push             # CI builds + deploys on push to main (.github/workflows/deploy.yml)",
    )
  } else if (result.deploy !== undefined) {
    steps[2] = "bun run dev          # local preview"
    steps.push(...targetSteps(result.deploy.target, result.deploy.docker))
  }
  if (result.db !== undefined) {
    // After install: set the connection string. When auth is wired, generate its tables into the schema
    // FIRST, then create + apply the migration so the auth tables are included.
    steps.push(
      `cp .env.example .env # then set DATABASE_URL${result.auth ? " + BETTER_AUTH_SECRET" : ""}`,
    )
    if (result.auth !== undefined) {
      steps.push("bunx @better-auth/cli@latest generate --config backend/auth.ts # the auth tables")
    }
    steps.push(
      "bun run db:generate  # SQL from backend/db/schema.ts",
      "bun run db:migrate   # apply it",
    )
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
      `# @nifrajs/* packages linked from ${result.link} - move the app and update file: paths if you relocate it`,
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
 * on older Node it's `undefined`, so fall back to comparing the resolved entry path - otherwise
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

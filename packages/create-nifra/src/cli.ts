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
import { pathToFileURL } from "node:url"
import { AUTH_CHOICES, AUTH_PRESETS } from "./auth.ts"
import { DB_CHOICES, DB_PRESETS, type Orm } from "./db.ts"
import { type ScaffoldResult, scaffold, type TemplateName } from "./scaffold/project.ts"
import { type DeployTarget, TARGETS } from "./scaffold/targets.ts"

export {
  type Framework,
  githubDeployWorkflow,
  type ScaffoldOptions,
  type ScaffoldResult,
  scaffold,
  TEMPLATE_DEV_URLS,
  type TemplateName,
} from "./scaffold/project.ts"

/** The next-steps lines after `bun run dev`, per deploy target. */
function targetSteps(target: DeployTarget, docker: boolean): string[] {
  const spec = TARGETS[target]
  if (docker) return ["bun run build", "bun run deploy       # docker build + run"]
  return [
    "bun run build",
    ...(spec.deploy !== undefined
      ? [`bun run deploy       # ${spec.deploy}`]
      : ["bun run start        # run the build locally, one process"]),
  ]
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

/** The first migration, in the scripts each ORM's preset writes: only Drizzle has a generate step,
 * Prisma's migrate creates and applies in one, and Kysely migrations are written by hand. */
const MIGRATION_STEPS: Readonly<Record<Orm, readonly string[]>> = {
  drizzle: [
    "bun run db:generate  # SQL from backend/db/schema.ts",
    "bun run db:migrate   # apply it",
  ],
  prisma: ["bun run db:migrate   # create + apply a migration from prisma/schema.prisma"],
  kysely: ["bun run db:migrate   # apply backend/db/migrations"],
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
  const { target, force } = parsed
  if (target === undefined) return { code: 1, message: USAGE }

  let result: ScaffoldResult
  try {
    // parseArgs leaves out every flag not given, so what it parsed is scaffold's options as they are.
    result = await scaffold({ ...parsed, target })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Without --force a copy failure is almost always "destination exists" - say so plainly. With it,
    // that advice is wrong, and the error itself is the only clue.
    const friendly =
      !force && /exist/i.test(msg)
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
    steps.push(...MIGRATION_STEPS[DB_PRESETS[result.db].orm])
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

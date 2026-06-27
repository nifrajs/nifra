import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { githubDeployWorkflow, parseArgs, run, scaffold } from "../src/cli.ts"

const roots: string[] = []
async function freshDir(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nifra-cli-"))
  roots.push(root)
  return join(root, name) // scaffold creates this leaf; basename(name) becomes the package name
}
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

const CLI = join(import.meta.dir, "../src/cli.ts")
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, stdout, stderr }
}

const exists = (p: string): Promise<boolean> =>
  stat(p)
    .then(() => true)
    .catch(() => false)
const readPkg = async (dir: string): Promise<{ name?: string; scripts?: Record<string, string> }> =>
  JSON.parse(await readFile(join(dir, "package.json"), "utf8"))

describe("parseArgs", () => {
  test("positional target + --template/-t + --deploy/-d", () => {
    expect(parseArgs(["my-app"])).toEqual({ target: "my-app" })
    expect(parseArgs(["my-app", "--template", "site"])).toEqual({
      target: "my-app",
      template: "site",
    })
    expect(parseArgs(["-t", "isr", "my-app"])).toEqual({ target: "my-app", template: "isr" })
    expect(parseArgs(["my-app", "-d", "vercel"])).toEqual({
      target: "my-app",
      template: "site", // --deploy implies the site template
      deploy: "vercel",
    })
  })

  test("explicit --template wins over the --deploy default", () => {
    expect(parseArgs(["x", "--template", "site", "--deploy", "node"])).toEqual({
      target: "x",
      template: "site",
      deploy: "node",
    })
  })

  test("--framework/-f implies site and composes with --deploy", () => {
    expect(parseArgs(["my-app", "--framework", "vue"])).toEqual({
      target: "my-app",
      template: "site",
      framework: "vue",
    })
    expect(parseArgs(["my-app", "-f", "svelte", "-d", "vercel"])).toEqual({
      target: "my-app",
      template: "site",
      framework: "svelte",
      deploy: "vercel",
    })
  })
})

describe("scaffold — templates", () => {
  test("api (default) copies the template, restores .gitignore, sets package name", async () => {
    const dir = await freshDir("my-api")
    const res = await scaffold({ target: dir })
    expect(res).toEqual({ name: "my-api", template: "api" })
    expect(await exists(join(dir, ".gitignore"))).toBe(true)
    expect(await exists(join(dir, "gitignore"))).toBe(false) // renamed, not left behind
    expect((await readPkg(dir)).name).toBe("my-api")
  })

  test("site ships every target's entry + config", async () => {
    const dir = await freshDir("my-site")
    await scaffold({ target: dir, template: "site" })
    for (const f of [
      "server-bun.ts",
      "build-bun.ts",
      "server-node.ts",
      "server-deno.ts",
      "server-vercel.ts",
      "_worker.ts",
      "Dockerfile",
      ".dockerignore",
      "deno.json",
      "wrangler.toml",
    ]) {
      expect(await exists(join(dir, f))).toBe(true)
    }
    // Project name is filled into the CF Pages config.
    const toml = await readFile(join(dir, "wrangler.toml"), "utf8")
    expect(toml).toContain('name = "my-site"')
  })

  test("ships an AGENTS.md with the core rules, tailored to the template", async () => {
    const api = await freshDir("my-api")
    await scaffold({ target: api })
    const apiMd = await readFile(join(api, "AGENTS.md"), "utf8")
    expect(apiMd).toContain("# AGENTS.md — my-api")
    expect(apiMd).toContain("server()") // backend rules
    expect(apiMd).toContain("Validate every input at the boundary")
    expect(apiMd).toContain("never throws") // the typed client
    expect(apiMd).toContain("llms-full.txt") // pointer to the full reference
    expect(apiMd).toContain("install current, never pin from memory") // anti-stale-training rule
    // The API template is not full-stack → no route-module gotcha section.
    expect(apiMd).not.toContain("never import server-only code")

    // The full-stack templates add the file-routing + server-only-import gotcha, named per framework.
    const site = await freshDir("my-site")
    await scaffold({ target: site, template: "site", framework: "vue" })
    const siteMd = await readFile(join(site, "AGENTS.md"), "utf8")
    expect(siteMd).toContain("# AGENTS.md — my-site")
    expect(siteMd).toContain("never import server-only code at a route's top level")
    expect(siteMd).toContain("Vue")
    expect(siteMd).toContain("@nifrajs/web-vue")
  })
})

describe("scaffold — agent-discovery files (MCP auto-discovery)", () => {
  test("writes .mcp.json registering the nifra MCP with the bin-owning package", async () => {
    const dir = await freshDir("mcp-app")
    await scaffold({ target: dir })
    const raw = await readFile(join(dir, ".mcp.json"), "utf8")
    const cfg = JSON.parse(raw) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    // Claude Code's exact shape: { mcpServers: { <name>: { command, args } } }.
    expect(cfg.mcpServers.nifra).toBeDefined()
    expect(cfg.mcpServers.nifra?.command).toBe("bunx")
    // `@nifrajs/cli` (not the bare `nifra` pkg) — it's the package that provides the `nifra` bin, so it
    // resolves across api/isr templates that don't carry @nifrajs/cli as a dep. Pinned to an exact
    // version so a stale `bunx` cache can't shadow it (the version is part of bunx's cache key).
    const args = cfg.mcpServers.nifra?.args
    expect(args?.[0]).toMatch(/^@nifrajs\/cli@\d+\.\d+\.\d+/)
    expect(args?.[1]).toBe("mcp")
  })

  test("writes .cursor/mcp.json with the same server config", async () => {
    const dir = await freshDir("cursor-app")
    await scaffold({ target: dir })
    const [root, cursor] = await Promise.all([
      readFile(join(dir, ".mcp.json"), "utf8"),
      readFile(join(dir, ".cursor/mcp.json"), "utf8"),
    ])
    // Both registries serialize the one canonical config — byte-identical, so they can't drift.
    expect(cursor).toBe(root)
  })

  test("writes a CLAUDE.md that is MCP-first and imports AGENTS.md (no duplication)", async () => {
    const dir = await freshDir("claude-app")
    await scaffold({ target: dir })
    const md = await readFile(join(dir, "CLAUDE.md"), "utf8")
    expect(md).toContain("nifra MCP server")
    expect(md).toContain("nifra_docs")
    expect(md).toContain("nifra_check") // the done-gate
    // The `@AGENTS.md` import directive must be on its own line for Claude Code to resolve it — that's
    // how the full cookbook stays in AGENTS.md alone (no drift between the two files).
    expect(md.split("\n")).toContain("@AGENTS.md")
  })

  test("AGENTS.md gains the MCP section so non-Claude agents learn the server exists", async () => {
    const dir = await freshDir("agents-mcp-app")
    await scaffold({ target: dir })
    const md = await readFile(join(dir, "AGENTS.md"), "utf8")
    expect(md).toContain("## MCP server")
    expect(md).toMatch(/bunx @nifrajs\/cli@\d+\.\d+\.\d+\S* mcp/)
    expect(md).toContain("nifra_docs")
  })
})

describe("scaffold — --deploy preset", () => {
  test("vercel repoints build/deploy; per-target scripts stay", async () => {
    const dir = await freshDir("vc-app")
    const res = await scaffold({ target: dir, template: "site", deploy: "vercel" })
    expect(res.deploy?.label).toBe("Vercel Edge")
    const pkg = await readPkg(dir)
    expect(pkg.scripts?.build).toBe("bun run build-vercel.ts")
    expect(pkg.scripts?.deploy).toBe("vercel deploy --prebuilt")
    // The multi-target scripts are untouched, so you can still switch targets.
    expect(pkg.scripts?.["build:node"]).toBe("bun run build-node.ts")
    expect(pkg.scripts?.["deploy:cf"]).toBe("wrangler pages deploy dist")
  })

  test("node deploy interpolates the app name into the docker command", async () => {
    const dir = await freshDir("dock-app")
    await scaffold({ target: dir, template: "site", deploy: "node" })
    const pkg = await readPkg(dir)
    expect(pkg.scripts?.build).toBe("bun run build-node.ts")
    expect(pkg.scripts?.deploy).toBe(
      "docker build -t dock-app . && docker run -p 3000:3000 dock-app",
    )
  })

  test("each known target yields a build + deploy script", async () => {
    for (const target of ["bun", "deno", "cf-pages"]) {
      const dir = await freshDir(`t-${target}`)
      const pkg = await scaffold({ target: dir, template: "site", deploy: target }).then(() =>
        readPkg(dir),
      )
      expect(pkg.scripts?.build).toBeTruthy()
      expect(pkg.scripts?.deploy).toBeTruthy()
    }
  })
})

describe("scaffold — rejections", () => {
  test("unknown template", async () => {
    const dir = await freshDir("x")
    await expect(scaffold({ target: dir, template: "nope" as "api" })).rejects.toThrow(
      /unknown template/,
    )
  })

  test("--deploy with a non-site template", async () => {
    const dir = await freshDir("x")
    await expect(scaffold({ target: dir, template: "api", deploy: "vercel" })).rejects.toThrow(
      /--deploy requires the site template/,
    )
  })

  test("unknown deploy target", async () => {
    const dir = await freshDir("x")
    await expect(scaffold({ target: dir, template: "site", deploy: "heroku" })).rejects.toThrow(
      /unknown deploy target/,
    )
  })

  test("refuses to overwrite an existing directory", async () => {
    const dir = await freshDir("twice")
    await scaffold({ target: dir, template: "api" })
    await expect(scaffold({ target: dir, template: "api" })).rejects.toThrow()
  })
})

// Exercise the CLI's run() flow (argv parse → scaffold → next-steps message / exit code) in-process.
describe("run (argv → code + message)", () => {
  test("scaffolds + returns target-specific next steps, code 0", async () => {
    const dir = await freshDir("run-vc")
    const { code, message } = await run([dir, "--deploy", "vercel"])
    expect(code).toBe(0)
    expect(message).toContain("Vercel Edge")
    expect(message).toContain("vercel deploy --prebuilt")
    expect(await exists(join(dir, ".gitignore"))).toBe(true)
  })

  test("no target → usage, code 1", async () => {
    const { code, message } = await run([])
    expect(code).toBe(1)
    expect(message).toContain("usage:")
  })

  test("existing directory → friendly error, code 1", async () => {
    const dir = await freshDir("run-twice")
    await scaffold({ target: dir, template: "api" })
    const { code, message } = await run([dir])
    expect(code).toBe(1)
    expect(message).toMatch(/already exists/)
  })

  test("unknown deploy target → error, code 1", async () => {
    const dir = await freshDir("run-bad")
    const { code, message } = await run([dir, "--deploy", "heroku"])
    expect(code).toBe(1)
    expect(message).toContain("unknown deploy target")
  })
})

// One end-to-end check that the published binary actually parses argv, scaffolds, and exits 0.
describe("CLI binary (subprocess)", () => {
  test("bun create-nifra <dir> --deploy node → exit 0, scaffolded", async () => {
    const dir = await freshDir("cli-e2e")
    const { code, stdout } = await runCli([dir, "--deploy", "node"])
    expect(code).toBe(0)
    expect(stdout).toContain("Created")
    expect(await exists(join(dir, "Dockerfile"))).toBe(true)
  })
})

describe("scaffold — --framework", () => {
  test("react (default) → template-site; vue → template-site-vue", async () => {
    const r = await freshDir("fw-react")
    await scaffold({ target: r, template: "site", framework: "react" })
    expect(await readFile(join(r, "framework.ts"), "utf8")).toContain("reactAdapter")

    const v = await freshDir("fw-vue")
    const res = await scaffold({ target: v, template: "site", framework: "vue" })
    expect(res.framework).toBe("vue")
    expect(await readFile(join(v, "framework.ts"), "utf8")).toContain("vueAdapter")
    // The Vue template scaffolds `.vue` Single-File Components (not render-function `.tsx`).
    expect(await exists(join(v, "routes/index.vue"))).toBe(true)
    expect(await exists(join(v, "routes/index.tsx"))).toBe(false)
    const pkg = JSON.parse(await readFile(join(v, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.["@nifrajs/web-vue"]).toBeTruthy()
    expect(pkg.dependencies?.vue).toBeTruthy()
    // SFCs are compiled by vueBunPlugin, which needs @vue/compiler-sfc at build time.
    expect(pkg.devDependencies?.["@vue/compiler-sfc"]).toBeTruthy()
  })

  test("every framework scaffolds its adapter + dep", async () => {
    const cases: Array<[string, string]> = [
      ["preact", "preactAdapter"],
      ["solid", "solidAdapter"],
      ["svelte", "svelteAdapter"],
    ]
    for (const [fw, adapter] of cases) {
      const dir = await freshDir(`fw-${fw}`)
      await scaffold({ target: dir, template: "site", framework: fw })
      expect(await readFile(join(dir, "framework.ts"), "utf8")).toContain(adapter)
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>
      }
      expect(pkg.dependencies?.[`@nifrajs/web-${fw}`]).toBeTruthy()
    }
  })

  test("site templates ship a nifra.config.ts + a `nifra dev` script (CLI inner loop)", async () => {
    // React (everything in nifra.config.ts) + Vue (compiler framework: also clientPlugins/serverPlugins).
    const cases: Array<[string | undefined, string]> = [
      [undefined, "@nifrajs/web-react/client"],
      ["vue", "@nifrajs/web-vue/client"],
    ]
    for (const [framework, clientModule] of cases) {
      const dir = await freshDir(`cli-${framework ?? "react"}`)
      await scaffold({ target: dir, template: "site", ...(framework ? { framework } : {}) })

      // nifra.config.ts is the CLI's config (separate from the edge-imported framework.ts).
      const config = await readFile(join(dir, "nifra.config.ts"), "utf8")
      expect(config).toContain('export { adapter } from "./framework"')
      expect(config).toContain(`export const clientModule = "${clientModule}"`)
      expect(config).toContain("vitePlugins")

      // framework.ts stays minimal (adapter only) so it doesn't drag dev/compiler deps into the worker.
      expect(await readFile(join(dir, "framework.ts"), "utf8")).not.toContain("vitePlugins")

      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      expect(pkg.scripts?.dev).toBe("nifra dev")
      expect(pkg.scripts?.preview).toBe("bunx wrangler pages dev dist") // the old CF preview, kept
      expect(pkg.devDependencies?.["@nifrajs/cli"]).toBeTruthy()
      expect(pkg.devDependencies?.vite).toBeTruthy()
    }
  })

  test("composes with --deploy (Vue + Vercel)", async () => {
    const dir = await freshDir("fw-vue-vc")
    const res = await scaffold({
      target: dir,
      template: "site",
      framework: "vue",
      deploy: "vercel",
    })
    expect(res.framework).toBe("vue")
    expect(res.deploy?.label).toBe("Vercel Edge")
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>
    }
    expect(pkg.scripts?.build).toBe("bun run build-vercel.ts")
  })

  test("--framework with a non-site template / unknown framework → rejects", async () => {
    const a = await freshDir("fw-bad-tpl")
    await expect(scaffold({ target: a, template: "api", framework: "vue" })).rejects.toThrow(
      /--framework requires the site template/,
    )
    const b = await freshDir("fw-bad-name")
    await expect(scaffold({ target: b, template: "site", framework: "angular" })).rejects.toThrow(
      /unknown framework/,
    )
  })
})

// Guard against drift: the framework-agnostic files must stay byte-identical across template variants
// (they differ only by framework.ts, build entries, routes, package.json, tsconfig).
describe("template parity", () => {
  const AGNOSTIC = [
    "Dockerfile",
    ".dockerignore",
    "deno.json",
    "wrangler.toml",
    "backend.ts",
    "gitignore",
    "server-bun.ts",
    "server-node.ts",
    "server-deno.ts",
    "server-vercel.ts",
    "_worker.ts",
  ]
  const base = join(import.meta.dir, "../template-site")
  for (const fw of ["vue", "preact", "solid", "svelte"]) {
    test(`template-site-${fw} matches template-site for every agnostic file`, async () => {
      const overlay = join(import.meta.dir, `../template-site-${fw}`)
      for (const f of AGNOSTIC) {
        const [a, b] = await Promise.all([
          readFile(join(base, f), "utf8"),
          readFile(join(overlay, f), "utf8"),
        ])
        expect(b, `${f} drifted from template-site`).toBe(a)
      }
    })
  }
})

describe("CI workflows (--ci github)", () => {
  test("parseArgs takes --ci/-c and implies the site template", () => {
    expect(parseArgs(["my-app", "--deploy", "vercel", "--ci", "github"])).toEqual({
      target: "my-app",
      template: "site",
      deploy: "vercel",
      ci: "github",
    })
    expect(parseArgs(["x", "-d", "cf-pages", "-c", "github"])).toMatchObject({ ci: "github" })
  })

  test("githubDeployWorkflow: cf-pages uses wrangler-action + names the project + lists secrets", () => {
    const yml = githubDeployWorkflow("cf-pages", "my-app")
    expect(yml).toContain("cloudflare/wrangler-action@v3")
    expect(yml).toContain("command: pages deploy dist --project-name=my-app")
    expect(yml).toContain("CLOUDFLARE_API_TOKEN")
    // Asserting the literal GitHub Actions expression survives (wasn't eaten by JS template interpolation).
    // biome-ignore lint/suspicious/noTemplateCurlyInString: that literal `${{ }}` is exactly what we verify
    expect(yml).toContain("${{ secrets.CLOUDFLARE_API_TOKEN }}")
    expect(yml).toContain("if: github.ref == 'refs/heads/main'") // deploy only on main
    expect(yml).toContain("bun run build")
  })

  test("githubDeployWorkflow: vercel + deno use their CLIs/actions", () => {
    expect(githubDeployWorkflow("vercel", "x")).toContain("vercel deploy --prebuilt --prod")
    const deno = githubDeployWorkflow("deno", "x")
    expect(deno).toContain("denoland/deployctl@v1")
    expect(deno).toContain("project: x")
    expect(deno).toContain("id-token: write") // OIDC
  })

  test("githubDeployWorkflow: self-hosted bun/node ship an artifact + a host-specific placeholder", () => {
    for (const t of ["bun", "node"]) {
      const yml = githubDeployWorkflow(t, "x")
      expect(yml).toContain("actions/upload-artifact@v4")
      expect(yml).toContain("Self-hosted: deploy is host-specific")
      expect(yml).toContain("No deploy secrets required")
    }
  })

  test("scaffold writes .github/workflows/deploy.yml for the chosen target", async () => {
    const dir = await freshDir("ci-app")
    const res = await scaffold({ target: dir, template: "site", deploy: "cf-pages", ci: "github" })
    expect(res.ci).toBe("github")
    expect(res.ciSecrets).toEqual(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
    const wf = await readFile(join(dir, ".github/workflows/deploy.yml"), "utf8")
    expect(wf).toContain("command: pages deploy dist --project-name=ci-app")
  })

  test("--ci requires --deploy, and only 'github' is known", async () => {
    await expect(
      scaffold({ target: await freshDir("a"), template: "site", ci: "github" }),
    ).rejects.toThrow(/--ci requires --deploy/)
    await expect(
      scaffold({ target: await freshDir("b"), template: "site", deploy: "vercel", ci: "gitlab" }),
    ).rejects.toThrow(/unknown --ci/)
  })

  test("run(): next steps surface the workflow + the secrets to set", async () => {
    const { code, message } = await run([
      await freshDir("ci-run"),
      "-d",
      "cf-pages",
      "-c",
      "github",
    ])
    expect(code).toBe(0)
    expect(message).toContain("set repo secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID")
    expect(message).toContain("CI builds + deploys on push")
  })
})

describe("scaffold — --db (Drizzle presets)", () => {
  test("parseArgs reads --db", () => {
    expect(parseArgs(["my-app", "--db", "drizzle-sqlite"])).toEqual({
      target: "my-app",
      db: "drizzle-sqlite",
    })
  })

  test("drizzle-libsql wires the db module, deps, scripts, env, gitignore, and AGENTS section", async () => {
    const dir = await freshDir("my-notes")
    const res = await scaffold({ target: dir, db: "drizzle-libsql" })
    expect(res.db).toBe("drizzle-libsql")

    expect(await readFile(join(dir, "db/schema.ts"), "utf8")).toContain("sqliteTable")
    const client = await readFile(join(dir, "db/index.ts"), "utf8")
    expect(client).toContain("@libsql/client")
    expect(client).toContain("export const db")
    expect(await readFile(join(dir, "drizzle.config.ts"), "utf8")).toContain('dialect: "turso"')
    expect(await readFile(join(dir, ".env.example"), "utf8")).toContain("DATABASE_URL")

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      scripts: Record<string, string>
    }
    expect(pkg.dependencies["drizzle-orm"]).toBeDefined()
    expect(pkg.dependencies["@libsql/client"]).toBeDefined()
    expect(pkg.devDependencies["drizzle-kit"]).toBeDefined()
    expect(pkg.scripts["db:generate"]).toBe("drizzle-kit generate")

    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain("local.db")
    const md = await readFile(join(dir, "AGENTS.md"), "utf8")
    expect(md).toContain("## Database (Drizzle + libSQL)")
    expect(md).toContain('.decorate("db", db)')
  })

  test("drizzle-postgres uses the pg dialect + postgres driver", async () => {
    const dir = await freshDir("my-pg")
    await scaffold({ target: dir, db: "drizzle-postgres" })
    expect(await readFile(join(dir, "db/schema.ts"), "utf8")).toContain("pgTable")
    expect(await readFile(join(dir, "drizzle.config.ts"), "utf8")).toContain(
      'dialect: "postgresql"',
    )
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies.postgres).toBeDefined()
  })

  test("drizzle-sqlite uses bun:sqlite (no extra driver dependency)", async () => {
    const dir = await freshDir("my-sqlite")
    await scaffold({ target: dir, db: "drizzle-sqlite" })
    expect(await readFile(join(dir, "db/index.ts"), "utf8")).toContain("bun:sqlite")
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies["@libsql/client"]).toBeUndefined()
    expect(pkg.dependencies.postgres).toBeUndefined()
  })

  test("an unknown --db is rejected", async () => {
    const dir = await freshDir("my-bad")
    await expect(scaffold({ target: dir, db: "mongo" })).rejects.toThrow(/unknown --db/)
  })

  test("without --db the app stays db-free (no db/ directory)", async () => {
    const dir = await freshDir("plain")
    await scaffold({ target: dir })
    const dbDirExists = await stat(join(dir, "db")).then(
      () => true,
      () => false,
    )
    expect(dbDirExists).toBe(false)
  })
})

describe("scaffold — --db (Prisma + Kysely presets)", () => {
  test("prisma-postgres wires schema.prisma (postgresql), a singleton client, scripts, and AGENTS", async () => {
    const dir = await freshDir("my-prisma-pg")
    const res = await scaffold({ target: dir, db: "prisma-postgres" })
    expect(res.db).toBe("prisma-postgres")

    const schema = await readFile(join(dir, "prisma/schema.prisma"), "utf8")
    expect(schema).toContain('provider = "postgresql"')
    expect(schema).toContain("model Note")
    expect(schema).toContain("@db.Timestamptz") // production-grade PG stamps
    const client = await readFile(join(dir, "db/index.ts"), "utf8")
    expect(client).toContain("PrismaClient")
    expect(client).toContain("globalForPrisma") // dev hot-reload guard

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      scripts: Record<string, string>
    }
    expect(pkg.dependencies["@prisma/client"]).toBeDefined()
    expect(pkg.devDependencies.prisma).toBeDefined()
    expect(pkg.scripts["db:migrate"]).toBe("prisma migrate dev")

    const md = await readFile(join(dir, "AGENTS.md"), "utf8")
    expect(md).toContain("## Database (Prisma + Postgres)")
    expect(md).toContain("c.db.note.findMany") // Prisma query idiom, not Drizzle
  })

  test("prisma-sqlite uses the sqlite datasource", async () => {
    const dir = await freshDir("my-prisma-sqlite")
    await scaffold({ target: dir, db: "prisma-sqlite" })
    expect(await readFile(join(dir, "prisma/schema.prisma"), "utf8")).toContain(
      'provider = "sqlite"',
    )
    expect(await readFile(join(dir, ".env.example"), "utf8")).toContain("file:./local.db")
  })

  test("kysely-postgres wires the typed client, a Migrator runner, and a starter migration", async () => {
    const dir = await freshDir("my-kysely")
    await scaffold({ target: dir, db: "kysely-postgres" })

    expect(await readFile(join(dir, "db/schema.ts"), "utf8")).toContain("export interface DB")
    const client = await readFile(join(dir, "db/index.ts"), "utf8")
    expect(client).toContain("PostgresDialect")
    expect(await readFile(join(dir, "db/migrate.ts"), "utf8")).toContain("Migrator")
    expect(await readFile(join(dir, "db/migrations/0001_create_notes.ts"), "utf8")).toContain(
      "createTable",
    )

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
      scripts: Record<string, string>
    }
    expect(pkg.dependencies.kysely).toBeDefined()
    expect(pkg.dependencies.pg).toBeDefined()
    expect(pkg.scripts["db:migrate"]).toBe("bun run db/migrate.ts")

    const md = await readFile(join(dir, "AGENTS.md"), "utf8")
    expect(md).toContain("## Database (Kysely + Postgres)")
    expect(md).toContain("c.db.selectFrom") // Kysely query idiom
  })
})

describe("scaffold — --auth (better-auth, composes with --db)", () => {
  test("parseArgs reads --auth", () => {
    expect(parseArgs(["my-app", "--db", "drizzle-libsql", "--auth", "better-auth"])).toEqual({
      target: "my-app",
      db: "drizzle-libsql",
      auth: "better-auth",
    })
  })

  test("writes auth.ts (Drizzle adapter), deps, env, and the AGENTS section", async () => {
    const dir = await freshDir("my-app")
    const res = await scaffold({ target: dir, db: "drizzle-libsql", auth: "better-auth" })
    expect(res.auth).toBe("better-auth")

    const authTs = await readFile(join(dir, "auth.ts"), "utf8")
    expect(authTs).toContain("better-auth/adapters/drizzle")
    expect(authTs).toContain('provider: "sqlite"') // libsql → sqlite dialect
    expect(authTs).toContain('import { db } from "./db"')

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies["better-auth"]).toBeDefined()
    expect(pkg.dependencies["@nifrajs/better-auth"]).toBeDefined()

    // Appended to (not clobbered) the DB preset's .env.example.
    const env = await readFile(join(dir, ".env.example"), "utf8")
    expect(env).toContain("DATABASE_URL") // from --db
    expect(env).toContain("BETTER_AUTH_SECRET") // from --auth

    const md = await readFile(join(dir, "AGENTS.md"), "utf8")
    expect(md).toContain("## Authentication (better-auth)")
    expect(md).toContain(".use(betterAuth(auth))")
  })

  test("maps the Drizzle dialect to better-auth's provider (postgres → pg)", async () => {
    const dir = await freshDir("pg-auth")
    await scaffold({ target: dir, db: "drizzle-postgres", auth: "better-auth" })
    expect(await readFile(join(dir, "auth.ts"), "utf8")).toContain('provider: "pg"')
  })

  test("uses the Prisma adapter for a Prisma DB (provider: postgresql, not Drizzle's pg)", async () => {
    const dir = await freshDir("prisma-auth")
    await scaffold({ target: dir, db: "prisma-postgres", auth: "better-auth" })
    const authTs = await readFile(join(dir, "auth.ts"), "utf8")
    expect(authTs).toContain("better-auth/adapters/prisma")
    expect(authTs).toContain('provider: "postgresql"')
  })

  test("rejects --auth with a Kysely DB (no drop-in better-auth adapter)", async () => {
    const dir = await freshDir("kysely-auth")
    await expect(
      scaffold({ target: dir, db: "kysely-postgres", auth: "better-auth" }),
    ).rejects.toThrow(/doesn't scaffold for --db kysely-postgres/)
  })

  test("--auth requires --db (better-auth needs a database)", async () => {
    const dir = await freshDir("no-db")
    await expect(scaffold({ target: dir, auth: "better-auth" })).rejects.toThrow(
      /--auth requires --db/,
    )
  })

  test("an unknown --auth is rejected", async () => {
    const dir = await freshDir("bad-auth")
    await expect(scaffold({ target: dir, db: "drizzle-libsql", auth: "clerk" })).rejects.toThrow(
      /unknown --auth/,
    )
  })
})

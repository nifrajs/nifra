import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { githubDeployWorkflow, parseArgs, run, scaffold } from "../src/cli.ts"
import { SHARED_SITE_FILES } from "../src/scaffold/site.ts"
import { materializeAll } from "./_scaffold-fixtures.ts"

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
  test("positional target + --template/-t + --target + --docker", () => {
    expect(parseArgs(["my-app"])).toEqual({ target: "my-app" })
    expect(parseArgs(["my-app", "--template", "site"])).toEqual({
      target: "my-app",
      template: "site",
    })
    expect(parseArgs(["-t", "isr", "my-app"])).toEqual({ target: "my-app", template: "isr" })
    expect(parseArgs(["my-app", "--target", "vercel"])).toEqual({
      target: "my-app",
      template: "site", // --target implies the site template
      deployTarget: "vercel",
    })
    expect(parseArgs(["my-app", "--docker"])).toEqual({
      target: "my-app",
      template: "site",
      docker: true,
    })
  })

  test("explicit --template wins over the --target default", () => {
    expect(parseArgs(["x", "--template", "site", "--target", "node"])).toEqual({
      target: "x",
      template: "site",
      deployTarget: "node",
    })
  })

  test("--framework/-f implies site and composes with --target", () => {
    expect(parseArgs(["my-app", "--framework", "vue"])).toEqual({
      target: "my-app",
      template: "site",
      framework: "vue",
    })
    expect(parseArgs(["my-app", "-f", "svelte", "--target", "vercel"])).toEqual({
      target: "my-app",
      template: "site",
      framework: "svelte",
      deployTarget: "vercel",
    })
  })

  test("the retired --deploy is refused with its replacement", () => {
    expect(() => parseArgs(["my-app", "--deploy", "vercel"])).toThrow("--deploy is now --target")
    expect(() => parseArgs(["my-app", "-d", "vercel"])).toThrow("--deploy is now --target")
  })
})

describe("scaffold - templates", () => {
  test("api (default) copies the template, restores .gitignore, sets package name", async () => {
    const dir = await freshDir("my-api")
    const res = await scaffold({ target: dir })
    expect(res).toEqual({ name: "my-api", template: "api" })
    expect(await exists(join(dir, ".gitignore"))).toBe(true)
    expect(await exists(join(dir, "gitignore"))).toBe(false) // renamed, not left behind
    expect((await readPkg(dir)).name).toBe("my-api")
  })

  test("a site deploys to one target and carries no hand-written server entry", async () => {
    const dir = await freshDir("my-site")
    const res = await scaffold({ target: dir, template: "site" })
    expect(res.deploy).toEqual({ target: "bun", label: "Bun", docker: false })
    for (const f of [
      "server-bun.ts",
      "build-bun.ts",
      "server-node.ts",
      "_worker.ts",
      "build.ts",
      "Dockerfile",
      "deno.json",
      "wrangler.toml",
    ]) {
      expect(await exists(join(dir, f))).toBe(false)
    }
    expect(await readFile(join(dir, "nifra.config.ts"), "utf8")).toEndWith(
      'export const target = "bun"\n',
    )
    expect((await readPkg(dir)).scripts).toEqual({
      dev: "nifra dev",
      build: "nifra build",
      start: "bun dist/server.js",
      check: "nifra check && nifra assure",
    })
  })

  test("every template keeps .env files out of git", async () => {
    for (const template of ["api", "batteries", "site", "isr"] as const) {
      const dir = await freshDir(`env-${template}`)
      await scaffold({ target: dir, template })
      const ignored = (await readFile(join(dir, ".gitignore"), "utf8")).split("\n")
      expect(ignored).toContain(".env")
      expect(ignored).toContain(".env.*")
      expect(ignored).toContain("!.env.example")
    }
  })

  test("a Cloudflare site gets wrangler.toml named for the project", async () => {
    const dir = await freshDir("my-site")
    await scaffold({ target: dir, template: "site", deployTarget: "cloudflare" })
    const toml = await readFile(join(dir, "wrangler.toml"), "utf8")
    expect(toml).toContain('name = "my-site"')
    expect(toml).toContain('pages_build_output_dir = "dist"')
    // Earlier dates leave process.env empty, so backend/app.ts could never see its rate-limit opt-in.
    expect(toml).toContain('compatibility_date = "2025-04-01"')
    const config = await readFile(join(dir, "nifra.config.ts"), "utf8")
    expect(config).toContain('export const target = "cloudflare"')
    // The shared backend rate-limits per caller, which an edge build can only key on the platform header.
    expect(config).toContain('export const clientIp = "platform"')
  })

  test("ships an AGENTS.md with the core rules, tailored to the template", async () => {
    const api = await freshDir("my-api")
    await scaffold({ target: api })
    const apiMd = await readFile(join(api, "AGENTS.md"), "utf8")
    expect(apiMd).toContain("# AGENTS.md - my-api")
    expect(apiMd).toContain("server()") // backend rules
    expect(apiMd).toContain("Validate every input at the boundary")
    // Every slot a route schema takes is named, so an agent validates a path param with `params`.
    expect(apiMd).toContain("{ body, query, params, headers,")
    expect(apiMd).toContain("{ params: t.object(")
    expect(apiMd).not.toContain("NOT a schema slot")
    expect(apiMd).toContain("never throws") // the typed client
    expect(apiMd).toContain("llms-full.txt") // pointer to the full reference
    expect(apiMd).toContain("install current, never pin from memory") // anti-stale-training rule
    // The API template is not full-stack → no frontend, so no zones section.
    expect(apiMd).not.toContain("## Project structure")

    // The full-stack templates add file routing and the zones the build enforces, named per framework.
    const site = await freshDir("my-site")
    await scaffold({ target: site, template: "site", framework: "vue" })
    const siteMd = await readFile(join(site, "AGENTS.md"), "utf8")
    expect(siteMd).toContain("# AGENTS.md - my-site")
    expect(siteMd).toContain("## Project structure")
    expect(siteMd).toContain("Frontend code never imports backend code")
    expect(siteMd).toContain("Vue")
    expect(siteMd).toContain("@nifrajs/web-vue")
  })
})

describe("scaffold - agent-discovery files (MCP auto-discovery)", () => {
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
    // `@nifrajs/cli` (not the bare `nifra` pkg) - it's the package that provides the `nifra` bin, so it
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
    // Both registries serialize the one canonical config - byte-identical, so they can't drift.
    expect(cursor).toBe(root)
  })

  test("every agent's own file is a pointer to AGENTS.md, so no guidance is duplicated", async () => {
    const dir = await freshDir("pointer-app")
    await scaffold({ target: dir })
    const read = (path: string) => readFile(join(dir, path), "utf8")
    // Import directives must sit on their own line for Claude Code and Gemini CLI to expand them.
    expect((await read("CLAUDE.md")).split("\n")).toContain("@AGENTS.md")
    expect((await read("GEMINI.md")).split("\n")).toContain("@./AGENTS.md")
    const cursor = await read(".cursor/rules/nifra.mdc")
    expect(cursor).toStartWith("---\n")
    expect(cursor).toContain("alwaysApply: true")
    expect(cursor.split("\n")).toContain("@AGENTS.md")
    expect(await read(".github/copilot-instructions.md")).toContain("AGENTS.md")
    // A pointer carries no guidance of its own: the MCP tools are taught once, in AGENTS.md.
    for (const path of ["CLAUDE.md", "GEMINI.md", ".cursor/rules/nifra.mdc"]) {
      expect(await read(path)).not.toContain("nifra_docs")
    }
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

describe("scaffold - --target and --docker", () => {
  test("each target gets its scripts, its config file and its runtime package", async () => {
    const expected = {
      bun: { start: "bun dist/server.js", deploy: undefined, files: [] },
      node: { start: "node dist/server.js", deploy: undefined, files: [] },
      deno: {
        start: "deno run --allow-net --allow-read --allow-env dist/server.js",
        deploy: "deployctl deploy --prod --entrypoint=dist/server.js",
        files: ["deno.json"],
      },
      cloudflare: {
        start: "wrangler pages dev dist --binding NIFRA_ALLOW_MEMORY_RATE_LIMIT=true",
        deploy: "wrangler pages deploy dist",
        files: ["wrangler.toml"],
      },
      vercel: { start: undefined, deploy: "vercel deploy --prebuilt", files: [] },
    } as const
    for (const [target, want] of Object.entries(expected)) {
      const dir = await freshDir(`t-${target}`)
      await scaffold({ target: dir, template: "site", deployTarget: target })
      const pkg = (await readPkg(dir)) as {
        scripts?: Record<string, string>
        dependencies?: Record<string, string>
      }
      expect(pkg.scripts?.build).toBe("nifra build")
      expect(pkg.scripts?.start).toBe(want.start)
      expect(pkg.scripts?.deploy).toBe(want.deploy)
      expect(pkg.dependencies?.["@nifrajs/node"] !== undefined).toBe(target === "node")
      for (const file of ["deno.json", "wrangler.toml", "Dockerfile"]) {
        expect(await exists(join(dir, file))).toBe((want.files as readonly string[]).includes(file))
      }
    }
  })

  test("--docker adds an image for a self-hosting server and deploys it", async () => {
    const dir = await freshDir("dock-app")
    const res = await scaffold({
      target: dir,
      template: "site",
      deployTarget: "node",
      docker: true,
    })
    expect(res.deploy).toEqual({ target: "node", label: "Node", docker: true })
    expect((await readPkg(dir)).scripts?.deploy).toBe(
      "docker build -t dock-app . && docker run -p 3000:3000 dock-app",
    )
    const dockerfile = await readFile(join(dir, "Dockerfile"), "utf8")
    expect(dockerfile).toContain("RUN bun run build")
    expect(dockerfile).toContain("FROM node:22-slim AS run")
    expect(dockerfile).toContain('CMD ["node", "dist/server.js"]')
    expect(await exists(join(dir, ".dockerignore"))).toBe(true)

    const bun = await freshDir("bun-dock")
    await scaffold({ target: bun, template: "site", docker: true })
    expect(await readFile(join(bun, "Dockerfile"), "utf8")).toContain(
      'CMD ["bun", "dist/server.js"]',
    )
  })

  test("--docker on a platform target, and cf-pages, are refused", async () => {
    await expect(
      scaffold({
        target: await freshDir("x"),
        template: "site",
        deployTarget: "vercel",
        docker: true,
      }),
    ).rejects.toThrow("--docker builds a self-hosting server image (bun or node)")
    await expect(
      scaffold({ target: await freshDir("y"), template: "site", deployTarget: "cf-pages" }),
    ).rejects.toThrow('the deploy target "cf-pages" is now "cloudflare"')
  })
})

describe("scaffold - rejections", () => {
  test("unknown template", async () => {
    const dir = await freshDir("x")
    await expect(scaffold({ target: dir, template: "nope" as "api" })).rejects.toThrow(
      /unknown template/,
    )
  })

  test("--target or --docker with a non-site template", async () => {
    await expect(
      scaffold({ target: await freshDir("x"), template: "api", deployTarget: "vercel" }),
    ).rejects.toThrow(/--target requires the site template/)
    await expect(
      scaffold({ target: await freshDir("y"), template: "api", docker: true }),
    ).rejects.toThrow(/--docker requires the site template/)
  })

  test("unknown deploy target", async () => {
    const dir = await freshDir("x")
    await expect(
      scaffold({ target: dir, template: "site", deployTarget: "heroku" }),
    ).rejects.toThrow(/unknown deploy target/)
  })

  test("refuses to overwrite an existing directory", async () => {
    const dir = await freshDir("twice")
    await scaffold({ target: dir, template: "api" })
    await expect(scaffold({ target: dir, template: "api" })).rejects.toThrow()
  })

  // The name is substituted into deploy scripts a shell runs, so a metacharacter or a leading `-` is
  // refused. Ordinary directory names that npm accepts are not.
  test("a project name with shell metacharacters or a leading dash is refused", async () => {
    for (const bad of ["my app", "a;rm -rf /", "$(id)", "-rf", "a`id`", ".hidden", "_priv"]) {
      const dir = await freshDir(bad)
      await expect(scaffold({ target: dir, template: "api" })).rejects.toThrow(
        /invalid project name/,
      )
    }
  })

  test("npm-legal names that are not lowercase-and-hyphens are accepted", async () => {
    for (const good of ["MyApp", "my_app", "app.v2", "app2"]) {
      const dir = await freshDir(good)
      await scaffold({ target: dir, template: "api" })
      expect((await readPkg(dir)).name).toBe(good)
    }
  })
})

// Exercise the CLI's run() flow (argv parse → scaffold → next-steps message / exit code) in-process.
describe("run (argv → code + message)", () => {
  test("scaffolds + returns target-specific next steps, code 0", async () => {
    const dir = await freshDir("run-vc")
    const { code, message } = await run([dir, "--target", "vercel"])
    expect(code).toBe(0)
    expect(message).toContain("(Vercel)")
    expect(message).toContain("bun run deploy       # vercel deploy --prebuilt")
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

  test.each([
    ["api"],
    ["site"],
  ])("%s into a directory with files of its own → refused, and none of its files replaced", async (template) => {
    const dir = await freshDir(`occupied-${template}`)
    await mkdir(join(dir, ".github"), { recursive: true })
    const mine: Record<string, string> = {
      ".gitignore": "mine\n",
      "AGENTS.md": "mine\n",
      "CLAUDE.md": "mine\n",
      ".mcp.json": "{}\n",
      ".github/copilot-instructions.md": "mine\n",
    }
    for (const [file, contents] of Object.entries(mine)) await writeFile(join(dir, file), contents)
    const { code, message } = await run([dir, "--template", template])
    expect(code).toBe(1)
    expect(message).toMatch(/already exists/)
    for (const [file, contents] of Object.entries(mine)) {
      expect(await readFile(join(dir, file), "utf8")).toBe(contents)
    }
    expect(await exists(join(dir, "package.json"))).toBe(false)
  })

  test("an existing empty directory is scaffolded without --force", async () => {
    const dir = await freshDir("empty")
    await mkdir(dir, { recursive: true })
    await scaffold({ target: dir, template: "api" })
    expect(await exists(join(dir, "package.json"))).toBe(true)
  })

  test('"." names the project after the directory it is run in', async () => {
    const dir = await freshDir("here-app")
    await mkdir(dir, { recursive: true })
    const previous = process.cwd()
    process.chdir(dir)
    try {
      expect((await run([".", "--force"])).code).toBe(0)
    } finally {
      process.chdir(previous)
    }
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name).toBe("here-app")
  })

  test("unknown deploy target → error, code 1", async () => {
    const dir = await freshDir("run-bad")
    const { code, message } = await run([dir, "--target", "heroku"])
    expect(code).toBe(1)
    expect(message).toContain("unknown deploy target")
  })

  test("the retired --deploy → its replacement, code 1", async () => {
    const { code, message } = await run([await freshDir("run-old"), "--deploy", "node"])
    expect(code).toBe(1)
    expect(message).toContain("--deploy is now --target")
  })
})

// One end-to-end check that the published binary actually parses argv, scaffolds, and exits 0.
describe("CLI binary (subprocess)", () => {
  test("bun create-nifra <dir> --target node --docker → exit 0, scaffolded", async () => {
    const dir = await freshDir("cli-e2e")
    const { code, stdout } = await runCli([dir, "--target", "node", "--docker"])
    expect(code).toBe(0)
    expect(stdout).toContain("Created")
    expect(await exists(join(dir, "Dockerfile"))).toBe(true)
  })
})

describe("scaffold - --framework", () => {
  test("react (default) → template-site; vue → template-site-vue", async () => {
    const r = await freshDir("fw-react")
    await scaffold({ target: r, template: "site", framework: "react" })
    expect(await readFile(join(r, "backend", "framework.ts"), "utf8")).toContain("reactAdapter")

    const v = await freshDir("fw-vue")
    const res = await scaffold({ target: v, template: "site", framework: "vue" })
    expect(res.framework).toBe("vue")
    expect(await readFile(join(v, "backend", "framework.ts"), "utf8")).toContain("vueAdapter")
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
      expect(await readFile(join(dir, "backend", "framework.ts"), "utf8")).toContain(adapter)
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>
      }
      expect(pkg.dependencies?.[`@nifrajs/web-${fw}`]).toBeTruthy()
    }
  })

  test("site templates ship a nifra.config.ts + a `nifra dev` script (CLI inner loop)", async () => {
    // React needs no Vite plugin because JSX is Bun-native. Vue keeps its official Vite plugin plus
    // clientPlugins/serverPlugins for the two supported production/dev paths.
    const cases: Array<[string | undefined, string, boolean]> = [
      [undefined, "@nifrajs/web-react/client", false],
      ["vue", "@nifrajs/web-vue/client", true],
    ]
    for (const [framework, clientModule, hasVitePlugins] of cases) {
      const dir = await freshDir(`cli-${framework ?? "react"}`)
      await scaffold({ target: dir, template: "site", ...(framework ? { framework } : {}) })

      // nifra.config.ts is the CLI's config (separate from the edge-imported backend/framework.ts).
      const config = await readFile(join(dir, "nifra.config.ts"), "utf8")
      expect(config).toContain('export { adapter } from "./backend/framework"')
      expect(config).toContain(`export const clientModule = "${clientModule}"`)
      if (hasVitePlugins) expect(config).toContain("vitePlugins")
      else expect(config).not.toContain("vitePlugins")

      // backend/framework.ts stays minimal (adapter only) so it doesn't drag dev/compiler deps into the
      // worker.
      expect(await readFile(join(dir, "backend", "framework.ts"), "utf8")).not.toContain(
        "vitePlugins",
      )

      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      expect(pkg.scripts?.dev).toBe("nifra dev")
      expect(pkg.scripts?.build).toBe("nifra build")
      expect(pkg.devDependencies?.["@nifrajs/cli"]).toBeTruthy()
      expect(pkg.devDependencies?.vite).toBeTruthy()
    }
  })

  test("composes with --target (Vue + Vercel)", async () => {
    const dir = await freshDir("fw-vue-vc")
    const res = await scaffold({
      target: dir,
      template: "site",
      framework: "vue",
      deployTarget: "vercel",
    })
    expect(res.framework).toBe("vue")
    expect(res.deploy?.label).toBe("Vercel")
    const config = await readFile(join(dir, "nifra.config.ts"), "utf8")
    expect(config).toContain("vitePlugins")
    expect(config).toEndWith('export const target = "vercel"\n')
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

/**
 * The framework-agnostic files must be byte-identical in every site a user can scaffold.
 *
 * This used to compare the four `template-site-<framework>` directories against `template-site`,
 * because they were four hand-maintained copies that could drift - and did. Composition makes drift
 * impossible for these by construction, so the assertion moves to where it still has teeth: the
 * COMPOSED output. It now fails if `SHARED_SITE_FILES` ever lists a file that is not actually shared,
 * which is the way this invariant can still break.
 */
describe("scaffold parity", () => {
  test("every framework's site shares the agnostic files byte for byte", async () => {
    const { scaffolds, cleanup } = await materializeAll()
    const sites = scaffolds.filter((entry) => entry.label.startsWith("site-"))
    const [first, ...rest] = sites
    if (first === undefined) throw new Error("no site scaffolds were composed")

    for (const file of SHARED_SITE_FILES) {
      const expected = await readFile(join(first.dir, file), "utf8")
      for (const site of rest) {
        const actual = await readFile(join(site.dir, file), "utf8")
        expect(actual, `${file} differs between ${first.label} and ${site.label}`).toBe(expected)
      }
    }
    await cleanup()
  })
})

describe("CI workflows (--ci github)", () => {
  test("parseArgs takes --ci/-c and implies the site template", () => {
    expect(parseArgs(["my-app", "--target", "vercel", "--ci", "github"])).toEqual({
      target: "my-app",
      template: "site",
      deployTarget: "vercel",
      ci: "github",
    })
    expect(parseArgs(["x", "-c", "github"])).toEqual({
      target: "x",
      template: "site",
      ci: "github",
    })
  })

  test("githubDeployWorkflow: cloudflare uses wrangler-action + names the project + lists secrets", () => {
    const yml = githubDeployWorkflow("cloudflare", "my-app")
    expect(yml).toContain("cloudflare/wrangler-action@9acf94ace14e7dc412b076f2c5c20b8ce93c79cd")
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
    expect(deno).toContain("denoland/deployctl@87e43e57b2336bcaf96bcd193687edcb3c5795c1")
    expect(deno).toContain("project: x")
    expect(deno).toContain("id-token: write") // OIDC
  })

  test("githubDeployWorkflow: self-hosted bun/node ship an artifact + a host-specific placeholder", () => {
    for (const t of ["bun", "node"]) {
      const yml = githubDeployWorkflow(t, "x")
      expect(yml).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02")
      expect(yml).toContain("Self-hosted: deploy is host-specific")
      expect(yml).toContain("No deploy secrets required")
    }
  })

  test("scaffold writes .github/workflows/deploy.yml for the chosen target", async () => {
    const dir = await freshDir("ci-app")
    const res = await scaffold({
      target: dir,
      template: "site",
      deployTarget: "cloudflare",
      ci: "github",
    })
    expect(res.ci).toBe("github")
    expect(res.ciSecrets).toEqual(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
    const wf = await readFile(join(dir, ".github/workflows/deploy.yml"), "utf8")
    expect(wf).toContain("command: pages deploy dist --project-name=ci-app")
  })

  test("--ci deploys the site's target (bun by default); only 'github' is known", async () => {
    const dir = await freshDir("a")
    const res = await scaffold({ target: dir, template: "site", ci: "github" })
    expect(res.ciSecrets).toEqual([])
    expect(await readFile(join(dir, ".github/workflows/deploy.yml"), "utf8")).toContain(
      "Self-hosted: deploy is host-specific",
    )
    await expect(
      scaffold({
        target: await freshDir("b"),
        template: "site",
        deployTarget: "vercel",
        ci: "gitlab",
      }),
    ).rejects.toThrow(/unknown --ci/)
    await expect(
      scaffold({ target: await freshDir("c"), template: "api", ci: "github" }),
    ).rejects.toThrow(/--ci requires the site template/)
  })

  test("run(): next steps surface the workflow + the secrets to set", async () => {
    const { code, message } = await run([
      await freshDir("ci-run"),
      "--target",
      "cloudflare",
      "-c",
      "github",
    ])
    expect(code).toBe(0)
    expect(message).toContain("set repo secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID")
    expect(message).toContain("CI builds + deploys on push")
  })
})

describe("scaffold - --db (Drizzle presets)", () => {
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

    expect(await readFile(join(dir, "backend/db/schema.ts"), "utf8")).toContain("sqliteTable")
    const client = await readFile(join(dir, "backend/db/index.ts"), "utf8")
    expect(client).toContain("@libsql/client")
    expect(client).toContain("export const db")
    const drizzleConfig = await readFile(join(dir, "drizzle.config.ts"), "utf8")
    expect(drizzleConfig).toContain('dialect: "turso"')
    expect(drizzleConfig).toContain('schema: "./backend/db/schema.ts"')
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
    expect(await readFile(join(dir, "backend/db/schema.ts"), "utf8")).toContain("pgTable")
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
    expect(await readFile(join(dir, "backend/db/index.ts"), "utf8")).toContain("bun:sqlite")
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

  // Config and tooling at the root are out of scope (no build loads them); every module is zoned.
  for (const template of ["site", "api"] as const) {
    test(`a ${template} scaffold with --db and --auth keeps every module in a zone`, async () => {
      const dir = await freshDir(`zoned-${template}`)
      await scaffold({ target: dir, template, db: "drizzle-libsql", auth: "better-auth" })
      const { createZoneClassifier } = await import("../../web/src/zones.ts")
      const zones = createZoneClassifier({ appRoot: dir })
      const tooling = new Set(["nifra.config.ts", "nifra.assurance.ts", "drizzle.config.ts"])
      const unzoned = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: dir })].filter(
        (file) => !tooling.has(file) && zones.classify(file).zone === "error",
      )
      expect(unzoned).toEqual([])
    })
  }

  test("without --db the app stays db-free (no backend/db/ directory)", async () => {
    const dir = await freshDir("plain")
    await scaffold({ target: dir })
    const dbDirExists = await stat(join(dir, "backend/db")).then(
      () => true,
      () => false,
    )
    expect(dbDirExists).toBe(false)
  })
})

describe("scaffold - --db (Prisma + Kysely presets)", () => {
  test("prisma-postgres wires schema.prisma (postgresql), a singleton client, scripts, and AGENTS", async () => {
    const dir = await freshDir("my-prisma-pg")
    const res = await scaffold({ target: dir, db: "prisma-postgres" })
    expect(res.db).toBe("prisma-postgres")

    const schema = await readFile(join(dir, "prisma/schema.prisma"), "utf8")
    expect(schema).toContain('provider = "postgresql"')
    expect(schema).toContain("model Note")
    expect(schema).toContain("@db.Timestamptz") // production-grade PG stamps
    const client = await readFile(join(dir, "backend/db/index.ts"), "utf8")
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

    expect(await readFile(join(dir, "backend/db/schema.ts"), "utf8")).toContain(
      "export interface DB",
    )
    const client = await readFile(join(dir, "backend/db/index.ts"), "utf8")
    expect(client).toContain("PostgresDialect")
    expect(await readFile(join(dir, "backend/db/migrate.ts"), "utf8")).toContain("Migrator")
    expect(
      await readFile(join(dir, "backend/db/migrations/0001_create_notes.ts"), "utf8"),
    ).toContain("createTable")

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
      scripts: Record<string, string>
    }
    expect(pkg.dependencies.kysely).toBeDefined()
    expect(pkg.dependencies.pg).toBeDefined()
    expect(pkg.scripts["db:migrate"]).toBe("bun run backend/db/migrate.ts")

    const md = await readFile(join(dir, "AGENTS.md"), "utf8")
    expect(md).toContain("## Database (Kysely + Postgres)")
    expect(md).toContain("c.db.selectFrom") // Kysely query idiom
  })
})

describe("scaffold - --auth (better-auth, composes with --db)", () => {
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

    const authTs = await readFile(join(dir, "backend/auth.ts"), "utf8")
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

    // No placeholder secret: better-auth only warns about a weak one, but refuses an empty one in
    // production. A short secret set by hand is refused by the generated module itself.
    expect(env).toContain('BETTER_AUTH_SECRET=""')
    expect(env).not.toContain("change-me")
    expect(authTs).toContain(
      'process.env.NODE_ENV === "production" && secret && secret.length < 32',
    )

    const md = await readFile(join(dir, "AGENTS.md"), "utf8")
    expect(md).toContain("## Authentication (better-auth)")
    expect(md).toContain(".use(betterAuth(auth))")
  })

  test("maps the Drizzle dialect to better-auth's provider (postgres → pg)", async () => {
    const dir = await freshDir("pg-auth")
    await scaffold({ target: dir, db: "drizzle-postgres", auth: "better-auth" })
    expect(await readFile(join(dir, "backend/auth.ts"), "utf8")).toContain('provider: "pg"')
  })

  test("uses the Prisma adapter for a Prisma DB (provider: postgresql, not Drizzle's pg)", async () => {
    const dir = await freshDir("prisma-auth")
    await scaffold({ target: dir, db: "prisma-postgres", auth: "better-auth" })
    const authTs = await readFile(join(dir, "backend/auth.ts"), "utf8")
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

describe("run - db/auth next steps + --link dependency rewriting", () => {
  test("db + auth scaffold surfaces the migration workflow in order", async () => {
    const { code, message } = await run([
      await freshDir("with-auth"),
      "--db",
      "drizzle-sqlite",
      "--auth",
      "better-auth",
    ])
    expect(code).toBe(0)
    expect(message).toContain("BETTER_AUTH_SECRET")
    expect(message).toContain("@better-auth/cli@latest generate")
    expect(message).toContain("bun run db:generate")
    expect(message).toContain("bun run db:migrate")
    expect(message).toContain("better-auth") // preset tag in the header
  })

  test("--link rewrites @nifrajs/* deps that exist in the linked repo to file: paths", async () => {
    // A fake nifra monorepo exposing only @nifrajs/core - other deps must stay on the registry.
    const linkRoot = await mkdtemp(join(tmpdir(), "nifra-link-"))
    roots.push(linkRoot)
    await mkdir(join(linkRoot, "packages/core"), { recursive: true })
    await writeFile(
      join(linkRoot, "packages/core/package.json"),
      JSON.stringify({ name: "@nifrajs/core", version: "0.0.0" }),
    )
    const dir = await freshDir("linked-app")
    const { code, message } = await run([dir, "--link", linkRoot])
    expect(code).toBe(0)
    expect(message).toContain("packages linked from")
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies["@nifrajs/core"]).toStartWith("file:")
    // Every remaining @nifrajs dep keeps its registry range (not present in the fake link repo).
    for (const [name, range] of Object.entries(pkg.dependencies)) {
      if (name.startsWith("@nifrajs/") && name !== "@nifrajs/core") {
        expect(range).not.toStartWith("file:")
      }
    }
  })
})

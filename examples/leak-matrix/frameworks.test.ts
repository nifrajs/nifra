import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import mdx from "@mdx-js/rollup"
import { mdxBunPlugin } from "@nifrajs/content/mdx"
import { buildClient, serverFnStubPlugin, zoneGuardPlugin } from "@nifrajs/web/build"
import { buildClientVite } from "@nifrajs/web/build-vite"
import { createViteDevServer } from "@nifrajs/web/vite"
import { solidBunPlugin } from "@nifrajs/web-solid/plugin"
import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"
import { vueBunPlugin } from "@nifrajs/web-vue/plugin"
import preact from "@preact/preset-vite"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import react from "@vitejs/plugin-react"
import vue from "@vitejs/plugin-vue"
import type { BunPlugin } from "bun"
import solid from "vite-plugin-solid"

/**
 * The leak matrix's framework axis: the route-level leak paths in each framework's own syntax, against
 * both client builds and both dev servers. Module-level paths (aliases, packages, barrels, workers, ...)
 * do not depend on how a page compiles; `packages/web/test/leak-matrix.test.ts` covers those. Lives in
 * the examples workspace, the one package with every adapter and every framework's Vite plugin.
 */

type Pipeline = "bun-build" | "vite-build" | "bun-dev" | "vite-dev"

interface Framework {
  readonly name: string
  readonly ext: string
  readonly clientModule: string
  readonly bunPlugins: () => BunPlugin[]
  readonly conditions?: readonly string[]
  readonly vitePlugins: () => unknown[]
  readonly files?: Readonly<Record<string, string>>
  readonly pages: {
    /** Imports `rows` from `../backend/db.ts` and renders it. */
    readonly importsBackend: string
    /** Exports a `loader`. */
    readonly loaderInPage: string
    /** Reads `process.env.SESSION_SECRET` where it renders. */
    readonly privateEnv: string
    /** Renders `data.label` and `format(2)` from `../shared/format.ts`. */
    readonly clean: string
  }
}

const TSX = {
  importsBackend:
    'import { rows } from "../backend/db.ts"\nexport default function Page() { return <p>{rows().length}</p> }\n',
  loaderInPage:
    "export async function loader() { return { n: 1 } }\nexport default function Page() { return <p>hi</p> }\n",
  privateEnv: "export default function Page() { return <p>{process.env.SESSION_SECRET}</p> }\n",
  clean:
    'import { format } from "../shared/format.ts"\nexport default function Page(props: { data: { label: string } }) { return <p>{props.data.label} {format(2)}</p> }\n',
}

const FRAMEWORKS: readonly Framework[] = [
  {
    name: "React",
    ext: "tsx",
    clientModule: "@nifrajs/web-react/client",
    bunPlugins: () => [],
    vitePlugins: () => [react()],
    pages: TSX,
  },
  {
    name: "Preact",
    ext: "tsx",
    clientModule: "@nifrajs/web-preact/client",
    bunPlugins: () => [],
    vitePlugins: () => [preact()],
    files: {
      "tsconfig.json": '{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "preact" } }',
    },
    pages: TSX,
  },
  {
    name: "Solid",
    ext: "tsx",
    clientModule: "@nifrajs/web-solid/client",
    bunPlugins: () => [solidBunPlugin("dom")],
    conditions: ["bun", "browser"],
    vitePlugins: () => [solid()],
    pages: TSX,
  },
  {
    name: "Svelte",
    ext: "svelte",
    clientModule: "@nifrajs/web-svelte/client",
    bunPlugins: () => [svelteBunPlugin("dom")],
    conditions: ["bun", "browser"],
    vitePlugins: () => [svelte()],
    pages: {
      importsBackend:
        '<script>\n  import { rows } from "../backend/db.ts"\n</script>\n<p>{rows().length}</p>\n',
      loaderInPage:
        "<script module>\n  export async function loader() { return { n: 1 } }\n</script>\n<p>hi</p>\n",
      privateEnv: "<p>{process.env.SESSION_SECRET}</p>\n",
      clean:
        '<script>\n  import { format } from "../shared/format.ts"\n  let { data } = $props()\n</script>\n<p>{data.label} {format(2)}</p>\n',
    },
  },
  {
    name: "Vue",
    ext: "vue",
    clientModule: "@nifrajs/web-vue/client",
    bunPlugins: () => [vueBunPlugin("dom")],
    conditions: ["bun", "browser"],
    vitePlugins: () => [vue()],
    pages: {
      importsBackend:
        '<script setup lang="ts">\nimport { rows } from "../backend/db.ts"\n</script>\n<template><p>{{ rows().length }}</p></template>\n',
      loaderInPage:
        '<script lang="ts">\nexport async function loader() { return { n: 1 } }\nexport default {}\n</script>\n<template><p>hi</p></template>\n',
      privateEnv: "<template><p>{{ process.env.SESSION_SECRET }}</p></template>\n",
      clean:
        '<script setup lang="ts">\nimport { format } from "../shared/format.ts"\ndefineProps<{ data: { label: string } }>()\n</script>\n<template><p>{{ data.label }} {{ format(2) }}</p></template>\n',
    },
  },
  {
    name: "MDX",
    ext: "mdx",
    clientModule: "@nifrajs/web-react/client",
    bunPlugins: () => [mdxBunPlugin({ jsxImportSource: "react" })],
    vitePlugins: () => [mdx({ jsxImportSource: "react" }), react()],
    pages: {
      importsBackend: 'import { rows } from "../backend/db.ts"\n\n# Rows {rows().length}\n',
      loaderInPage: "export async function loader() { return { n: 1 } }\n\n# Hi\n",
      privateEnv: "# Secret\n\n{process.env.SESSION_SECRET}\n",
      clean:
        'import { format } from "../shared/format.ts"\n\n# Hello {props.data.label} {format(2)}\n',
    },
  },
]

const BACKEND_MARKER = "nifra-leak-matrix-backend-source"
const COMMON = {
  "backend/db.ts": `export const rows = () => ["${BACKEND_MARKER}"]\n`,
  "shared/format.ts": 'export const format = (n: number) => "#" + String(n)\n',
}

interface Case {
  readonly name: string
  readonly page: (framework: Framework) => string
  readonly backendHalf?: string
  readonly expect: (framework: Framework) => Partial<Record<Pipeline, string | null>>
}

const CASES: readonly Case[] = [
  {
    name: "a page importing backend code",
    page: (f) => f.pages.importsBackend,
    expect: (f) => ({
      "bun-build": "backend/db.ts: it is backend code",
      "vite-build": "backend/db.ts: it is backend code",
      "bun-dev": "backend/db.ts may not reach the browser: it is backend code",
      "vite-dev": `backend/db.ts may not reach the browser (imported by routes/index.${f.ext})`,
    }),
  },
  {
    name: "a loader exported by the page",
    page: (f) => f.pages.loaderInPage,
    expect: (f) => ({
      "bun-build": `"routes/index.${f.ext}" exports "loader", which runs on the server only`,
      "vite-build": `"routes/index.${f.ext}" exports "loader", which runs on the server only`,
    }),
  },
  {
    name: "a private variable read where the page renders",
    page: (f) => f.pages.privateEnv,
    expect: () => {
      const message = "it reads private environment variable process.env.SESSION_SECRET"
      return {
        "bun-build": message,
        "vite-build": message,
        "bun-dev": message,
        "vite-dev": message,
      }
    },
  },
  {
    name: "a split route: page, backend half and shared code",
    page: (f) => f.pages.clean,
    backendHalf:
      'import { rows } from "../backend/db.ts"\nimport { format } from "../shared/format.ts"\nexport const loader = () => ({ label: format(rows().length) })\n',
    expect: () => ({ "bun-build": null, "vite-build": null, "bun-dev": null, "vite-dev": null }),
  },
]

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fixture(framework: Framework, kase: Case): string {
  // Inside the examples workspace, so every adapter and plugin resolves.
  const app = mkdtempSync(`${import.meta.dir}/.tmp-${framework.name.toLowerCase()}-`)
  roots.push(app)
  const files: Record<string, string> = {
    ...COMMON,
    ...framework.files,
    [`routes/index.${framework.ext}`]: kase.page(framework),
    ...(kase.backendHalf === undefined ? {} : { "routes/index.backend.ts": kase.backendHalf }),
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(app, path)), { recursive: true })
    writeFileSync(join(app, path), text)
  }
  return app
}

const emitted = (dir: string): string =>
  existsSync(dir)
    ? (readdirSync(dir, { recursive: true }) as string[])
        .map((file) => join(dir, file))
        .filter((file) => statSync(file).isFile())
        .map((file) => readFileSync(file, "utf8"))
        .join("\n")
    : ""

type Outcome =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly message: string }
const fail = (error: unknown): Outcome => ({
  ok: false,
  message: error instanceof Error ? error.message : String(error),
})

const RUN: Record<Pipeline, (app: string, framework: Framework) => Promise<Outcome>> = {
  async "bun-build"(app, f) {
    const outDir = join(app, "dist")
    try {
      await buildClient({
        routesDir: join(app, "routes"),
        outDir,
        clientModule: f.clientModule,
        plugins: f.bunPlugins(),
        ...(f.conditions ? { conditions: f.conditions } : {}),
        publicDir: false,
        minify: false,
      })
      return { ok: true, output: emitted(outDir) }
    } catch (error) {
      return fail(error)
    }
  },
  async "vite-build"(app, f) {
    const outDir = join(app, "dist")
    try {
      await buildClientVite({
        root: app,
        routesDir: join(app, "routes"),
        outDir,
        clientModule: f.clientModule,
        vitePlugins: f.vitePlugins(),
        publicDir: false,
        minify: false,
      })
      return { ok: true, output: emitted(outDir) }
    } catch (error) {
      return fail(error)
    }
  },
  async "bun-dev"(app, f) {
    const result = await Bun.build({
      entrypoints: [join(app, `routes/index.${f.ext}`)],
      target: "browser",
      throw: false,
      plugins: [zoneGuardPlugin({ appRoot: app }), serverFnStubPlugin(), ...f.bunPlugins()],
      ...(f.conditions ? { conditions: [...f.conditions] } : {}),
    } as Parameters<typeof Bun.build>[0])
    if (!result.success) return { ok: false, message: result.logs.map(String).join("\n") }
    return { ok: true, output: (await Promise.all(result.outputs.map((o) => o.text()))).join("\n") }
  },
  async "vite-dev"(app, f) {
    const server = await createViteDevServer({
      root: app,
      routesDir: join(app, "routes"),
      clientModule: f.clientModule,
      plugins: f.vitePlugins(),
      port: 0,
      createApp: () => ({ fetch: () => new Response("app") }),
    })
    try {
      const queue = [`/routes/index.${f.ext}`, "/shared/format.ts"]
      const seen = new Set(queue)
      const bodies: string[] = []
      for (let i = 0; i < queue.length && i < 100; i++) {
        const url = queue[i] as string
        const response = await fetch(`http://127.0.0.1:${server.port}${url}`)
        const body = await response.text()
        if (response.status !== 200) return { ok: false, message: `${url}: ${body}` }
        bodies.push(body)
        // Follow the app's own modules as a browser would; dependencies and Vite's own ids are not
        // the zones' concern here.
        for (const found of body.matchAll(/(?:from|import)\s*\(?\s*["'](\/[^"'@][^"']*)["']/g)) {
          const next = found[1] as string
          if (next.startsWith("/node_modules/") || seen.has(next)) continue
          seen.add(next)
          queue.push(next)
        }
      }
      return { ok: true, output: bodies.join("\n") }
    } finally {
      await server.stop()
    }
  },
}

describe.each(FRAMEWORKS.map((f) => [f.name, f] as const))("%s", (_name, framework) => {
  for (const kase of CASES) {
    for (const [pipeline, expected] of Object.entries(kase.expect(framework)) as [
      Pipeline,
      string | null,
    ][]) {
      test(`${kase.name}: ${pipeline} ${expected === null ? "passes" : "refuses"}`, async () => {
        const outcome = await RUN[pipeline](fixture(framework, kase), framework)
        if (expected === null) {
          if (!outcome.ok) throw new Error(`expected ${pipeline} to pass:\n${outcome.message}`)
          expect(outcome.output).not.toContain(BACKEND_MARKER)
          return
        }
        if (outcome.ok) throw new Error(`expected ${pipeline} to refuse with: ${expected}`)
        expect(outcome.message).toContain(expected)
        expect(outcome.message).not.toContain(BACKEND_MARKER)
      }, 90_000)
    }
  }
})

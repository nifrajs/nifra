/**
 * Build the "Same app, five frameworks" live demo for the /frameworks route.
 *
 * The honesty of the artifact: ONE catalog app (`bench/ssr/shared/catalog.ts` + the per-framework
 * components under `bench/ssr/`) is rendered through all five `@nifrajs/web` adapters to five HTML
 * fragments, and shipped as five REAL, separately-measured client hydration bundles. The numbers on the
 * page are the gzip sizes produced here — never hand-typed.
 *
 * Why a dedicated build step (not the worker): the catalog is static (50 fixed items), so everything is
 * prerendered here at build time and emitted as a generated module the static route reads. The request-
 * time worker (`_worker.ts`) stays React-only — it never loads five framework runtimes.
 *
 * Build-isolation rule (the load-bearing constraint): Solid's Babel plugin and Svelte's compiler plugin
 * each match a broad file filter (`.tsx` / `.svelte`) and WOULD transform the React/Preact `.tsx` if they
 * shared a `Bun.build`. Plugins do not leak across separate `Bun.build` calls, so every framework gets its
 * OWN isolated build with exactly its plugin. The Solid/Svelte SSR renderers are likewise prebuilt into
 * isolated modules and imported for their fragment (their components can't be `import`ed raw here).
 *
 *   bun run site/build-frameworks.ts   # standalone: refresh data/frameworks-demo.json + print sizes
 * Normally invoked by site/build.ts with the real `dist/assets` outDir.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { preactAdapter } from "@nifrajs/web-preact"
import { svelteDedupePlugin } from "@nifrajs/web/build"
import { reactAdapter } from "@nifrajs/web-react"
import { solidBunPlugin } from "@nifrajs/web-solid"
import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"
import { vueAdapter } from "@nifrajs/web-vue"
import type { BunPlugin } from "bun"
import { App as ReactApp } from "../bench/ssr/nifra/app.tsx"
import ReactLayout from "../bench/ssr/nifra/layout.tsx"
import { App as PreactApp } from "../bench/ssr/nifra-preact/app.ts"
import { App as VueApp } from "../bench/ssr/nifra-vue/app.ts"
import { type CatalogPageData, catalogItems } from "./frameworks/data.ts"

const DIR = import.meta.dir

// React ships its prod build only under NODE_ENV=production; Vue needs its feature flags defined or it
// warns + bloats. Each set matches the corresponding bench app's build so the measured sizes are real.
const PROD_DEFINE: Readonly<Record<string, string>> = { "process.env.NODE_ENV": '"production"' }
const VUE_DEFINE: Readonly<Record<string, string>> = {
  ...PROD_DEFINE,
  __VUE_OPTIONS_API__: "true",
  __VUE_PROD_DEVTOOLS__: "false",
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
}

/** A framework row: its display identity + the client entry + the build knobs that bundle differs by. */
interface FrameworkSpec {
  /** Stable id — drives the client-bundle filename (`fw-<id>.client.js`) and the toggle island. */
  readonly id: "react" | "preact" | "vue" | "solid" | "svelte"
  readonly label: string
  /** One-line idiom shown beside the row (matches the marketing /docs/frameworks framing). */
  readonly idiom: string
  /** The client hydration entry (under site/frameworks/) Bun.build bundles for the browser. */
  readonly clientEntry: string
  /** Module-resolution conditions — Solid needs its "solid" export condition. */
  readonly clientConditions: readonly string[]
  /** Bun build plugins for the client bundle (Solid/Svelte compile their components). */
  readonly clientPlugins: readonly BunPlugin[]
  readonly define: Readonly<Record<string, string>>
}

const SPECS: readonly FrameworkSpec[] = [
  {
    id: "react",
    label: "React 19",
    idiom: "hooks",
    clientEntry: `${DIR}/frameworks/react.client.ts`,
    clientConditions: ["bun", "browser"],
    clientPlugins: [],
    define: PROD_DEFINE,
  },
  {
    id: "preact",
    label: "Preact",
    idiom: "hooks (React-compat)",
    clientEntry: `${DIR}/frameworks/preact.client.ts`,
    clientConditions: ["bun", "browser"],
    clientPlugins: [],
    define: PROD_DEFINE,
  },
  {
    id: "vue",
    label: "Vue 3",
    idiom: "composables",
    clientEntry: `${DIR}/frameworks/vue.client.ts`,
    clientConditions: ["bun", "browser"],
    clientPlugins: [],
    define: VUE_DEFINE,
  },
  {
    id: "solid",
    label: "Solid",
    idiom: "fine-grained reactivity",
    clientEntry: `${DIR}/frameworks/solid.client.ts`,
    clientConditions: ["bun", "solid", "browser"],
    clientPlugins: [solidBunPlugin("dom")],
    define: PROD_DEFINE,
  },
  {
    id: "svelte",
    label: "Svelte 5",
    idiom: "runes",
    clientEntry: `${DIR}/frameworks/svelte.client.ts`,
    clientConditions: ["bun", "browser"],
    // svelteDedupePlugin first: pin svelte + svelte/internal/* to ONE copy (resolved from the site root)
    // so the adapter's Chain.svelte and the app's App.svelte hydrate against the SAME Svelte runtime —
    // without it the two resolve to different physical svelte@5.56.3 installs and hydration crashes.
    clientPlugins: [svelteDedupePlugin(DIR), svelteBunPlugin("dom")],
    define: PROD_DEFINE,
  },
]

/** The asset URL the toggle island fetches to make a framework live. Deterministic (no content hash) so
 * the route + island can reference it without threading the build manifest through. */
export const frameworkBundleUrl = (id: FrameworkSpec["id"]): string => `/assets/fw-${id}.client.js`

/** What the route consumes: identity + the prerendered fragment + the REAL measured gzip size. */
export interface FrameworkDemoEntry {
  readonly id: FrameworkSpec["id"]
  readonly label: string
  readonly idiom: string
  /** Server-rendered, hydration-ready markup for `#fw-stage`. */
  readonly fragmentHtml: string
  /** Per-document bootstrap the active framework's hydration needs (Solid only; "" otherwise). */
  readonly hydrationHead: string
  /** Client hydration bundle URL the toggle island loads when this row is active. */
  readonly bundleUrl: string
  /** Raw (pre-gzip) bundle bytes — the honest "download" stat alongside the gzip figure. */
  readonly bytesRaw: number
  /** gzip(level 9) bundle bytes — the headline number the size bars chart. */
  readonly bytesGzip: number
}

export interface BuildFrameworksResult {
  readonly entries: readonly FrameworkDemoEntry[]
  /** The shared, static catalog payload — embedded once into the page for every row to hydrate from. */
  readonly data: CatalogPageData
  readonly itemCount: number
}

interface BuildFrameworksOptions {
  /** Where the five `fw-<id>.client.js` bundles are written (the route serves them from /assets/*). */
  readonly outDir: string
}

/** Build one client bundle into `outDir` as `fw-<id>.client.js`, returning its raw + gzip byte sizes.
 * One isolated `Bun.build` per call — so each framework's compiler plugin stays scoped to its own files. */
async function buildClientBundle(
  spec: FrameworkSpec,
  outDir: string,
): Promise<{ bytesRaw: number; bytesGzip: number }> {
  const result = await Bun.build({
    entrypoints: [spec.clientEntry],
    outdir: outDir,
    target: "browser",
    conditions: [...spec.clientConditions],
    plugins: [...spec.clientPlugins],
    naming: `fw-${spec.id}.client.js`,
    minify: true,
    splitting: false,
    define: { ...spec.define },
  })
  if (!result.success) {
    throw new Error(
      `[nifra/site] ${spec.id} client bundle failed:\n${result.logs.map((l) => String(l)).join("\n")}`,
    )
  }
  const bundle = result.outputs.find((o) => o.path.endsWith(`fw-${spec.id}.client.js`))
  if (!bundle) {
    throw new Error(`[nifra/site] ${spec.id} client bundle produced no fw-${spec.id}.client.js`)
  }
  // Measure the bytes actually written to /assets — the exact payload the browser downloads.
  const bytes = await Bun.file(bundle.path).bytes()
  // Match the proven measurement: gzip level 9, the strongest deflate setting — the figure shown.
  const gzip = Bun.gzipSync(bytes, { level: 9 })
  return { bytesRaw: bytes.byteLength, bytesGzip: gzip.byteLength }
}

/** Render a framework's SSR fragment + hydration head. React/Preact/Vue render directly (no plugin
 * needed for the render call). Solid/Svelte are prebuilt into an isolated module — their components
 * can't be `import`ed into this file without their compiler plugin — and imported back for the fragment. */
async function renderFragment(
  spec: FrameworkSpec,
  data: CatalogPageData,
  scratchDir: string,
): Promise<{ fragmentHtml: string; hydrationHead: string }> {
  const props = { data }
  switch (spec.id) {
    case "react":
      // The React row keeps the Layout wrapper (`<div id="app">`), matching its `[Layout, App]` client
      // chain; the others have no layout in the bench app, so their chain is `[App]` alone.
      return {
        fragmentHtml: String(await reactAdapter.renderToString?.([ReactLayout, ReactApp], props)),
        hydrationHead: reactAdapter.hydrationHead(),
      }
    case "preact":
      return {
        fragmentHtml: String(await preactAdapter.renderToString?.([PreactApp], props)),
        hydrationHead: preactAdapter.hydrationHead(),
      }
    case "vue":
      return {
        fragmentHtml: String(await vueAdapter.renderToString?.([VueApp], props)),
        hydrationHead: vueAdapter.hydrationHead(),
      }
    case "solid":
    case "svelte": {
      // Prebuild the SSR renderer in isolation (its own compiler plugin) → import the built JS for the
      // fragment. The renderer module owns the catalog data, so the result matches the client chain.
      const ssrEntry = `${DIR}/frameworks/${spec.id}.ssr.ts`
      const ssrPlugin = spec.id === "solid" ? solidBunPlugin("ssr") : svelteBunPlugin("ssr")
      const ssrConditions = spec.id === "solid" ? ["bun", "solid"] : ["bun", "svelte"]
      const built = await Bun.build({
        entrypoints: [ssrEntry],
        outdir: join(scratchDir, spec.id),
        target: "bun",
        conditions: ssrConditions,
        plugins: [ssrPlugin],
        naming: "ssr.js",
        define: { ...spec.define },
      })
      if (!built.success) {
        throw new Error(
          `[nifra/site] ${spec.id} SSR build failed:\n${built.logs.map((l) => String(l)).join("\n")}`,
        )
      }
      const mod = (await import(join(scratchDir, spec.id, "ssr.js"))) as {
        renderFragment(): Promise<string>
        hydrationHead(): string
      }
      return { fragmentHtml: await mod.renderFragment(), hydrationHead: mod.hydrationHead() }
    }
  }
}

/**
 * Build all five client bundles + render all five SSR fragments. Returns the route-ready entries with
 * REAL measured gzip sizes. `writeFrameworksArtifact` (below) serializes this to the committed JSON the
 * route's typed wrapper (`site/frameworks/generated.ts`) reads.
 */
export async function buildFrameworks(
  options: BuildFrameworksOptions,
): Promise<BuildFrameworksResult> {
  const data: CatalogPageData = { items: catalogItems() }
  // Isolated scratch dir for the prebuilt Solid/Svelte SSR modules; removed before returning.
  const scratchDir = mkdtempSync(join(tmpdir(), "nifra-fw-ssr-"))
  try {
    const entries: FrameworkDemoEntry[] = []
    for (const spec of SPECS) {
      const [{ bytesRaw, bytesGzip }, { fragmentHtml, hydrationHead }] = await Promise.all([
        buildClientBundle(spec, options.outDir),
        renderFragment(spec, data, scratchDir),
      ])
      // Defence-in-depth: a fragment that lost its rows (a broken adapter import) would silently ship an
      // empty showcase. The catalog is exactly 50 items, so assert the count before it reaches the page.
      const liCount = (fragmentHtml.match(/<li/g) ?? []).length
      if (liCount !== data.items.length) {
        throw new Error(
          `[nifra/site] ${spec.id} fragment rendered ${liCount} <li> items, expected ${data.items.length}`,
        )
      }
      entries.push({
        id: spec.id,
        label: spec.label,
        idiom: spec.idiom,
        fragmentHtml,
        hydrationHead,
        bundleUrl: frameworkBundleUrl(spec.id),
        bytesRaw,
        bytesGzip,
      })
    }
    return { entries, data, itemCount: data.items.length }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
}

/** The serialized artifact `site/frameworks/generated.ts` re-exports (typed). Plain JSON-safe data only
 * — fragments are strings, sizes are numbers — so it round-trips through the committed `.json` cleanly. */
export interface FrameworksDemoArtifact {
  readonly entries: readonly FrameworkDemoEntry[]
  readonly data: CatalogPageData
  readonly itemCount: number
}

/** Default artifact path — committed JSON beside the other generated site data (benchmarks.json), so
 * the route's typed wrapper imports a real, reviewable file and a fresh checkout typechecks. */
export const FRAMEWORKS_ARTIFACT_PATH = join(DIR, "data", "frameworks-demo.json")

/** Build everything and write the route-ready JSON artifact. Called by site/build.ts BEFORE it bundles
 * the route (the route's typed wrapper imports this JSON), so the page always reflects this run's sizes. */
export async function writeFrameworksArtifact(
  options: BuildFrameworksOptions & { readonly artifactPath?: string },
): Promise<FrameworksDemoArtifact> {
  const { entries, data, itemCount } = await buildFrameworks(options)
  const artifact: FrameworksDemoArtifact = { entries, data, itemCount }
  writeFileSync(
    options.artifactPath ?? FRAMEWORKS_ARTIFACT_PATH,
    `${JSON.stringify(artifact, null, 2)}\n`,
  )
  return artifact
}

// Standalone smoke run: bundle into a throwaway dir (sizes are measured the same either way) and refresh
// the committed JSON artifact. Lets you update the route's data + verify sizes without a full site build.
if (import.meta.main) {
  const out = mkdtempSync(join(tmpdir(), "nifra-fw-out-"))
  try {
    const { entries, itemCount } = await writeFrameworksArtifact({ outDir: out })
    console.log(`frameworks demo — ${itemCount} items/row, ${entries.length} rows:`)
    for (const e of entries) {
      console.log(
        `  ${e.id.padEnd(7)} ${(e.bytesGzip / 1024).toFixed(2).padStart(6)} KB gzip` +
          ` (${(e.bytesRaw / 1024).toFixed(1)} KB raw)`,
      )
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

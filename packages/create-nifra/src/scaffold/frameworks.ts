/**
 * What a frontend framework contributes to a site scaffold.
 *
 * The five site templates were five directories of 26 files each, and 13 of those 26 were
 * byte-identical in all five - the Dockerfile, every server entry, the worker, the assurance config.
 * Editing the runtime story meant editing it five times and hoping. This session made the same
 * one-line `package.json` edit in eight files, which is the whole argument.
 *
 * So the runtime knowledge lives once (see `site.ts`), and a framework contributes only what is
 * genuinely its own: an adapter, a bundler plugin, the resolve conditions and defines its compiler
 * needs, and its dependency set. The prose a framework needs to explain ITSELF - why Solid wants a
 * `"solid"` resolve condition, what `@preact/preset-vite` is - stays in a real file next to it. That
 * is the line: mechanical differences are modelled, explanations are written.
 */

/** A `plugins: [x("dom")]` entry the framework's compiler needs in a Bun build. */
export interface BunPluginSpec {
  /** Module the plugin factory is imported from. */
  readonly specifier: string
  /** The factory's exported name. */
  readonly name: string
  /** Trailing comment on the call, when the framework has something to say about it. */
  readonly note?: { readonly dom: string; readonly ssr: string }
}

export interface FrameworkSpec {
  readonly id: string
  /** The adapter export, e.g. `reactAdapter`. */
  readonly adapter: string
  /** The adapter's package, e.g. `@nifrajs/web-react`. */
  readonly package: string
  /** Compiler plugin for `.vue`/`.svelte`/Solid JSX. Absent for the JSX-native frameworks. */
  readonly bunPlugin?: BunPluginSpec
  /** Resolve conditions this framework adds beyond the runtime's own. */
  readonly conditions?: { readonly client?: readonly string[]; readonly ssr?: readonly string[] }
  /** Build-time defines beyond `process.env.NODE_ENV`, in emission order. */
  readonly define?: Readonly<Record<string, string>>
  /** Comment above the hoisted `define`, when the framework's flags need explaining. */
  readonly defineNote?: string
  /** Runtime dependencies beyond the shared Nifra set, in emission order. */
  readonly runtimeDependencies: Readonly<Record<string, string>>
  /** Dev dependencies beyond `@nifrajs/cli`, `typescript` and `vite`, in emission order. */
  readonly devDependencies: Readonly<Record<string, string>>
  /** What this framework needs from `tsconfig.json`. */
  readonly typescript: {
    readonly jsx?: string
    readonly jsxImportSource?: string
    readonly types?: readonly string[]
    /** False when routes are not `.tsx` - Svelte's are `.svelte`, so the glob would match nothing. */
    readonly includeTsx?: boolean
  }
}

/**
 * The `@nifrajs/*` range a scaffolded site installs.
 *
 * One constant, because it used to be a regex sweep over eight `package.json` files in the release
 * script with nothing checking the result - and the script's own comment warns that a missed bump
 * ships templates installing the PREVIOUS release. `scaffold-version.test.ts` now fails when this
 * drifts from what core is publishing, so the footgun is a red test rather than a silent regression.
 */
export const NIFRA_DEP_RANGE = "^2.7.1"

/**
 * React is first because it is the default (`--framework` omitted scaffolds it), and because the
 * other four are most easily read as deltas from it.
 */
export const FRAMEWORK_SPECS: Readonly<Record<string, FrameworkSpec>> = {
  react: {
    id: "react",
    adapter: "reactAdapter",
    package: "@nifrajs/web-react",
    runtimeDependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
    devDependencies: {
      "@types/react": "^19.0.0",
      "@types/react-dom": "^19.0.0",
      "@vitejs/plugin-react": "^4.3.0",
    },
    typescript: { jsx: "react-jsx", types: ["react", "react-dom"] },
  },
  preact: {
    id: "preact",
    adapter: "preactAdapter",
    package: "@nifrajs/web-preact",
    runtimeDependencies: { preact: "^10.25.0" },
    devDependencies: { "@preact/preset-vite": "^2.9.0" },
    typescript: { jsx: "react-jsx", jsxImportSource: "preact" },
  },
  solid: {
    id: "solid",
    adapter: "solidAdapter",
    package: "@nifrajs/web-solid",
    runtimeDependencies: { "solid-js": "^1.9.0" },
    devDependencies: { "vite-plugin-solid": "^2.10.0" },
    typescript: { jsx: "preserve", jsxImportSource: "solid-js" },
    bunPlugin: { specifier: "@nifrajs/web-solid", name: "solidBunPlugin" },
    // Solid publishes a `solid` export condition that routes `solid-js` to its JSX source; without it
    // the bundler takes the pre-compiled build and hydration has nothing to attach to.
    conditions: { client: ["solid"], ssr: ["solid"] },
  },
  svelte: {
    id: "svelte",
    adapter: "svelteAdapter",
    package: "@nifrajs/web-svelte",
    runtimeDependencies: { svelte: "^5.3.0" },
    devDependencies: { "@sveltejs/vite-plugin-svelte": "^5.0.0" },
    typescript: { types: ["svelte"], includeTsx: false },
    bunPlugin: { specifier: "@nifrajs/web-svelte/plugin", name: "svelteBunPlugin" },
  },
  vue: {
    id: "vue",
    adapter: "vueAdapter",
    package: "@nifrajs/web-vue",
    runtimeDependencies: { vue: "^3.5.0" },
    devDependencies: { "@vitejs/plugin-vue": "^5.2.0", "@vue/compiler-sfc": "^3.5.0" },
    typescript: { jsx: "preserve" },
    bunPlugin: {
      specifier: "@nifrajs/web-vue/plugin",
      name: "vueBunPlugin",
      note: { dom: " // compile .vue SFCs → client bundle", ssr: " // compile .vue SFCs → SSR" },
    },
    // Vue reads these at build time to drop dev-only branches; leaving them undefined ships the
    // development runtime and warns about it on every boot.
    defineNote:
      '// Vue feature flags: silence "feature flag not explicitly defined" warnings + trim dev-only code.',
    define: {
      __VUE_OPTIONS_API__: '"true"',
      __VUE_PROD_DEVTOOLS__: '"false"',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: '"false"',
    },
  },
}

export const FRAMEWORK_IDS = Object.keys(FRAMEWORK_SPECS)

export function frameworkSpec(id: string): FrameworkSpec {
  const spec = FRAMEWORK_SPECS[id]
  if (spec === undefined) {
    throw new Error(`unknown framework "${id}". options: ${FRAMEWORK_IDS.join(", ")}`)
  }
  return spec
}

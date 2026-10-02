/**
 * What a frontend framework contributes to a site scaffold.
 *
 * The runtime knowledge lives once (see `site.ts`), and a framework contributes only what is genuinely
 * its own: an adapter, its dependency set and its tsconfig needs. The bundler plugin, resolve conditions
 * and defines its compiler needs live in its `nifra.config.ts`, with the prose that explains them - why
 * Solid wants a `"solid"` resolve condition, what `@preact/preset-vite` is. That is the line: mechanical
 * differences are modelled, explanations are written.
 */

export interface FrameworkSpec {
  readonly id: string
  /** The adapter export, e.g. `reactAdapter`. */
  readonly adapter: string
  /** The adapter's package, e.g. `@nifrajs/web-react`. */
  readonly package: string
  /** Runtime dependencies beyond the shared Nifra set, in emission order. */
  readonly runtimeDependencies: Readonly<Record<string, string>>
  /** Dev dependencies beyond `@nifrajs/cli`, `@types/bun`, `typescript` and `vite`, in emission order. */
  readonly devDependencies: Readonly<Record<string, string>>
  /** What this framework needs from `tsconfig.json`. */
  readonly typescript: {
    readonly jsx?: string
    readonly jsxImportSource?: string
    readonly types?: readonly string[]
    /**
     * The tsconfig `include` globs, when not `.ts` + `.tsx`. A framework whose routes are its own
     * component files lists them, or svelte-check, vue-tsc and the editor never type-check a route.
     */
    readonly include?: readonly string[]
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
export const NIFRA_DEP_RANGE = "^3.5.0"

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
    },
    typescript: { jsx: "react-jsx", types: ["react", "react-dom"] },
  },
  preact: {
    id: "preact",
    adapter: "preactAdapter",
    package: "@nifrajs/web-preact",
    runtimeDependencies: { preact: "^10.25.0" },
    devDependencies: {},
    typescript: { jsx: "react-jsx", jsxImportSource: "preact" },
  },
  solid: {
    id: "solid",
    adapter: "solidAdapter",
    package: "@nifrajs/web-solid",
    runtimeDependencies: { "solid-js": "^1.9.0" },
    devDependencies: { "vite-plugin-solid": "^2.10.0" },
    typescript: { jsx: "preserve", jsxImportSource: "solid-js" },
  },
  svelte: {
    id: "svelte",
    adapter: "svelteAdapter",
    package: "@nifrajs/web-svelte",
    runtimeDependencies: { svelte: "^5.3.0" },
    devDependencies: { "@sveltejs/vite-plugin-svelte": "^5.0.0" },
    typescript: { types: ["svelte"], include: ["**/*.ts", "**/*.svelte"] },
  },
  vue: {
    id: "vue",
    adapter: "vueAdapter",
    package: "@nifrajs/web-vue",
    runtimeDependencies: { vue: "^3.5.0" },
    devDependencies: { "@vitejs/plugin-vue": "^5.2.0", "@vue/compiler-sfc": "^3.5.0" },
    typescript: { jsx: "preserve", include: ["**/*.ts", "**/*.tsx", "**/*.vue"] },
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

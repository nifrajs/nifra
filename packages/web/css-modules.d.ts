/**
 * Ambient types for CSS asset imports handled by the `@nifrajs/web/plugins/*` Bun plugins
 * (`css-modules` + `scss`).
 *
 * Add to your app so the imports below are typed. Either reference it from a `.d.ts` in your project:
 *
 * ```ts
 * /// <reference types="@nifrajs/web/css-modules" />
 * ```
 *
 * or list it in `tsconfig.json` → `compilerOptions.types: ["@nifrajs/web/css-modules"]`.
 */

/** CSS Modules (`*.module.css`) → the scoped `{ originalClassName: scopedClassName }` map. */
declare module "*.module.css" {
  /** Keys are the source class names (asIs convention). */
  const classes: Readonly<Record<string, string>>
  export default classes
}

/** SCSS/SASS Modules (`*.module.scss` / `*.module.sass`) → the scoped class map (same as above). */
declare module "*.module.scss" {
  const classes: Readonly<Record<string, string>>
  export default classes
}
declare module "*.module.sass" {
  const classes: Readonly<Record<string, string>>
  export default classes
}

// Plain stylesheet imports are side-effect only (`import "./styles.scss"`); they bundle the CSS and
// expose no bindings. Declared so the import resolves under TypeScript.
declare module "*.scss" {}
declare module "*.sass" {}

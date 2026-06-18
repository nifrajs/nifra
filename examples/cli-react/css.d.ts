// Ambient types for CSS imports so TypeScript understands them. A nifra app includes this (one file).
// `*.module.css` → a typed, locally-scoped class map; `*.css` → a side-effect import (global stylesheet).
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>
  export default classes
}
declare module "*.css" {}

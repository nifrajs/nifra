---
"@nifrajs/cli": minor
---

`nifra check` (NF-C039) reads a contract imported from a workspace package, such as `@team/contracts/contract`, through that package's `exports`: subpaths, `*` patterns, and the `bun`, `import` and `default` conditions, plus `types` when it names a TypeScript source. A package linked from outside every `node_modules` counts as the workspace's; one installed from a registry is never read. The scan also follows `export * from` and `export { x } from` re-exports on the way to the contract, and reads a `...operations` spread of another operations object where that object is written. When the contract still cannot be read, the warning names the package and why.

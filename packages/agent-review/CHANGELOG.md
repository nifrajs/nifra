# @nifrajs/agent-review

## 5.10.0

No changes in this release.

## 5.9.0

### Patch Changes

- 7ee17d0: `nifra check --sarif` and the command catalog's check output map report entries to diagnostics through one step. The CLI's page rules read the routes manifest and a `createWebApp` call's options through shared helpers, the layout migration applies its text edits through one function, two source scans share one route-registration reader, the two sync commands share their output schema and flag, and the Python and Go SDK generators share their setup and map-type reading.
  
  `create-nifra` passes the flags it parsed to `scaffold` as they are.
  
  `@nifrajs/web`'s PostCSS and Sass plugins build their JS module through one function, its client-build guards share one import-chain search, a page route's failed loaders answer through one step, and the router and the live client build a route data request's headers through one function.
  
  `@nifrajs/web-svelte`'s Svelte and MDX plugins emit scoped CSS through the stylesheet emitter in `@nifrajs/web/plugins/kit`, as the other kit plugins do. The virtual stylesheet import they write is now `?nifra-svelte-css` (`?nifra-svelte-mdx-css` for MDX), and its resolved path stays slash-separated on Windows.
  
  `@nifrajs/mcp` builds its capabilities once for `initialize` and `server/discover`. `@nifrajs/agent-review`'s composer uses the parser's outcome rule and evidence order, and the parser reads its two string lists through one reader. `@nifrajs/pi` reads message text through one helper, and core's evidence report sorts its findings through one comparator.
- d6e6617: More helpers that several modules of a package each defined (SHA-256 to hex, the control-character check, code-unit string order, the child-process environment allowlist, realpath with a fallback, the MCP worker's console redirect and reply line) now have one definition per package. No API change. The `git diff` that `@nifrajs/coding-agent` runs now inherits `CI` like its other child processes.

## 5.8.0

No changes in this release.

## 5.7.0

No changes in this release.

## 5.6.0

No changes in this release.

## 5.5.1

No changes in this release.

## 5.5.0

No changes in this release.

## 5.4.0

No changes in this release.

## 5.3.0

No changes in this release.

## 5.2.1

No changes in this release.

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.

## 5.0.0

### Patch Changes

- 42153fb: `parseReviewReport` and `composeReviewReport` refuse, with `derived-field-mismatch`, a check whose `pass` or `fail` status disagrees with whether it references an error finding. A required check marked `fail` with no error finding can no longer compose a passing report.

## 4.0.2

## 4.0.1

## 4.0.0

## 3.5.0

### Patch Changes

- 6430334: Add the provider-neutral, content-free review report contract and expose `nifra review` through the CLI, authenticated agent RPC, and Workbench-safe view projections.

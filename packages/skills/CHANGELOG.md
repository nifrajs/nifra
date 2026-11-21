# @nifrajs/skills

## 5.17.0

No changes in this release.

## 5.16.0

### Minor Changes

- 77d1821: Give the failures the framework throws a stable code, a cause and a fix that `nifra explain` and the dev overlay return. The new codes cover components, partial prerendering, deployment output, live, route files, route configuration, the typed wire, storage keys, OpenAPI import, assurance and effect declarations, tools, content, jobs, i18n, schemas, build output and plugins, assets, CSP, CDN adapters, headers and cookies, WebSockets, cron, GraphQL, images, and the production traps: an in-memory store in production, `cors` credentials with a wildcard origin, a short secret, and middleware installed out of order.
  
  A validation message counts as nifra's own only when the error was thrown from inside an installed `@nifrajs` package, so an app's own error with similar wording keeps its own handling.
  
  Record React, Vue, Svelte, Preact and Solid development warnings in the dev feed under `NIFRA_REACT_WARNING`, `NIFRA_VUE_WARNING`, `NIFRA_SVELTE_DIAGNOSTIC`, `NIFRA_PREACT_DIAGNOSTIC` and `NIFRA_SOLID_DIAGNOSTIC`. A warning is listed with a warning mark and does not make `nifra errors` exit 1; Solid's error-severity codes and Preact's thrown errors still do.
  
  Export an error's stable code as the `nifra.error.code` span attribute, for nifra's own error classes and codes.
  
  Add the `nifra-errors` skill: every stable error and `nifra check` code with its cause and repair, generated from the same catalogs.

## 5.15.1

No changes in this release.

## 5.15.0

No changes in this release.

## 5.14.0

No changes in this release.

## 5.13.0

No changes in this release.

## 5.12.1

No changes in this release.

## 5.12.0

No changes in this release.

## 5.11.0

No changes in this release.

## 5.10.0

No changes in this release.

## 5.9.0

No changes in this release.

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

- 6b61e1a: The API skill's middleware list names `trimTrailingSlash` and `appendTrailingSlash`, the exports that exist, instead of a `trailingSlash` that does not.

## 4.0.2

## 4.0.1

## 4.0.0

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

### Minor Changes

- ab0db9e: Register the Nifra MCP server from the Claude Code plugin manifest, so installing the plugin brings up the live tools the skills point at instead of leaving them to a separate setup step. The launch spec stays unpinned so one installed plugin serves projects on different Nifra versions.

## 3.1.0

## 3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

### Minor Changes

- 6c2b38a: New package: `@nifrajs/skills` - portable agent skills for Nifra.

  Four `SKILL.md` bundles (`nifra`, `nifra-api`, `nifra-web`, `nifra-verify`) covering the core loop,
  typed routes and the never-throwing client, the full-stack client/server boundary, and the
  check/assure/capabilities gates. They teach shape and rules, not signatures: signatures come from the
  MCP server, which is typechecked against the version installed in the project being edited.

  One source, every surface - installable from npm on Pi (`pi install npm:@nifrajs/skills`), as a Claude
  Code plugin from the repo marketplace, or copied into any `skills/` directory.

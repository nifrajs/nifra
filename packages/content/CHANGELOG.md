# @nifrajs/content

## 5.7.0

No changes in this release.

## 5.6.0

### Patch Changes

- 9ebcb1f: Every `nifra mcp` project tool carries MCP tool annotations, so a host can tell the tools that only read the project from the ones that write files or run project code and ask before those. A tool that writes only under a flag, such as `nifra_review` with `fix` and `write`, is marked as a writer. A tool that imports the project's config or backend runs its top-level code, so `nifra_routes`, `nifra_context`, `nifra_openapi`, `nifra_diff`, `nifra_prove` and the `nifra_db_*` tools are marked as running project code. Each tool's input fields that had no description now have one. The `nifra --help` line for `nifra docs-mcp` names all six tools that server offers.
  
  `entry.html` from `@nifrajs/content` is documented as unsanitized Markdown output: render it with `trustHtml(entry.html)` for content you wrote, or run it through `sanitizeHtml(entry.html, yourSanitizer)` when contributors or a CMS write it. The `<Content>` examples in the React, Preact and Solid adapters show the `trustHtml` call.

## 5.5.1

No changes in this release.

## 5.5.0

### Patch Changes

- 6ca916c: A collection with `watch` on re-reads a file that was replaced in place with the same size and modification time, as a deploy or sync tool does when it preserves times. Its cache recognised a file by size and mtime alone, so `get()` and `all()` kept serving the old content until either changed. The cache now also compares the file's device, inode and change time.

## 5.4.0

No changes in this release.

## 5.3.0

### Patch Changes

- 7d7bbe4: `defineCollection` takes `watch: false` to list and parse its directory once and return that snapshot from every later `all()`. The default still lists the directory and stats every file per call, which costs 3.5 ms per `all()` at 2,000 files; with `watch: false` it costs 0.005 ms. A file deleted and recreated with the same size and modification time is also read again, where a parse cached before the deletion used to be returned.

## 5.2.1

No changes in this release.

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.

## 5.1.0

No changes in this release.

## 5.0.0

### Patch Changes

- 1f81be1: `defineCollection` reads the directory, stats and files with async file IO. It used the synchronous calls inside `all()` and `get()`, which blocked a long-lived server's event loop for the whole read.
- 5f867e3: `collection.get(slug)` now throws for an entry whose frontmatter fails to parse or validate, as `all()` does, and returns `null` only when no file exists for the slug. A broken entry used to look like a missing one, so a page answered 404 instead of surfacing the error.

## 4.0.2

## 4.0.1

## 4.0.0

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

### Patch Changes

- f34a050: Record the pending source changes for these packages in their release notes so fixed-version publishing does not omit their changelog entries.

## 3.1.0

## 3.0.0

### Patch Changes

- 6e43c15: A failed boundary load no longer publishes the thrown error's own message. Boundary states are serialized into the document, so a driver or fetch failure was putting hosts, credentials, and query text on the page for every visitor who loaded it while the dependency was down. The client slot is now always `Boundary failed`, an `Error` subclass name is withheld for the same reason it names the failing internal library, and the real error is reported to the server console - the split already used for a rejected deferred value. A boundary that wants to show the user something specific catches its own failure inside `load` and returns that as data.

  Opt-in outbound WebSocket validation (`validateSend`) contains a rejected diagnostic instead of recursing. An `error()` handler that answers a dropped frame by sending one of its own re-entered the reporter through the two paths that bypassed its guard - schema rejection and an async validator - and unwound only when the stack was exhausted, silently. Every failure path now reports through the guard.

  A content index cursor is checked for the query that issued it separately from running off the end: a cursor from a different sort or filter is rejected at any position, and a matching cursor left past the last row by an index that shrank between pages returns an exhausted page rather than throwing.

- 86a555b: The roadmap contract surfaces are now shipped across the public packages: shared island triggers,
  typed content indexes and joins, client loader/action hooks, and unified static, dynamic, and
  intercepting boundary modes. WebSocket routes also support opt-in synchronous outbound validation
  through `sendSchema` + `validateSend`; invalid or asynchronous outbound frames fail closed while the
  default remains type-level only.

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

## 2.3.0

## 2.2.0

## 2.1.0

## 2.0.0

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.0

## 1.0.0-beta.4

## 1.0.0-beta.3

## 0.1.0-beta.2

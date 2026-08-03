# @nifrajs/cli

## 2.8.1

### Patch Changes

- 93fdc89: `nifra doctor` now scans `*.test.ts`/`*.spec.ts` files for undeclared imports. Tests are part of the typechecked surface, so a package imported only by a test and declared nowhere still breaks a clean `bun install` build - doctor previously shared `nifra check`'s test exclusion and missed it. `nifra check`'s own scans still skip tests, which legitimately drive `fetch` and call routes directly.
- Updated dependencies [78d66a4]
- Updated dependencies [93fdc89]
  - @nifrajs/core@2.8.1
  - @nifrajs/client@2.8.1
  - @nifrajs/schema@2.8.1
  - @nifrajs/testing@2.8.1
  - @nifrajs/web@2.8.1
  - @nifrajs/mcp@2.8.1
  - @nifrajs/runner@2.8.1
  - create-nifra@2.8.1

## 2.8.0

### Minor Changes

- 118e4a5: `nifra dev --bun` now supports server functions and `*.server` modules. Bun's dev-server bundler accepts plugins only through bunfig's `[serve.static]` channel, so the CLI generates a config under `.nifra/dev-bun/` carrying the same production boundary plugins (server-fn RPC stubs, server-only emptying), merges the app's own bunfig `[serve.static] plugins` and `preload` entries, and re-launches itself once with `--config=` pointing at it - identical stubs across dev and build, and the old fail-closed refusal for those modules is gone. The relaunch is verified with a per-launch random token (matched against a file the parent just wrote, consumed on first read, constant-time compare), so no fixed environment value can make the server skip the boundary configuration; an unverifiable launch regenerates and re-launches instead of serving. The app's entire bunfig is carried into the generated config verbatim - jsx, defines, loaders, install settings - with path-bearing entries re-rooted; a bunfig field the generator cannot round-trip, or malformed TOML, fails loudly instead of being dropped. CSS Modules remain gated under `--bun`.

  Also fixed in `@nifrajs/web`: `serverFn<Input, Output>(...)` with explicit type arguments is now recognized by the client-boundary scanner - it previously produced an exportless stub that failed the client build with a missing-export link error (a type argument containing parentheses still fails loudly with guidance, never silently). The dev loop's background leak guard now reports the underlying bundler errors instead of a bare "Bundle failed".

- 9a6b0c3: The docs MCP's example-browsing widget tool is now `nifra_gallery` (was `nifra_examples_app`), keeping every tool on the single-word `nifra_<noun>` pattern. Its description and `nifra_example`'s now state the split explicitly: `nifra_example` returns one verified snippet as text, `nifra_gallery` opens the browsable widget. The exported `examplesAppTool` API is unchanged.
- ca60337: `nifra check`'s interpolated-SQL rule now resolves same-file constants. A module-scope `const` interpolated into a query - the shared column-projection idiom (`const COLS = "id, name"` ... `` `SELECT ${COLS} FROM ...` ``), a `const LIMIT = 50`, a const built from other consts, or a ternary whose branches are both literal - is compile-time text and no longer flags, with zero suppression config. Resolution is pure syntax with a depth cap: imported names, `let`, parameters, call results, member accesses, and shadowed names (including a hoisted `var` anywhere in the enclosing function) stay flagged exactly as before, and a resolved const still feeds the SQL-keyword scan, so hostile statement text in a const alongside a dynamic span is still caught. The named escape hatches (`unsafe`, `$queryRawUnsafe`) keep flagging statement-from-variable regardless.

### Patch Changes

- Updated dependencies [118e4a5]
  - @nifrajs/web@2.8.0
  - @nifrajs/client@2.8.0
  - @nifrajs/core@2.8.0
  - @nifrajs/mcp@2.8.0
  - @nifrajs/runner@2.8.0
  - @nifrajs/schema@2.8.0
  - @nifrajs/testing@2.8.0
  - create-nifra@2.8.0

## 2.7.1

### Patch Changes

- Updated dependencies [52c89e0]
  - @nifrajs/core@2.7.1
  - @nifrajs/client@2.7.1
  - @nifrajs/schema@2.7.1
  - @nifrajs/testing@2.7.1
  - @nifrajs/web@2.7.1
  - @nifrajs/mcp@2.7.1
  - @nifrajs/runner@2.7.1
  - create-nifra@2.7.1

## 2.7.0

### Patch Changes

- Updated dependencies [7fd0fc7]
  - create-nifra@2.7.0
  - @nifrajs/client@2.7.0
  - @nifrajs/core@2.7.0
  - @nifrajs/mcp@2.7.0
  - @nifrajs/runner@2.7.0
  - @nifrajs/schema@2.7.0
  - @nifrajs/testing@2.7.0
  - @nifrajs/web@2.7.0

## 2.6.1

### Patch Changes

- Updated dependencies [5840c98]
- Updated dependencies [80419f5]
  - @nifrajs/core@2.6.1
  - @nifrajs/web@2.6.1
  - @nifrajs/client@2.6.1
  - @nifrajs/schema@2.6.1
  - @nifrajs/testing@2.6.1
  - @nifrajs/mcp@2.6.1
  - @nifrajs/runner@2.6.1
  - create-nifra@2.6.1

## 2.6.0

### Patch Changes

- e6349e5: Security hardening across input parsing and code generation. Every regex that runs on caller-influenced input (URL paths, route patterns, stylesheet and SVG sources, manifest text) is now linear - no polynomial backtracking on adversarial input. SVG preamble stripping and tag removal can no longer splice removed delimiters into new markers. Static file serving rejects `..` traversal in the request form outright and confines the resolved path with a `relative()` containment check. Generated code embeds strings through an escaper that neutralizes `</script>` breakout and the U+2028/U+2029 line separators, and HTML entity decoding resolves `&amp;` last so double-encoded entities cannot double-unescape.
- 10fb70c: `defineMcpTool` accepts `annotations` (the MCP tool safety hints - `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`), surfaced in `tools/list` and `tools/describe`. Hosts use these to pick confirmation UX, and connector directory reviews expect every tool to declare them. The hosted docs tools (`nifra_docs`, `nifra_example`, `nifra_types`, `nifra_learn`, `nifra_examples_app`) now all declare themselves read-only and closed-world.
- Updated dependencies [e6349e5]
- Updated dependencies [08fe221]
- Updated dependencies [8383063]
- Updated dependencies [10fb70c]
  - @nifrajs/web@2.6.0
  - @nifrajs/core@2.6.0
  - @nifrajs/mcp@2.6.0
  - @nifrajs/client@2.6.0
  - @nifrajs/schema@2.6.0
  - @nifrajs/testing@2.6.0
  - @nifrajs/runner@2.6.0
  - create-nifra@2.6.0

## 2.5.0

### Minor Changes

- 8251dfd: `nifra doctor` and `nifra check` now flag stale workspace dists. A workspace-linked dependency whose export map splits `bun` (source) from `default` (a `dist` artifact) serves live source to Bun but a build artifact to Vite's SSR runner and node consumers - and nothing in the dev loop rebuilds that artifact. Because `dist/` is gitignored, the drift never shows in a diff; it surfaces as a 500 inside the package's code and reads like an upstream regression. The new `stale-workspace-dist` rule compares each linked dependency's `default` target mtime against its newest source file and reports "rebuild <pkg>" with the lag (or "never built" when the artifact is missing). Advisory severity: it warns in the report and the `--json`/MCP diagnostics but never fails the gate, since a linked package's dist is legitimately behind while you are mid-edit. npm tarball installs are immutable and never flagged.

### Patch Changes

- Updated dependencies [3731c69]
- Updated dependencies [31ccc27]
- Updated dependencies [02d9aa8]
- Updated dependencies [0740f77]
  - @nifrajs/mcp@2.5.0
  - @nifrajs/testing@2.5.0
  - @nifrajs/web@2.5.0
  - @nifrajs/client@2.5.0
  - @nifrajs/core@2.5.0
  - @nifrajs/runner@2.5.0
  - @nifrajs/schema@2.5.0
  - create-nifra@2.5.0

## 2.4.0

### Minor Changes

- 1c2bf5a: The self-hosted docs MCP (`nifra docs-mcp` / `handleMcpHttp`) now serves `nifra_examples_app`, an MCP Apps widget that renders the verified code examples as an interactive, filterable list in hosts that support it; text-only hosts still get the example names. It reads the same bundled examples corpus as `nifra_example`, so every self-host exposes it from one definition.
- 335eb2a: A guided, ordered path to build a nifra app end to end.

  `nifra_learn` (MCP) and `nifra learn` (CLI) walk the same sequence - create the app, add a page route, load data, add a typed API, call it through the typed client, protect a route, do background work, deploy. Each step names the tool that emits the correct artifact (`nifra_scaffold`, `nifra_example`, `nifra_run`) and how to verify it, so the path composes the existing tools instead of pasting code that can drift from the installed version. Random-access search stays `nifra_docs`/`nifra_example`; this is the sequence for building something new.

- 795357f: DevTools' request-trace buffer is now queryable, not just streamable.

  Alongside the live SSE overlay, the plugin serves a one-shot JSON snapshot at `/_nifra/devtools/state` - the recent request traces (method, path, status, duration, ISR status, response bytes), filterable by a `path` prefix and a `limit`, and guarded exactly like the stream (loopback-only unless `allowRemote`, origin-checked, optional `authorize` hook). A new `filterDevToolsEvents` export defines that query once, shared by the endpoint and its consumers.

  `nifra_inspect` (MCP) reads that snapshot for a running dev server, so an agent can SEE what its requests actually did - which route answered, the status, how long, ISR hit or miss - instead of inferring it from the response alone. It needs the app to mount the `devtools()` plugin (which auto-enables in development).

- 23e6eb1: Errors resolve to a structured diagnostic - one object a person reads in the overlay and an agent reads as JSON.

  The dev error overlay now shows a source codeframe around the offending line and, for failures nifra recognises (a server-only module or a `node:` built-in reaching the client, a schema mismatch), a plain-language cause and fix with a docs anchor. A new `@nifrajs/web/diagnostic` export builds that `Diagnostic` - stable `code`, the top frame in your own source, the codeframe, and the cause/fix - from any thrown value, and the dev server serves the most recent one as JSON at `/__nifra/last-error`.

  `nifra_explain` (MCP) turns an error - pasted from `nifra_run`/`nifra_test` output, or the dev server's last - into that same diagnostic, so an agent gets the code, the codeframe in your source, and the fix instead of eyeballing a stack trace.

- 06f4aaa: `nifra upgrade` refuses to roll a dependency backward, and duplicate-install diagnostics name the type-inference symptom.

  `nifra upgrade <version>` now fails closed when a target would set any pin below the installed version (for example running an older recipe on a newer install), listing each pin that would roll back and writing nothing; pass `--allow-downgrade` to apply it intentionally. `nifra doctor` and `nifra check` additionally call out that a second `@nifrajs/core` copy is the usual cause of `typeof backend` collapsing to `any` at `.merge()`.

### Patch Changes

- 1c2bf5a: Harden the dev-only diagnostics endpoint and the agent-facing reads of it. The dev server now binds to `127.0.0.1`, answers `/__nifra/last-error` with an identity header, and resolves source paths so the codeframe stays inside the project. The Vite dev server serves that endpoint at parity with the Bun one. `nifra_explain` and `nifra_inspect` validate the target port, time out, cap the response size, and only return a body from a verified nifra endpoint - so pointing them at an unrelated local service returns a clear error instead of that service's response.
- 1c2bf5a: `nifra upgrade`'s downgrade guard now respects prerelease precedence, so a target of `2.3.0-beta` is correctly treated as older than an installed `2.3.0` and blocked without `--allow-downgrade`. Previously only the numeric core was compared, so a release-to-prerelease step slipped past the guard.
- Updated dependencies [06f4aaa]
- Updated dependencies [1c2bf5a]
- Updated dependencies [138bfba]
- Updated dependencies [23e6eb1]
- Updated dependencies [06f4aaa]
  - create-nifra@2.4.0
  - @nifrajs/web@2.4.0
  - @nifrajs/core@2.4.0
  - @nifrajs/testing@2.4.0
  - @nifrajs/client@2.4.0
  - @nifrajs/schema@2.4.0
  - @nifrajs/mcp@2.4.0
  - @nifrajs/runner@2.4.0

## 2.3.0

### Minor Changes

- 77715ca: `nifra check` fails on SQL built by interpolating a value into the statement text.

  ```ts
  db.query(`SELECT * FROM notes WHERE id = ${id}`); // fails the check
  db.query("SELECT * FROM notes WHERE id = ?").get(id); // bound
  db.execute(sql`SELECT * FROM notes WHERE id = ${id}`); // bound by the tag
  ```

  The interpolated value becomes statement rather than parameter, so anything the caller controls can end
  the literal and continue as SQL.

  Two things it deliberately stays quiet about, because flagging a safe idiom is how a rule gets ignored:
  a TAGGED template (`` sql`… ${id} …` `` in postgres.js, drizzle and kysely binds its substitutions -
  that IS the parameterised form), and any literal without a substitution. A SQL keyword is required in
  the literal too, so `cache.query(`user:${id}`)` is left alone; the named escape hatches
  (`$queryRawUnsafe`, `sql.unsafe`) are flagged on the call alone, since taking a statement as text is
  their entire purpose.

- ea0a27f: Capability provenance says when it could not finish, instead of reporting a clean project.

  The reachability walk stops at a module count and an import depth so a pathological graph cannot hang
  the check. Hitting either limit used to end the walk quietly, and the route came back covered - a
  passing report whose subject was partly unexamined, which is the shape of failure this whole gate
  exists to prevent.

  Both limits now produce a `provenance-truncated` finding naming the route and the chain that reached
  it, the check fails, and the lockfile refuses to record a snapshot taken from a truncated walk.

- a4ecca9: The `.server` convention now holds in every client pipeline, not just one.

  A `*.server.ts` module is server-only: the client build empties it so its import subtree - `node:`
  builtins, native modules, secrets - never reaches a browser. That was implemented once, as a
  `Bun.build` plugin, so it held in exactly one of the four client paths. `nifra build` emptied the
  module; `nifra dev` (Vite), a Vite production build, and `nifra dev --bun` all bundled it whole.

  A guard that holds in one pipeline is worse than no guard, because the file NAME reads as protection
  everywhere it appears.

  - `@nifrajs/web/plugins/vite-server-only` empties the module for Vite, registered in both the dev
    server and the production build. A parity test asserts it emits bytes identical to the Bun plugin.
  - `nifra dev --bun` refuses to start on an app containing one, naming the files - the same treatment
    `*.fn` already had, because Bun's dev bundler takes no plugins and cannot be fixed with one.

  The three `nifra dev --bun` refusals (CSS Modules, `*.fn`, `*.server`) now have tests. Two of them
  guard secrets, and none of them had one.

- a92104e: The interpolated-SQL rule catches string concatenation, the oldest injection shape.

  ```ts
  db.query("SELECT * FROM users WHERE id = " + req.params.id); // now fails the check
  ```

  The rule inspected template literals only: a quoted string was skipped before the SQL-keyword test ever
  ran. So a codebase predating template literals - or an LLM emitting older-style JS - got a clean
  `nifra check` on textbook-injectable SQL, and `nifra check` reporting clean is a security claim that
  feeds the assurance ladder.

  The same keyword requirement applies, so `cache.query("user:" + id)` stays quiet, and a statement built
  into a variable elsewhere still says nothing at the call site.

  Also fixes the service-worker test suite, whose offline case never reached the code it claimed to test:
  the stub was assigned to `globalThis.fetch` after the worker had already captured `fetch` as a
  parameter, so the assertion was satisfied by a real network failure. A worker mutated to serve the
  offline page to every visitor passed all 19 tests; it now fails, and an online navigation is covered.

- ea0a27f: The interpolated-SQL rule reads the syntax tree, and TypeScript is an optional peer rather than a
  dependency.

  The rule used to work on text, which meant guessing where strings and comments began and ending up
  lenient in the direction that matters: EVERY tagged template was treated as parameter binding, so
  `String.raw` or any no-op custom tag hid an interpolated statement from the check. It now parses with
  the compiler and trusts only `sql` and `Prisma.sql`. It also reads a concatenated statement built
  across `+`, and skips a file the parser could not read rather than turning recovery nodes into a second
  misleading diagnostic.

  Trust is by NAME, and that is the honest limit of a scanner that reads syntax and runs no type checker:
  `sql` is what postgres.js, drizzle, slonik and Bun's driver all call theirs, and nothing here can prove
  a given `sql` binds anything. A no-op function with that name is trusted too. The rule finds mistakes,
  not an adversary who has read it - deciding otherwise needs a type checker, which is a different tool.
  Names earn their place on that list by being what drivers already call the thing.

  The compiler is a ~25 MB install, and the CLI's own typecheck step already treats `tsc` as something
  the project provides. Forcing it on every install to run one rule was the wrong trade, so it is an
  optional peer resolved when the rule runs. Every Nifra project has TypeScript - the templates all ship
  a `typecheck` script - so this resolves in practice.

  When it does not, `nifra check` says the rule did not run and how to enable it. That part is not
  cosmetic: an empty result is indistinguishable from a clean one, and for this rule a clean result means
  "no SQL injection was found". Silence there is the one answer it must never give.

- c823915: Typed, validated search params: a route declares a `searchSchema` and both its loader and its component read the parsed, validated query.

  Export a Standard Schema as `searchSchema` from a route. The loader's `ctx.search` becomes the parsed URL query validated against it (typed via `LoaderArgs<typeof app, Env, typeof searchSchema>`), and the component reads the same value with `useSearch<typeof searchSchema>()`. Invalid or hostile input fails closed to the schema's defaults (never a 500); without a `searchSchema`, both are the raw parsed query. Validation runs at match time and the value is derived identically on the server and on client navigation, so a component never parses `window.location.search` by hand and the query it renders hydrates with no mismatch.

  ```tsx
  export const searchSchema = v.object({
    page: v.optional(v.fallback(v.number(), 1), 1),
  });

  export async function loader({
    search,
    api,
  }: LoaderArgs<typeof backend, unknown, typeof searchSchema>) {
    return { rows: await api.reports.list(search).get() }; // search.page is a number
  }

  export default function Reports({ data }) {
    const { page } = useSearch<typeof searchSchema>(); // page: number, SSR-correct
    return <Pager page={page} />;
  }
  ```

  A `_layout` can declare its own `searchSchema` for keys shared across a section (`?org`, `?theme`); the route's effective search merges the layout chain's schemas with the page's, page-wins on a conflict, so both the layout and the page read their validated slice from one object.

  A route can also list `searchClientKeys` - search keys that are purely client-side UI (`?tab`, a client-side `?sort`, `?modal`). When a client navigation changes only those keys, the URL updates (so `useSearch` re-renders) without re-running the loader; any other key change revalidates as before, so data is never stale.

  `useSearch` ships on every adapter - React (a value), Preact (a value), Vue (a `Ref`), Solid (an `Accessor`), and Svelte (an accessor), each in that framework's own shape.

  `navigate` gains an object form on every adapter: `navigate({ to, search, replace })` serializes `search` onto `to` (no hand-built query strings). Run `nifra sync-routes` to generate `nifra-routes.d.ts` (each static route mapped to its schema output) and include it in your tsconfig, and `search` is typed against the target route's `searchSchema` - a wrong shape for a known route is a compile error, while an unmapped path takes a loose `search`. Regenerated from the route files, so a stale shape becomes a `tsc` error. The string-path and history-delta forms are unchanged.

  ```ts
  navigate({ to: "/reports", search: { page: 2 } }); // search typed against /reports's schema
  ```

### Patch Changes

- e88f36b: Two CI gates that could report success having measured nothing.

  `@nifrajs/events` shipped with 17 passing tests CI had never executed. The two run scripts list their
  30-odd test directories by hand and nobody added the new one, so the package published untested and the
  coverage ratchet was blind to it. The dead suite was the fail-closed half of a durable event boundary.
  A completeness check now asserts every package with test files appears in both scripts, with an
  explicit, reasoned opt-out list.

  `check:size` dropped any row that failed to build - logging to stderr, returning null - and then
  compared budgets only against rows that survived. Rename a `@nifrajs/core/*` subpath and its row
  vanishes with its budget, every remaining row passes, and the gate exits 0. It now reconciles measured
  rows against declared rows, and the budget table against the feature matrix, before comparing anything.

- b9f4525: `nifra build` and `nifra dev` now print the real cause of a failed bundle. When `Bun.build` throws, it raises an `AggregateError` whose own message is a generic "Bundle failed" and whose underlying errors - the unresolved import, the plugin that threw, each with a file and line - were dropped by the CLI's error output. Those causes are now unwrapped and printed, one per line, at every CLI error boundary.
- 1fbfb62: A `clientModule` given as a relative path (a local client entry, e.g. `./src/client.tsx`) now works in both `nifra dev` and `nifra build`. It is resolved to an absolute path when the framework config loads, so the generated client entry - which dev and build write into different directories - resolves it identically in both phases instead of loading in one and breaking in the other. A bare or package specifier (`@nifrajs/web-react/client`) is location-independent and unchanged.
- c42d777: Documents seven packages that shipped without a single reference.

  `web-vanilla` (zero-framework adapter) joins the frameworks page and gains `examples/web-vanilla`;
  `devtools` joins dev; `mock` joins testing; `events` joins backends; `prompt`, `agent-telemetry` and
  `mcp-db` join the coding-agents page.

  All were real - 185 to 381 lines each, 9 to 23 tests each - and none were findable. Every added sample
  is compiled by the docs gate against the live API.

- fc034c6: Documents server functions and effect provenance.

  Two features shipped without a page. Server functions span seven packages and had none at all, and the
  effect provenance firewall - now armed in every template - emits a finding (`unconfined-write-reach`)
  whose fix is structural and was explained nowhere outside code comments.

  Both pages join the docs corpus the MCP server and `nifra_docs` search read from, so an agent finds them
  too.

- 45b0733: `nifra dev --bun` no longer waves `.fn.mts` / `.fn.cts` / `.fn.mjs` / `.fn.cjs` into the browser.

  The refusal that keeps a server function off the Bun dev pipeline matched a hand-written glob,
  `**/*.fn.{ts,tsx,js,jsx}`, while both build pipelines stub anything matching
  `/\.fn(\.[cm]?[jt]sx?)?$/`. So a `todos.fn.mts` was a server function everywhere except the one check
  that exists to stop it leaking - it started the dev server and shipped the function bodies, and
  whatever they close over, to the browser. Measured across all eight extensions, four leaked.

  Both refusals now test against the same matchers the transforms use, exported as `SERVER_FN_MODULE`
  and `SERVER_ONLY_MODULE` from `@nifrajs/web`. `SERVER_ONLY_MODULE` had two definitions and now has one
  owner. A test drives every accepted extension through the guard, so widening a convention without
  widening the guard fails there rather than in someone's browser.

- ea0a27f: A scaffolded project's `check` script runs the assurance gate it ships with, and the dev refusals cover
  extensionless modules.

  Every template ships an assurance config, and every template's `check` script ran `nifra check` only -
  so the policy was shipped, documented, and never executed by the command a project actually runs in CI.
  It now runs `nifra check && nifra assure`.

  `nifra dev --bun` refuses `.server` and `.fn` modules because Bun's dev bundler takes no plugins and
  would ship them whole. The refusal missed a module with no extension at all, which is the one shape a
  directory import produces.

- 1ed58b8: The documentation site now holds the bar it sells: `nifra.assurance.ts` plus a capability lockfile, at
  L2.

  It is also the first validation of the capability model on an app nobody designed around it. Two things
  that only a real app can answer:

  - **No false positives.** 47 route files carry dozens of documentation samples containing
    `import { Database } from "bun:sqlite"` and friends inside template literals. None became capability
    evidence, because the scanner blanks template contents before reading imports.
  - **Real imports are still caught.** Adding one genuine `bun:sqlite` import to the backend immediately
    flagged all four routes, including the GET dead end with its structural message.

- 803ec9d: `nifra_types` answers for every published package.

  `@nifrajs/deno`, `@nifrajs/content` and `@nifrajs/workers` contributed nothing to the type index the
  MCP tool reads. They ship `files: ["src"]` and point `types` at `./src/index.ts`, which is right for a
  package resolved by Deno, workerd or Bun, while the index only ever looked for a built `dist/*.d.ts`.
  Asked about `serve`, `defineCollection` or `createWebSocketHub`, an agent got nothing back and wrote
  the API it guessed instead.

  Their declarations are now emitted from source, per file and without a type checker, so the index
  starts where a consumer's resolver starts either way. Signatures are declarations, not implementations
  pasted in; the 1,545 entries already there are byte-identical.

  The `--check` gate could not have caught this - it compares the regenerated file against the committed
  one, and a package missing from both matches forever. So `gen:llms` now fails when a published package
  contributes no types at all, which also turns the quietest failure here into a loud one: run it without
  building first and the file used to be rewritten with almost nothing in it.

- 5177627: `nifra check`, `nifra assure` and `nifra levels` are three views of one project verification.

  All three read the same reflected project: the typed-contract scan, the route-assurance evaluation,
  and the static capability provenance. Each had grown its own orchestration over those pieces, so which
  command ran which policy was something a caller had to keep in their head, and `nifra levels` paid for
  it twice. Its L0 rung runs the whole check, and then L1 and L2 re-derived the route-assurance and
  capability-provenance evidence that same check had just produced. On a project with a capabilities
  policy the provenance walk is the expensive part, and it ran on every `levels` invocation once for the
  check and again for the ladder.

  They now derive from a single verification pass. Each command renders its own slice of it: `assure`
  still never triggers the typecheck it has no use for, and `levels` climbs the ladder from evidence
  gathered once rather than a second time per rung. The output of all three is unchanged down to the
  byte, and a golden test per command and per mode holds that line so it stays that way.

- 4eb4e15: The release's version script regenerates the llms corpora, so the "Version Packages" PR can pass CI.

  `types.json` stores exported signatures verbatim, including core's `VERSION` as the literal type
  `export declare const VERSION: "2.2.0"`. Bumping the version rewrote that constant and regenerated
  `api-reference.md` and the LLM cards, but not the corpora - so every Version PR failed `check:llms` on a
  stale `types.json`, and since Release only publishes after CI concludes successfully, nothing could
  ship.

- Updated dependencies [6f5b3ad]
- Updated dependencies [cee03d7]
- Updated dependencies [85b354d]
- Updated dependencies [9b110b9]
- Updated dependencies [7293a1c]
- Updated dependencies [c8b79d7]
- Updated dependencies [8514caa]
- Updated dependencies [ea0a27f]
- Updated dependencies [ea0a27f]
- Updated dependencies [45b0733]
- Updated dependencies [c42d777]
- Updated dependencies [ea0a27f]
- Updated dependencies [82b2053]
- Updated dependencies [b271164]
- Updated dependencies [8c77d47]
- Updated dependencies [ea0a27f]
- Updated dependencies [26cec7d]
- Updated dependencies [8807004]
- Updated dependencies [ea0a27f]
- Updated dependencies [35af9fe]
- Updated dependencies [ea0a27f]
- Updated dependencies [d190b1c]
- Updated dependencies [a4ecca9]
- Updated dependencies [de8d992]
- Updated dependencies [a92104e]
- Updated dependencies [7f55876]
- Updated dependencies [5fe332a]
- Updated dependencies [c823915]
- Updated dependencies [d2840ac]
- Updated dependencies [62a8d03]
- Updated dependencies [dcacfe7]
- Updated dependencies [28704d7]
- Updated dependencies [ea0a27f]
- Updated dependencies [0c2de22]
  - @nifrajs/core@2.3.0
  - create-nifra@2.3.0
  - @nifrajs/client@2.3.0
  - @nifrajs/web@2.3.0
  - @nifrajs/schema@2.3.0
  - @nifrajs/testing@2.3.0
  - @nifrajs/mcp@2.3.0
  - @nifrajs/runner@2.3.0

## 2.2.0

### Minor Changes

- 2441577: `nifra build` picks its bundler from your config instead of a fixed default, and `--bun` joins `--vite`.

  The two phases default differently on purpose: `nifra dev` is Vite (for the plugin ecosystem, and because
  Bun's dev-server bundler cannot compile CSS Modules), `nifra build` is Bun (faster, Bun-native). For an app
  with no transforms that costs nothing - there is nothing for the two to disagree about. For an app whose
  only transforms are `vitePlugins` it cost a class of production-only bug: those plugins ran in dev, and the
  Bun build reads `clientPlugins`/`serverPlugins` and never `vitePlugins`, so it dropped them. The build
  succeeded, the output looked plausible, and the transform had simply not happened.

  That is the failure the pipeline-separation guard already refuses to allow - a plugin whose pipeline never
  runs - reached by crossing phases instead of slots, where the slot check cannot see it because the plugins
  are correctly placed.

  So the default now follows the app. Vite plugins with no Bun counterpart means exactly one pipeline can
  build it, and that is the one used; `nifra build` prints the reason so an auto-selected Vite build never
  looks like you got the default. An app declaring both slots has supplied the Bun equivalent deliberately -
  nothing is dropped - so the faster Bun default stands, unchanged. An app with no plugins is unaffected.

  `--vite` and the new `--bun` force the choice, with one exception: `--bun` on an app whose only transforms
  are `vitePlugins` is refused, naming the plugins it would discard, rather than producing the silently
  incomplete build the flag would otherwise ask for. Passing both flags is an error.

- a7d740a: Mount sub-apps and standalone-shaped backends without a `Proxy`; bound the render worker; lint removed imports.

  **`mounts` and `apiStrip` on `createWebApp`.** Two shapes previously needed a hand-written ~40-line
  `Proxy` around the backend. The auto-mount dispatches the full `/api/v1/forms`, but a backend that also
  runs standalone declares its routes without the prefix and lets its own shell supply it - so every
  request 404'd inside it. And better-auth is not a `backend` route, so `/api/auth/*` hit the backend and
  404'd silently. `apiStrip: true` removes the prefix before dispatch, and `mounts` takes any
  `{ path, app: { fetch } }` - so any library exposing its routes in that shape mounts directly, with no
  dependency from `@nifrajs/web` on it. Mounts are matched longest-path-first and before the `api`
  prefix, so `/api/auth` wins over `/api` regardless of declaration order.

  **A layout that exports a `loader` now fails loudly.** Layouts do not run one - only route files do -
  and rendering while ignoring the export was the worst possible handling: it looks wired, the page
  renders, and the data is simply never there. The error names the file and says where the fetch should
  go instead. Running loaders in layouts is a real feature and is not this change.

  **`nifra_render` and `nifra_run` can no longer hang.** The cold-path child wrote its result and then
  fell off the end of the module without exiting, unlike the warm-worker branch beside it. Loading an
  app runs its module side effects, so a database pool, a Redis client, or an interval kept the child's
  event loop alive forever while the parent waited on `proc.exited`. The child now exits explicitly, and
  both the cold and warm paths carry a 30s timeout as a backstop, reporting the likely cause rather than
  hanging.

  **A `removed-import` lint in `nifra check`.** `@nifrajs/budget` folded into core in 2.x with no npm
  deprecation - `latest` is still 1.13.0, so a `^2` range resolves to nothing and `bun install` fails
  workspace-wide with an error naming neither cause nor replacement. The 2.0 WebSocket change has the
  same shape: `import "@nifrajs/core/ws"` no longer installs the runtime, and a consuming package kept
  it while its whole test suite stayed green and the app could not boot. Both are now caught before
  boot, with the replacement named. The WS rule flags only the bare side-effect form, since the module
  still exports `websocket` and a rule that fires on correct code gets ignored.

- 78e0b02: `nifra dev --bun` - the Bun pipeline is now selectable in dev, completing the pipeline matrix.

  `nifra build --vite` already let an app choose its production bundler, but dev was Vite-only from the
  CLI: the Bun dev server existed solely as a library entry (`@nifrajs/web/dev`), so using it meant
  hand-writing a `dev.ts`. `nifra dev --bun` runs it directly - `Bun.serve`'s native HMR bundles and
  hot-reloads the client while Bun's runtime resolves SSR, with no Vite in the process. Both pipelines are
  now selectable in both phases, and neither ever runs inside the other.

  It refuses one case rather than breaking quietly. Bun's DEV-server bundler and `Bun.build` are not the
  same bundler: `Bun.build` compiles `*.module.css` into a scoped class map (so the Bun production build of
  a CSS-Modules app is fine), but the dev server's bundler has no such transform - the import becomes a
  dangling reference and the browser throws `ReferenceError: import_X_module is not defined` from inside the
  component, naming neither CSS Modules nor the dev server. So `--bun` checks for CSS Modules up front and
  refuses with the offending files named and both ways forward. The check is deliberately narrow: only the
  transform proven missing is refused, so an app without CSS Modules gets the Bun dev loop.

  Bun applies React Fast Refresh natively on this path - verified: editing a component-only module swaps its
  markup while a `useState` counter keeps its value, with no reload. The boundary rule is the same one Vite
  has (a route file that also exports `loader`/`meta` is not a refresh boundary, so saving it reloads). Plain
  CSS and Tailwind work; only `*.module.css` is refused.

  Default is unchanged - `nifra dev` stays Vite, for its plugin ecosystem.

- 15ad6ca: Enforce pipeline separation, and make the client-leak guards bundler-neutral.

  nifra supports both Vite and Bun, and the config already keeps them in separate slots - `vitePlugins`
  for the Vite pipeline, `clientPlugins` / `serverPlugins` for the Bun one. Nothing enforced the split,
  and the failure mode is silent: `Bun.build` has no `transform` hook and Vite never calls `setup`, so a
  plugin in the wrong slot is accepted, never invoked, and the build succeeds with the transform simply
  missing.

  Loading an app now refuses that config, naming the plugin, the slot it is in, the pipeline that slot
  feeds, and where to move it. Checked at load rather than in `nifra check`, which holds a deliberate
  pre-`loadApp` invariant - reading plugins means importing the app's config. So `dev`, `build` and
  `start` are covered from one place, immediately before the plugins reach a bundler. Detection is by
  hook shape and deliberately conservative: a plugin matching neither shape is left alone, because a
  guard that fires on correct config is a guard people turn off.

  The two client-leak guards - server-only code reaching the browser, `node:` builtins in client code -
  now take a bundler-neutral module graph instead of Bun's metafile, with a `fromBunMetafile` adapter
  behind it. Nothing changes today: Bun remains the only producer and the existing 19 tests pass
  unchanged, now routed through the adapter so it is covered too.

  The point is what it makes possible. These are security guards - one stops secrets and database access
  shipping to a browser - so a second production pipeline must not arrive without them, and porting them
  under pressure beside a new bundler is how a guard ends up "mostly" ported. Introducing the seam while
  Bun is the only producer means the adapter can be verified against known-good behaviour, and adding
  Rollup later is one more adapter rather than a second copy of the detection logic.

- 6ba3173: `nifra routes --modes` - every route's render mode, hydration, and cache policy, gated against the target.

  The facts were always in the route modules: `prerender`, `getStaticPaths`, `revalidate`, `hydrate`.
  Nowhere read them together. Answering "which pages are static?", "which revalidate, how often?", "which
  ship no JS?" meant opening every route file and holding the answer in your head - and the answer changes
  with the deploy target, which is nowhere near the route file.

  The new `@nifrajs/web/route-manifest` derives one record per route - static | isr | ssr, hydration, cache
  policy - and resolves it against a target. `nifra routes --modes` prints the table; `--modes --target <t>`
  gates: a route the target cannot honour exits non-zero, so CI fails the build instead of production
  failing the request. The two cases that were previously silent are exactly the ones it catches: an ssr or
  isr route in a `static` build (no server, so the URL 404s in production while working in dev), and ISR
  where the target has no revalidation. Each conflict names the consequence, not the rule.

  Two derivations are deliberate. `prerender` wins over `revalidate`, because a page rendered at build time
  is not revalidated at runtime - the build-time answer is the one that ships. And a dynamic route counts as
  static only once the build has actually emitted paths for it: `getStaticPaths` is the intent, the emitted
  paths are the evidence, and treating intent as sufficient is how a "static" build ships a page that 404s.
  Pass the paths `prerenderRoutes` produced via `buildRouteManifest`'s `prerendered` option to resolve those
  routes against what was really built.

- ca71a2e: `nifra_types` collapses oversized declarations in search results, and a bad `clientModule` says so.

  **`nifra_types` query mode.** A search returned the complete declaration of every match, and the corpus
  is wildly uneven: the median symbol is small while `Server` alone is ~32,000 characters, five times the
  next largest. One broad query that happened to match it returned the entire class for near-zero value.

  A `query` now returns a one-line summary plus the signature, collapsing an oversized body to its head
  and a member count, and saying which `name` call returns the rest. Measured on the real corpus:
  `"server"` drops from 36,355 to 1,739 characters (95%), `"route schema"` by 87%, `"rate limit"` by 69%.

  An exact `name` lookup is **never** collapsed - there the caller asked for that symbol. Pass
  `full: true` to opt a query back into whole declarations.

  **`clientModule`.** The option is a module specifier resolved by the bundler, so nothing type-checks
  that the module actually exports `mountRouter`. A self-executing client entry therefore built cleanly
  and failed at first paint with `mountRouter is not a function`, from inside a bundled chunk, naming
  neither the module nor the requirement - diagnosable only by reading `build.ts`.

  The generated bootstrap now throws immediately, naming the offending specifier, the missing export, its
  call signature, and the specific trap that a self-executing entry will not work. The contract is also
  spelled out on the option's own type rather than in a parenthetical.

- 0fc215b: The Vite dev pipeline now resolves SSR too, which removes the dual-React class of bug.

  `nifra dev` served the client through Vite while resolving route modules for SSR through Bun - two
  resolvers disagreeing about one specifier, inside one process. That is what made `resolve.dedupe`
  govern only half the app: an app added a hand-written React alias in `nifra.config.ts`, and it still
  crashed, because the alias reached Vite and SSR never asked Vite. The symptom named a React internal
  (`resolveDispatcher().useState` is null), so the actual cause - two copies at different paths - was
  hours of inference away.

  `discoverRoutes` accepts a `load` option, and the Vite dev server passes `ssrLoadModule`. Both halves
  now resolve through the same toolchain, so an alias, a `dedupe`, or a condition configured for the
  client governs the server as well.

  Two things follow from that and are removed rather than kept "just in case":

  - **Bun's SFC plugins are no longer registered in `nifra dev`.** Vite compiles `.vue` / `.svelte` /
    Solid for SSR through the app's `vitePlugins`. Registering Bun's alongside was the intermix itself -
    two toolchains compiling one file, only one of them governed by Vite's resolution. `nifra start` and
    the build path keep theirs, which is correct: those are the Bun pipeline.
  - **The `importQuery` cache-buster is gone from the Vite path.** It existed to defeat Bun's import
    cache; Vite re-evaluates changed modules itself. `discoverRoutes` ignores `importQuery` when `load`
    is supplied, because appending one would mint a new module id per request and defeat that.

  The dev server still re-creates the app on change, now only so a hard reload picks up a route add or
  remove - the manifest comes from a directory scan, which `ssrLoadModule` cannot invalidate.

- 2ff661f: The full Vite/Rollup production build: `buildClientVite`, `buildServerVite`, `buildTargetVite`, and `nifra build --vite`.

  Production stays Bun by default - faster and Bun-native, the profile nifra is tuned for. This completes
  the escape hatch for the one case that default cannot serve: an app whose client needs a Vite-only
  transform with no Bun equivalent. It now has a real, full production path, not just the leak-guard plugin.

  The design point is that this is NOT a second orchestrator. `buildTarget`'s deploy assembly - per-target
  server-entry codegen, `_worker.js` / `server.js` placement, `_routes.json`, prerender, size report - is
  bundler-agnostic and now lives behind `buildTargetWith(target, options, bundler)`, which takes a `Bundler`
  strategy (its two bundling steps). `buildTarget` passes the Bun strategy; `buildTargetVite` passes the
  Vite one. So the deploy-dir shape is produced in exactly one place and cannot drift between pipelines -
  `buildTargetVite` emits the identical directory for every target.

  `buildClientVite` reconstructs the same `BuildManifest` the Bun `buildClient` does - content-hashed entry,
  per-route chunk lists, aggregate + per-route CSS, copied `public/` - from Vite's own `.vite/manifest.json`.
  It wires `viteLeakGuard()`, and it keeps `node:` builtins external so the guard names the offending builtin:
  left alone, rolldown-vite silently rewrites a `node:` import to a browser stub, which builds and ships and
  is a no-op at runtime - a worse footgun than Bun's polyfill, now a build failure. `buildServerVite`
  produces the same self-contained `ServerBuild`, tagging the bundle `NIFRA_SSR_BUNDLED` so the web-react
  adapter uses the bundled, deduped react-dom rather than re-rooting to a disk copy.

  `nifra build --vite` selects the pipeline; the app's Vite plugins drive both halves. Verified end to end by
  building the React example for the `node` target, running the server, and confirming SSR plus live
  hydration in a real browser, alongside `cf-pages` (`_worker.js` + `_routes.json`) and `static` (prerender,
  no server) deploy shapes.

  No change to the default Bun build: `buildTarget` now delegates to `buildTargetWith` with the Bun strategy,
  and its behaviour and output are identical.

### Patch Changes

- 135d0c6: Find duplicate installs when `nifra check` runs from an app subdirectory.

  The duplicate-install check anchored its discovery at the directory it was run from. In a monorepo you
  run it from the app - `apps/web` - and that manifest declares no `workspaces`, so the scan collapsed to
  the app itself and the sibling package holding the second copy was never probed. It printed
  `✓ duplicate identity-sensitive dependency install: none` while the dev server returned 500 on every
  page using a shared-kit hook, from exactly the condition the check exists to detect. Running from an
  app subdirectory is the normal case, so that was the configuration it was blind in.

  Discovery now walks up to the workspace root that actually governs the directory, and probes from
  there. An ancestor is adopted only when its `workspaces` patterns genuinely match - a parent that
  merely contains a manifest is not this project's root - and the walk stops at a `.git` boundary.
  Findings are still reported relative to where you ran the command.

  **Expect this to start reporting real findings in monorepos that were previously green.** That is the
  point rather than a regression: the duplicate was always there, and the check simply never looked in
  the right place.

  An SSR error carrying a duplicate-instance signature (`resolveDispatcher()`, `Invalid hook call`, a
  null hook read) now names the likely cause. Two copies at the same version still fail, because module
  identity is path-based, and the raw error points at a React internal - so the message now says two
  copies are installed at different paths, that matching versions do not fix it, and to run
  `nifra check` for the paths.

- 1857d39: Serve `public/` in production, not just in dev.

  `nifra dev` served a project's `public/` directory; production did not. There was no `publicDir`
  concept anywhere - dev got the behaviour for free because the HMR path runs on Vite, and Vite serves
  `public/` by default. So a file worked all the way through development and 404'd the moment it was
  deployed, and every app had to notice this and hand-roll static serving in its own server entry.

  The failure is inverted, which is what makes it expensive: it appears only in production, and only for
  the assets nobody smoke-tests. It has already shipped once as a self-hosted webfont that 404'd in prod
  and silently fell back to a system font. Nothing errored and nothing alerted.

  `publicDir` (default `"public"`) is now a first-class option. The build copies the directory into the
  output and records the file list on the build manifest, and `servePublicDir` is exported for a server
  entry to mount. Dev routes through the **same** handler rather than inheriting Vite's - two code paths
  with different defaults was the whole bug, so there is now one owner.

  Behaviour, matching what apps arrived at independently: only paths with a file extension are probed,
  so a page route never pays a filesystem stat; a miss falls through to routing, so no route is shadowed;
  and cache headers differ by subtree - content-hashed `/assets/*` immutable, `public/` a day, both
  overridable. Path traversal is confined by resolving and then verifying containment, rather than
  scanning the input for `..` - a blocklist over encodings is the version that gets bypassed - and
  percent-encoded and NUL-bearing paths have tests.

  Note that `publicPath` is a different thing: the URL prefix for content-hashed bundle chunks. It never
  covered user-authored files, and the name similarity actively misleads.

  `nifra check` now points out that an app with a `public/` directory can delete its hand-rolled static
  serving. A tip rather than a finding - an existing handler still works, since it runs first.

  On Cloudflare Pages the copied files are named individually in `_routes.json` so the CDN serves them
  without invoking the worker, within Cloudflare's cap of 100 include+exclude rules of at most 100
  characters each. An ordinary `public/` of icons, fonts and share images clears that cap, and the
  rejection lands at `wrangler pages deploy` - after a build that reported success.

  Past the cap a directory is compacted to one `/dir/*` rule, but only after checking it against the
  app's real route patterns. The glob does not merely describe today's files; it hands Pages every future
  path under that prefix, so a `public/blog/hero.png` beside a `/blog/:slug` route would send
  `/blog/my-post` to a CDN that has no such file and 404 the page in production only. A directory
  therefore collapses only when no route can be served beneath it, and a single route with a dynamic
  first segment (`/:locale/…`) disables collapsing everywhere, since it can match under any name. A
  collapsed directory does give up the app's 404 page for a missing file beneath it - the right trade for
  a directory of static files, where a missing image should fail as a fast CDN 404 rather than an HTML
  error page.

  Whatever still does not fit is dropped rather than widened, which is safe because the list is only an
  optimization: the emitted worker serves any path it recognises through the `ASSETS` binding, so an
  omitted file costs one worker invocation rather than a 404, and nothing else reaches that binding. The
  build prints how many it left out, since a cap you cannot see reads as coverage you do not have.

- Updated dependencies [39b1670]
- Updated dependencies [d428f52]
- Updated dependencies [135d0c6]
- Updated dependencies [5f460db]
- Updated dependencies [1394641]
- Updated dependencies [e713cab]
- Updated dependencies [a4645e2]
- Updated dependencies [a7d740a]
- Updated dependencies [6e996a1]
- Updated dependencies [15ad6ca]
- Updated dependencies [6aa0aac]
- Updated dependencies [1857d39]
- Updated dependencies [6ba3173]
- Updated dependencies [ca71a2e]
- Updated dependencies [0fc215b]
- Updated dependencies [2ff661f]
- Updated dependencies [a1327a4]
- Updated dependencies [2500705]
  - @nifrajs/web@2.2.0
  - create-nifra@2.2.0
  - @nifrajs/core@2.2.0
  - @nifrajs/client@2.2.0
  - @nifrajs/schema@2.2.0
  - @nifrajs/testing@2.2.0
  - @nifrajs/mcp@2.2.0
  - @nifrajs/runner@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [bd294bb]
- Updated dependencies [d3aac63]
  - @nifrajs/core@2.1.0
  - @nifrajs/client@2.1.0
  - @nifrajs/web@2.1.0
  - @nifrajs/schema@2.1.0
  - @nifrajs/testing@2.1.0
  - @nifrajs/mcp@2.1.0
  - @nifrajs/runner@2.1.0
  - create-nifra@2.1.0

## 2.0.0

### Major Changes

- d91a45b: Remove Nifra's remaining deprecated and compatibility-only public surfaces for the 2.0 cutover.

  - `@nifrajs/core` and `nifra` now expose only the lean HTTP server API at their package roots. Import
    optional systems from their documented subpaths. The deprecated invariant runner and the
    `@nifrajs/budget` compatibility package are removed; use `@nifrajs/testing` and
    `@nifrajs/core/budget` respectively.
  - Web redirects accept only an options object as their second argument, the prerender enumeration
    wrapper is removed in favor of `enumerateStaticRoutes()`, and fragment navigation resolves IDs only.
  - MCP Apps metadata uses only `_meta.ui.resourceUri`; the deprecated flat `ui/resourceUri` key is gone.
  - Telemetry uses `ObservationAdapter` directly; the `AgentSpan`, `AgentSpanExporter`, and `SpanExporter`
    aliases are removed.
  - Invalid HTTP method overrides always fail closed with 400; the legacy ignore mode is removed.
  - `nifra build` always emits a complete target deploy directory and defaults to Bun. The old
    client-only build branch is removed; `nifra start` runs the generated Bun `server.js`.

### Minor Changes

- 6b0dbc3: Ship the executable 2.0 migration path and consolidated upgrade documentation.

  - `nifra upgrade 2.0.0` updates the fixed Nifra package group while preserving range style, moves
    the removed `@nifrajs/budget` dependency to `@nifrajs/core`, rewrites its source imports to
    `@nifrajs/core/budget`, and prints the structural cutover notes it cannot safely infer.
  - Pin rules now treat bare package names as exact matches, so upgrading `nifra` cannot rewrite an
    unrelated dependency such as `nifra-plugin`.
  - The 1.x → 2.0 guide covers opt-in runtime plugins, lean subpath imports, backend mounts, typed
    client failures, web/protocol changes, release gates, and `nifra.check.json` external mounts for
    Better Auth-style route owners.
  - External-mount matching rejects percent-encoded parent traversal as well as literal `..`, so the
    lint exception cannot hide a fetch that URL normalization moves outside its declared prefix.

- 2324d38: `nifra check` can now reach green on an app that intentionally mounts a non-typed sub-app, and raw-Response routes have an explicit opt-out.

  - **`nifra.check.json` external-mount allowlist.** A relative `fetch()` to a mounted handler that lives outside the typed contract (e.g. an auth plugin that owns `/auth/**`) was flagged as a hand-rolled own-API call - an error you could never clear. Declare those prefixes in `nifra.check.json` (`{ "externalMounts": ["/auth"] }`, segment-anchored: `/auth` blesses `/auth` and `/auth/**` but not `/authors`) and the typed-client scan skips them. The blessed prefixes are echoed on the result and printed in the report, so a suppressed mount stays auditable instead of silently hiding real drift. A malformed `nifra.check.json` is a non-fatal warning; the allowlist is simply ignored.
  - **`// nifra-expect raw-response` pragma.** A route that deliberately returns a raw `Response` (a file or redirect) raised the `response-route` advisory with no way to mark it intentional. A pragma comment on the return line, or the line above, now silences it for that route.
  - **Streaming guidance.** The `response-route` advisory now points streaming routes at the typed SSE route (`app.sse(...)`), which keeps typed events instead of collapsing the client to `data: never`.

- 5917e68: Add the `nifra_levels` MCP tool, so an agent can read the verification ladder it was already able to
  run from the CLI. It returns `{ achieved, levels[] }` across L0 typed contract, L1 route assurance,
  L2 capability lockfile, L3 route trust manifest, and L4 contract invariants, with the reasons a level
  does not hold. A project with no assurance config still answers, stopping at L0 rather than failing.
- e97a92f: `nifra sync-manifest`, plus two toolchain guards that turn opaque failures into actionable ones.

  - **`nifra sync-manifest`.** After adding/renaming/removing a page route, the committed `server-manifest.ts` drifts and `nifra check` flags it - and clearing that used to mean a full build (server + worker + migrate bundles). `nifra sync-manifest` re-scans `routes/` and rewrites just the manifest's route table in milliseconds, preserving the baked client-asset references. It does not rebuild the client bundle, so it prints a caveat: a brand-new hydrating route component still needs a full build for its client chunk. `@nifrajs/web/build` gains the pure `resyncServerManifestSource` (+ `parseManifestStyles` / `parseManifestRouteStyles`) it is built on.
  - **`nifra dev` peer preflight.** Run under `bunx @nifrajs/cli dev` (an isolated install where the project's peers do not resolve), the Vite import failed with an opaque `ERR_MODULE_NOT_FOUND`. It now checks `vite` resolves from the project first and, if not, says to run the workspace-local `bun run dev`.
  - **`nifra start` build-target guard.** Pointed at a Cloudflare Pages output (a `_worker.js` bundle, no `server.js`), `nifra start` now names the mismatch and the fix (`nifra build --target bun`, or serve with `wrangler pages`) instead of a bare "no server.js".

### Patch Changes

- 7791470: `nifra check` now prints a one-line tip when the project has no `.mcp.json`, pointing at `nifra init-agents` (which wires `.mcp.json` + `.cursor/mcp.json` + a CLAUDE.md preamble, no-clobber). The tip is non-fatal and only in the human report - the `--json` path is unchanged - so a coding agent discovers the MCP wiring instead of learning the framework from sibling-app source.
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [b7017b9]
- Updated dependencies [d91a45b]
- Updated dependencies [d91a45b]
- Updated dependencies [e97a92f]
- Updated dependencies [202e758]
- Updated dependencies [a7b1d60]
- Updated dependencies [e8e49d1]
- Updated dependencies [a7d34e5]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0
  - @nifrajs/client@2.0.0
  - @nifrajs/schema@2.0.0
  - @nifrajs/web@2.0.0
  - create-nifra@2.0.0
  - @nifrajs/testing@2.0.0
  - @nifrajs/mcp@2.0.0
  - @nifrajs/runner@2.0.0

## 1.13.0

### Patch Changes

- f644556: `nifra doctor` also probes the workspace root for identity-sensitive packages, so it reports the split
  where every declaring package resolves one physical copy and the root holds another. Consulting only
  the packages that declare the dependency saw a single copy and stayed quiet.
- Updated dependencies [aae8614]
- Updated dependencies [5b6127a]
  - @nifrajs/core@1.13.0
  - @nifrajs/client@1.13.0
  - @nifrajs/web@1.13.0
  - @nifrajs/schema@1.13.0
  - @nifrajs/testing@1.13.0
  - @nifrajs/mcp@1.13.0
  - @nifrajs/runner@1.13.0
  - create-nifra@1.13.0

## 1.12.0

### Minor Changes

- 63d3845: Add bounded execution-causality contracts and propagation, OpenTelemetry causal links, event-envelope lineage, and a deterministic durable failure laboratory. `nifra levels` L4 now uses the deep adversarial contract engine through its explicitly isolated executor. Also add hash-verifiable adapter certification profiles and duplicate physical Nifra/React install detection in `nifra doctor`/`nifra check`.

### Patch Changes

- Updated dependencies [63d3845]
- Updated dependencies [246f498]
  - @nifrajs/core@1.12.0
  - @nifrajs/testing@1.12.0
  - @nifrajs/client@1.12.0
  - @nifrajs/schema@1.12.0
  - @nifrajs/web@1.12.0
  - @nifrajs/mcp@1.12.0
  - @nifrajs/runner@1.12.0
  - create-nifra@1.12.0

## 1.11.0

### Minor Changes

- 2dde7e5: Add the effect ledger, sandboxed contract-generated invariant tests, and the verification ladder.

  **Effect ledger** - a per-request, append-only, ordered record of side-effect intents and outcomes.
  Routes that declare `schema.capabilities` get a bounded, token-only ledger when the server enables
  `server({ effectLedger })`; each `useCapability(c, id, { target, cost, digest })` beacon
  records an intent, `recordCapabilityOutcome` records its terminal result without double-debiting
  admission, and the sink receives the sealed ledger when the response settles - on success and
  error responses alike, so partial work is audited. Entries carry capability ids, phases, adapter
  tokens, dimensionless cost counters, an optional keyed-HMAC payload digest, and bounded error codes;
  the entry type has no payload field, and the sealed ledger names the route _pattern_ plus the declared
  capability set, never the concrete URL - redaction holds by construction. Includes an optional
  tamper-evident hash chain, a bounded in-memory sink,
  and `computeEffectDigest` (keyed HMAC-SHA-256, so low-entropy data cannot be brute-forced from a
  stored digest). The hash chain binds route identity, declarations, timestamps, and entries. Sink
  failures are logged without their potentially-sensitive message and do not turn a successful effect
  into a retryable 500; transactional audit belongs in the effect's owning transaction. Routes without
  capability declarations keep the existing fast path unchanged.

  **Contract-generated invariant tests** - `runContractInvariants(app, { executor })` fuzzes each route from its
  declared JSON Schema with a deterministic seeded generator and verifies what the contract promises:
  valid inputs never crash, 2xx responses conform to the declared response schema, schema-violating
  bodies are rejected (never accepted, never a crash), and a route-level classification never
  understates its field-level tags. Findings carry the case seed for exact reproduction; ungeneratable
  routes are reported as skipped, never silently dropped.
  Dynamic execution requires an explicit `invariants.executor` backed by a disposable app/sandbox;
  verification never invokes a live app implicitly, and any skipped route prevents L4.

  **Verification ladder** - `nifra levels` computes L0 typed contract → L1 route assurance → L2
  capability lockfile → L3 route manifest → L4 invariant-tested from the existing gates. Levels are
  cumulative and computed, never self-declared; `--min <n>` gates CI on a required floor.

- 279f80c: Add a deterministic versioned Nifra manifest that joins route schemas, assurance evidence,
  capabilities, and field-level response classification in one hash-verified artifact. Manifests can be
  signed through an operator-provided Ed25519 KMS/HSM callback; Nifra never handles private keys.

  `nifra manifest emit` refuses failing assurance and writes byte-stable output, while
  `nifra manifest diff <before> <after>` hash-verifies both artifacts and fails deployment promotion on
  breaking contract, lost assurance, expanded effects, or increased data sensitivity.

### Patch Changes

- Updated dependencies [2dde7e5]
- Updated dependencies [80ed7b8]
- Updated dependencies [279f80c]
- Updated dependencies [5638ada]
- Updated dependencies [279f80c]
  - @nifrajs/core@1.11.0
  - create-nifra@1.11.0
  - @nifrajs/client@1.11.0
  - @nifrajs/web@1.11.0
  - @nifrajs/schema@1.11.0
  - @nifrajs/mcp@1.11.0
  - @nifrajs/runner@1.11.0

## 1.10.0

### Minor Changes

- 92181be: Add hardened effect and capability assurance: reflected route declarations, fail-closed runtime
  beacons, static effect-provenance analysis, deterministic capability lockfiles, HTTP safe-method
  guards, and effect-specific request or durable idempotency requirements.

  Add `nifra capabilities snapshot` and `nifra capabilities check` so capability drift and raw
  provider bypasses can be enforced in CI without adding work to the default request path.

### Patch Changes

- Updated dependencies [92181be]
- Updated dependencies [3773f0a]
- Updated dependencies [92181be]
  - @nifrajs/core@1.10.0
  - @nifrajs/client@1.10.0
  - @nifrajs/schema@1.10.0
  - @nifrajs/web@1.10.0
  - @nifrajs/mcp@1.10.0
  - @nifrajs/runner@1.10.0
  - create-nifra@1.10.0

## 1.9.1

### Patch Changes

- 3eb27ae: Internal tidy - remove a dead local variable in the query engine and clean up example wording in doc comments. No API or behavior change.
- Updated dependencies [3eb27ae]
  - @nifrajs/web@1.9.1
  - @nifrajs/mcp@1.9.1
  - @nifrajs/client@1.9.1
  - @nifrajs/core@1.9.1
  - @nifrajs/runner@1.9.1
  - @nifrajs/schema@1.9.1
  - create-nifra@1.9.1

## 1.9.0

### Patch Changes

- Updated dependencies [03cd76f]
- Updated dependencies [0e1b4cc]
- Updated dependencies [6b67833]
- Updated dependencies [03cd76f]
  - @nifrajs/core@1.9.0
  - @nifrajs/web@1.9.0
  - @nifrajs/client@1.9.0
  - @nifrajs/schema@1.9.0
  - @nifrajs/mcp@1.9.0
  - @nifrajs/runner@1.9.0
  - create-nifra@1.9.0

## 1.8.0

### Minor Changes

- e47c4c5: Add reflection-time route assurance: middleware and plugins can publish lifecycle-accurate enforcement
  evidence, ordered policies fail closed on unclassified/missing/forbidden evidence, official hardening
  middleware emits canonical evidence, and `nifra assure` exposes a human/JSON CI gate.
- 9433ad9: Add `nifra upgrade <version>`: an executable, per-release upgrade runner. A recipe declares the
  mechanical edits a target version needs - a dependency-pin sweep (sets every matching `@nifrajs/*`
  dependency to the target version across the workspace, preserving each spec's `^`/`~`/exact style and
  skipping `workspace:`/`link:` specs) and exact import-specifier moves - and the runner applies them
  `detect → transform → verify`, reusing the existing `nifra check` gate rather than adding a new one.
  Dry-run by default (`--write` applies, `--no-verify` skips the check, `--list` shows targets); fail-closed
  on an unknown version or a missing package.json; deterministic and idempotent. Ships the 1.8.0 recipe.
  Transforms are intentionally string/specifier-level - structural (AST) codemods are deferred until a
  recipe needs one.

### Patch Changes

- Updated dependencies [e47c4c5]
- Updated dependencies [1ffd48b]
  - @nifrajs/core@1.8.0
  - @nifrajs/web@1.8.0
  - @nifrajs/client@1.8.0
  - @nifrajs/schema@1.8.0
  - @nifrajs/mcp@1.8.0
  - @nifrajs/runner@1.8.0
  - create-nifra@1.8.0

## 1.7.0

### Patch Changes

- 9f23e90: Fix `nifra build --target static` producing pages that render but never hydrate. The prerender pass hardcoded a placeholder client entry, but the real bundle is content-hashed - so the prerendered HTML's hydration `<script src>` 404'd and every control was inert. `BuildTargetOptions.prerenderApp` is now a factory `(client: BuildManifest) => app` invoked with the completed client build, so the emitted `<script src>` uses the real hashed entry (plus the same styles / route-preload the SSR targets use). A regression test asserts the static HTML references the emitted hashed entry and that the file exists under `/assets`. Breaking only for code calling `buildTarget("static", …)` directly (pass a factory instead of a prebuilt app); `nifra build --target static` users just get working hydration.
- Updated dependencies [bd95181]
- Updated dependencies [9f23e90]
  - @nifrajs/core@1.7.0
  - @nifrajs/web@1.7.0
  - @nifrajs/client@1.7.0
  - @nifrajs/schema@1.7.0
  - @nifrajs/mcp@1.7.0
  - @nifrajs/runner@1.7.0
  - create-nifra@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/client@1.6.0
- @nifrajs/core@1.6.0
- @nifrajs/mcp@1.6.0
- @nifrajs/runner@1.6.0
- @nifrajs/schema@1.6.0
- @nifrajs/web@1.6.0
- create-nifra@1.6.0

## 1.5.0

### Minor Changes

- 1ac2fde: API breaking-change gate: `snapshotRoutes` + `diffRouteSnapshots` in `@nifrajs/core/diff` (direction-aware - a new required request field or a removed response field breaks; widening a request enum or adding a response field doesn't; fails closed on anything unprovable), and `nifra snapshot` / `nifra diff <baseline>` CLI commands that exit non-zero on breaking changes for CI.

### Patch Changes

- Updated dependencies [1ac2fde]
- Updated dependencies [bd3433f]
- Updated dependencies [70aa836]
  - @nifrajs/core@1.5.0
  - @nifrajs/schema@1.5.0
  - @nifrajs/client@1.5.0
  - @nifrajs/web@1.5.0
  - @nifrajs/mcp@1.5.0
  - @nifrajs/runner@1.5.0
  - create-nifra@1.5.0

## 1.4.0

### Patch Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.
- Updated dependencies [4d25970]
  - @nifrajs/core@1.4.0
  - @nifrajs/schema@1.4.0
  - @nifrajs/web@1.4.0
  - @nifrajs/client@1.4.0
  - @nifrajs/mcp@1.4.0
  - @nifrajs/runner@1.4.0
  - create-nifra@1.4.0

## 1.3.1

### Patch Changes

- 578da89: fix(cli): refresh the `nifra mcp` types/examples corpus for the 1.3.0 API + gate it

  `@nifrajs/cli` bundles the MCP corpus (`docs/types.json` / `examples.json`) behind `nifra_types` and
  `nifra_context`. It shipped **stale in 1.3.0** - the release regenerated `api-reference.md` + the LLM cards
  but not this corpus - so agents couldn't see `server().tool()` / `.resource()` / `.prompt()`,
  `onValidationError`, `RouteSchema.errors`, `ToolAnnotations`, or `generateLlmsTxt` via MCP. Regenerated.

  To prevent recurrence: `changeset:publish` now runs `gen:llms` after the build, so every published tarball
  carries a corpus regenerated from that exact build - the corpus can no longer ship stale regardless of what's
  committed.

  - @nifrajs/client@1.3.1
  - @nifrajs/mcp@1.3.1
  - @nifrajs/runner@1.3.1
  - @nifrajs/schema@1.3.1
  - @nifrajs/web@1.3.1
  - create-nifra@1.3.1

## 1.3.0

### Minor Changes

- 9f8d2aa: feat(cli): `nifra_check` / `nifra_test` MCP tools accept a `dir` to scope a subdirectory

  The MCP server runs at the project root, so `nifra check` / `nifra test` always ran from there - no way to
  target one app in a monorepo (a common pain: the root holds a builder + generated apps, but you want to
  check just `app/`). Both tools now take an optional `dir` (relative to the root, e.g. `"app"` or
  `"packages/api"`); the check/test runs against that subtree. Path-traversal-guarded - a `dir` that climbs
  out of the root (`../`, an absolute path elsewhere) is rejected, not run.

- 4a4b1c4: feat: `server().resource()` / `.prompt()` - app-declared MCP resources & prompts

  Completing the MCP trio alongside `.tool()`: an app can now expose its own MCP **resources**
  (`.resource(uri, { name, description?, mimeType? }, read)`) and **prompts** (`.prompt(name, { description,
arguments? }, handler)`). `nifra mcp` surfaces them in `resources/list` + `resources/read` and `prompts/list`

  - `prompts/get` (namespaced per app in a monorepo). The `read`/`handler` closures run in the app process, so
    they capture whatever app state they need - no HTTP round-trip.

### Patch Changes

- Updated dependencies [4a4b1c4]
- Updated dependencies [4a4b1c4]
  - @nifrajs/mcp@1.3.0
  - @nifrajs/schema@1.3.0
  - @nifrajs/web@1.3.0
  - @nifrajs/client@1.3.0
  - @nifrajs/runner@1.3.0
  - create-nifra@1.3.0

## 1.2.2

### Patch Changes

- 281844e: fix(cli): `nifra check` respects `.gitignore` and bounds the MCP result

  Two fixes so `nifra check` (and the `nifra_check` MCP tool) can't drown in a repo full of generated apps:

  - **Scanner honours `.gitignore`** - `walkSource` now filters candidates through one batched
    `git check-ignore`, so a gitignored generated/build tree isn't walked. A repo that gitignores, e.g., a
    238-app generated-output dir went from a **52 MB** check result to ~130 KB. Degrades to the built-in
    ignore list (node_modules/dist/…) when there's no git repo - never throws.
  - **`nifra_check` MCP tool caps its output** - `collectCheckResult` gains `maxDiagnostics` (the tool sets 100) and reports `truncated: { shown, total }`, so a huge project can't emit an MCP message large enough
    to break the stdio transport (`-32000: Connection closed`). `ok` still reflects the FULL set; the CLI
    terminal / `--json` output stays unbounded.
  - @nifrajs/client@1.2.2
  - @nifrajs/mcp@1.2.2
  - @nifrajs/runner@1.2.2
  - @nifrajs/schema@1.2.2
  - @nifrajs/web@1.2.2
  - create-nifra@1.2.2

## 1.2.1

### Patch Changes

- Updated dependencies [c3ebd73]
  - @nifrajs/web@1.2.1
  - @nifrajs/client@1.2.1
  - @nifrajs/mcp@1.2.1
  - @nifrajs/runner@1.2.1
  - @nifrajs/schema@1.2.1
  - create-nifra@1.2.1

## 1.2.0

### Patch Changes

- @nifrajs/client@1.2.0
- @nifrajs/schema@1.2.0
- @nifrajs/web@1.2.0
- @nifrajs/mcp@1.2.0
- @nifrajs/runner@1.2.0
- create-nifra@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [9905f7f]
- Updated dependencies [17e57c4]
- Updated dependencies [37d2383]
  - create-nifra@1.1.0
  - @nifrajs/schema@1.1.0
  - @nifrajs/web@1.1.0
  - @nifrajs/client@1.1.0
  - @nifrajs/mcp@1.1.0
  - @nifrajs/runner@1.1.0

## 1.0.0

### Minor Changes

- 5673ff1: `nifra_types` - a new MCP tool that returns the **exact TypeScript** of any exported `@nifrajs/*` symbol (interface, type, class, function, const). Each signature is generated at build time from the package's built `.d.ts` with the TS compiler - the literal declaration, complete and authoritative, never prose and never truncated - and shipped inside `@nifrajs/cli` (`docs/types.json`), so it works offline and on every transport (stdio, HTTP, the edge `/mcp`).

  This closes the gap that made agents fall back to reading `.d.ts`: when an agent needs the precise shape of a type (`RateLimitStore`, `RouteSchema`, a function signature), `nifra_types({ name })` returns the literal block. The tool description makes the completeness explicit ("the source of truth - do NOT read `.d.ts`"), and `nifra_docs` now points at it for exact types. `nifra_examples_app` on the public docs MCP, and the `@nifrajs/cli/mcp` self-host surface, both expose it too (`TypeEntry` is re-exported).

### Patch Changes

- c099d5f: Add `@nifrajs/mcp` - build MCP servers, and **MCP Apps** (interactive `ui://` widgets, SEP-1865), for a nifra app.

  MCP tools have only ever returned text. MCP Apps lets a tool return **interactive UI**: a tool links a `ui://` resource (MIME `text/html;profile=mcp-app`); the host renders it in a sandboxed iframe and bridges it to the server over MCP-JSON-RPC-on-`postMessage`. `@nifrajs/mcp` ships:

  - The transport-agnostic JSON-RPC core (`handleRpc`, shared with `@nifrajs/cli`'s dev MCP) extended for MCP Apps - `structuredContent`, `_meta.ui.resourceUri`, and the `io.modelcontextprotocol/ui` capability.
  - `respondMcpHttp` - a Web `fetch` handler you mount at `POST /mcp`. nifra route handlers can return a raw `Response`, so mounting is one line per verb.
  - `defineMcpWidget` - author a `ui://` widget as one self-contained HTML doc with a tiny zero-dependency `postMessage` bridge inlined (`mcpApp.onData(render)` to render the host-pushed `structuredContent`; `mcpApp.callTool(...)` to re-invoke a tool through the host).
  - `defineMcpTool` + `createMcpServer` - wire tools to widgets and get a mountable server. See `examples/mcp-app/`.
  - `@nifrajs/mcp/react` - `reactWidget({ component })` authors a widget from a React component instead of an HTML string: the component is bundled for the browser (Bun.build) and re-renders on each `structuredContent` push over the bridge. `react`/`react-dom` resolve from the consumer; the core stays dependency-free.
  - **Host theming + render intent** (see `THEMING.md`). `defineMcpTool({ intent })` adds `_meta.ui.intent` (`table`/`list`/`form`/…) so a generative host renders `structuredContent` with its own themed component. For iframe widgets, the bridge handles a `ui/notifications/theme` push and auto-applies the host's shadcn/Tailwind semantic tokens (`--primary`, `--card`, `--border`, `--radius`, …) to the widget root - so a widget that styles with `hsl(var(--primary))` matches the embedding app with zero extra code.

  `@nifrajs/cli`'s MCP protocol core moved into `@nifrajs/mcp` (the CLI re-exports it); behavior is unchanged - a tool whose handler returns a plain `string` behaves exactly as before. nifra's own public docs MCP (nifra.dev `/mcp`) now also dogfoods this - `nifra_examples_app` renders the examples as an interactive widget.

- bb31594: Surface `@nifrajs/middleware` where agents look. The `nifra_context` conventions (and a scaffolded app's `AGENTS.md`) now carry a one-line pointer: cross-cutting concerns - rate limiting (`429`), CORS, security headers, body limits, auth, CSRF, IP restriction, caching, compression - are `app.use(...)` plugins in `@nifrajs/middleware`; call `nifra_docs("middleware")` for the full list. So an agent setting up routes finds the built-in middleware (it already shipped) without having to think to search for it.
- de9675b: Pre-1.0 security hardening pass. A framework-wide audit found no critical/high issues; these close the medium/low items it surfaced.

  - **`cache()` - no cross-user leak by default.** A `200` to a request bearing `Authorization`/`Cookie` is no longer stored (and replayed to other users) unless the response is explicitly `Cache-Control: public`/`s-maxage` (RFC 9111 §3.5). Opt back in per cache with `cacheAuthenticated: true` for a route that's identical for every caller.
  - **`idempotency()` - route-scoped keys + a `key` hook.** The default store key is now scoped by method+path, so the same `Idempotency-Key` on a different endpoint can't collide and replay another resource's response. Added a `key(req, header)` option to scope by principal (e.g. user id). Method matching normalized to upper-case.
  - **`etag()` - a `304` no longer carries the `200`'s `Content-Length`/`Content-Type`.**
  - **`@nifrajs/core` - inbound WebSocket frames are capped** when serving on Bun (`listen()`): frames over `wsMaxPayloadBytes` (default `maxBodyBytes`, 1 MB) are rejected by the runtime before reaching a handler, so a huge frame can't be buffered/parsed into memory. New `ServerOptions.wsMaxPayloadBytes`.
  - **`@nifrajs/core` - WebSocket routes are same-origin by default (CSWSH).** A `ws()` route with no `allowedOrigins` now rejects a **cross-origin browser** handshake (an `Origin` whose host differs from the request's) with `403` - closing cross-site WebSocket hijacking, since browsers send cookies on WS handshakes and don't apply CORS. Non-browser clients (no `Origin`) and same-origin browsers are unaffected. **Breaking** for a route that served a cross-origin browser without declaring `allowedOrigins`: set `allowedOrigins` to the permitted origins (or `() => true` for a genuinely public socket).
  - **`@nifrajs/node` - static file handler** now adds `X-Content-Type-Options: nosniff` and re-checks the real path (symlink containment) before streaming, matching the image server.
  - **`@nifrajs/mcp` - widget bridge** now rejects `postMessage` events whose source isn't the parent window (including null-source synthetic events), closing a spoofing gap the previous guard left open.
  - **`@nifrajs/cli` - the MCP `nifra_run`/`nifra_ws` `entry` arg** is kept inside the project root, so a crafted `entry` can't import/execute a module outside the project.

- a001558: **MCP warm worker survives a single per-request cancel.** The warm `nifra_run`/`nifra_render` worker is shared across concurrent calls (its `pending` map is id-keyed so several requests can be outstanding at once). Cancelling one request used to kill the whole worker process, which rejected every other in-flight request and forced a cold rebuild - defeating the warm reuse + concurrency the tool is built for. A per-request cancel now drops only that request and leaves the worker hot; it's still replaced on file change as before.
- Updated dependencies [f1f0e18]
- Updated dependencies [c099d5f]
- Updated dependencies [bb31594]
- Updated dependencies [3efb7cd]
- Updated dependencies [de9675b]
  - @nifrajs/client@1.0.0
  - @nifrajs/web@1.0.0
  - @nifrajs/mcp@1.0.0
  - create-nifra@1.0.0
  - @nifrajs/schema@1.0.0
  - @nifrajs/runner@1.0.0

## 1.0.0-beta.4

### Patch Changes

- Updated dependencies [5181a35]
  - create-nifra@1.0.0-beta.4
  - @nifrajs/client@1.0.0-beta.4
  - @nifrajs/runner@1.0.0-beta.4
  - @nifrajs/schema@1.0.0-beta.4
  - @nifrajs/web@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/client@1.0.0-beta.3
- @nifrajs/runner@1.0.0-beta.3
- @nifrajs/schema@1.0.0-beta.3
- @nifrajs/web@1.0.0-beta.3
- create-nifra@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Updated dependencies [5018546]
  - @nifrajs/web@0.1.0-beta.2
  - @nifrajs/client@0.1.0-beta.2
  - @nifrajs/runner@0.1.0-beta.2
  - @nifrajs/schema@0.1.0-beta.2
  - create-nifra@0.1.0-beta.2

import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.6.
 *
 * `@nifrajs/islets` and `@nifrajs/web/nano` merge into `@nifrajs/web/islands`. The imports move
 * mechanically; the call shapes and the island host markup do not, so the notes list each removed
 * name with what replaces it.
 */
export const recipe: UpgradeRecipe = {
  version: "5.6.0",
  pins: [
    { match: "@nifrajs/", to: "5.6.0" },
    { match: "create-nifra", to: "5.6.0" },
    { match: "nifra", to: "5.6.0" },
  ],
  dependencyMoves: [{ from: "@nifrajs/islets", to: "@nifrajs/web", toVersion: "5.6.0" }],
  importMoves: [
    { from: "@nifrajs/islets", to: "@nifrajs/web/islands" },
    { from: "@nifrajs/web/nano", to: "@nifrajs/web/islands" },
    { from: "@nifrajs/uploads/detect", to: "@nifrajs/core/file-type" },
  ],
  retiredMarkers: [
    {
      marker: "nifra-expect NF-C021",
      instead: "nothing: NF-C021 is retired, so delete the comment",
    },
    {
      marker: "nifra-expect NF-C023",
      instead: "nothing: NF-C023 is retired, so delete the comment",
    },
  ],
  affects: [
    "@nifrajs/cli",
    "@nifrajs/coding-agent",
    "@nifrajs/core",
    "@nifrajs/env",
    "@nifrajs/islets",
    "@nifrajs/middleware",
    "@nifrajs/schema",
    "@nifrajs/uploads",
    "@nifrajs/web",
    "@nifrajs/web-react",
    "@nifrajs/web-svelte",
    "@nifrajs/web-vanilla",
  ],
  notes: [
    'Island hosts are any element with `data-island="<id>"`. `<nifra-island data-id>` markers are no longer mounted: rename `data-id` to `data-island`, `data-props` to `data-island-props`, `data-strategy` to `data-island-strategy` and `data-media` to `data-island-media`. The `@nifrajs/web-react` `<Island>` marker renders the new names; `@nifrajs/islets`\' `data-island-state` becomes `data-island-props`.',
    '`@nifrajs/islets`: `island("id", setup)` plus its own `mountIslands()` becomes `const id = bindIsland(setup)` and `mountIslands({ id })`; the setup still receives `{ root, state }` and returns its handlers, and gains `props` and `onDispose(fn)`. `islandState(value)` is `islandProps(value)`. `signal`, `computed`, `effect` and `batch` keep their shapes.',
    "`@nifrajs/web/nano`: a signal is read by calling it (`count()`, was `count.get()`); `computed(fn, [deps])` is `computed(fn)`, which tracks what it reads; `bind(el, source, apply)` is `effect(() => apply(el, source()))`; `bindResource` is an `effect` over the resource's state; `resource(fetcher, [deps])` is `resource(source, (key, abort) => fetcher)`, where `source` returns the key and the fetcher's reads are not dependencies; `Readable.subscribe(fn)` is `effect(() => fn(source()))`. `bindList(source, container, { key, create, update })` keeps its shape; `key` receives only the item.",
    "Effects, computeds, `bindList` and `resource` created while an enhancer sets up stop when its island unmounts, so the disposers nano asked you to collect can go. An effect created later, inside an event handler, is not owned.",
    "`nifra check` adds NF-C047 (a `data-bind-*` name its `bindIsland` setup never declares) and NF-C048 (a binding no `bindIsland` host walks), and NF-C022 now checks the islands `bindList` key. NF-C021 and NF-C023 are retired; a `nifra.check.json` override of either no longer does anything.",
    "`nifra scaffold --variant stateful` emits a reactive island where it emitted the nano pattern.",
    "The server-component pipeline is certified on Vite 8.3.4: set `vite` to exactly 8.3.4. Until it matches, the plugin's guard stops the build and `nifra check` names the installed version.",
    '`withISR` over any store but `MemoryCacheStore` (a `KVCacheStore`, or a `CacheStore` of your own) needs `storeSecret`, the same in every process, at least 32 characters and generated at random (`openssl rand -hex 32`), and throws at construction without one; on Workers, set it with `wrangler secret put` and pass `env.<NAME>`. Pages stored before the upgrade carry no signature, so each renders once more and is stored signed. A page that fails the check reaches `onStoreError` with op `"verify"`.',
    "`detectFileType`, `DETECTABLE_MIME_TYPES`, `FILE_TYPE_PREFIX_BYTES` and the `FileType` type are exported from `@nifrajs/core/file-type`, and `@nifrajs/uploads` no longer exports them. `@nifrajs/uploads/detect` imports are rewritten; import those names from `@nifrajs/core/file-type` where they came from `@nifrajs/uploads`. `@nifrajs/uploads` takes `@nifrajs/core` as a peer dependency.",
    "`idempotency()` from `@nifrajs/middleware` covers the routes declared after it, and installing it after a route that uses a covered method throws: move the `.use(idempotency(...))` above those routes. A replay now runs just before the handler, after the route's authentication, validation and every guard admit the retry, and stored records without an admission marker are refused. It returns an `IdentityPlugin` (from `@nifrajs/core`) rather than a `Middleware`: replace an explicit `Middleware` annotation on it, or let TypeScript infer the type.",
    '`multipartBody` and `t.form` parse a form themselves, by the Fetch standard\'s parser, instead of the runtime\'s `formData()`, so every runtime reads the same parts. A part\'s disposition must be `form-data; name="..."` with an optional `; filename="..."`, a body led by a preamble is refused, and a file part with no `Content-Type` is `text/plain` on every runtime.',
    "`@nifrajs/web-vanilla`'s `html` writes each value for the place it lands: an unquoted attribute value is quoted, a `javascript:` or `vbscript:` URL at the start of a URL attribute becomes `about:invalid`, and a string or nested template throws as a tag name, inside `<script>` or `<style>`, or in an `on*` or `srcdoc` value. Interpolate a number or `raw()` trusted text there instead.",
    "A reload of the page on screen keeps the identity of every part of `data` it did not change, and React and Preact layouts render memoized on their own props. Svelte pages receive `data` as the router published it, not as a deep reactive proxy, so writing into `data` in place no longer updates the page: copy what you edit into the page's own state. A page that compares `data` with its value from before a reload exports `shareData = false`.",
    'While an intercept boundary holds a route in a modal, `useLocation`, `useSearch`, `useMatches` and the route props describe the page underneath; `RouterState.intercepted` names the boundary, and `path` stays the address-bar URL. A form with no action inside `data-nifra-boundary="<name>"` posts to the target, and the result arrives as the boundary\'s `actionData`.',
    "`@nifrajs/coding-agent`: a plan with more subagent nodes than `limits.maxChildren` (default 4) fails to compile with `E_MAX_CHILDREN`, the ceiling counts retries, and `OrchestrationHost`'s `policy.allowedCapabilities` bounds every catalog step a plan resolves to.",
    "`nifra mcp` answers a line that is not valid UTF-8 with `-32700` instead of running it, sends no reply to a notification whose handler throws, processes a last line without a trailing newline, and lets running requests answer before it shuts down when stdin closes.",
    "An `authenticate()` stage, and the auth plugins built on one (`bearer()`, `jwt()`, `basicAuth()`, `apiKey()`), now gates the `mount()` and `mountFetch()` handlers registered after it, WebSocket upgrades included: a caller the stage refuses gets its response, not the mounted app. Register a mount that must stay public before the stage.",
    "`t.integer()` is bounded to the safe-integer range by default, so a JSON or query value past 2^53 - 1, which has already been rounded when it is parsed, fails validation with a 422 instead of reaching the handler as a different number. A bound passed to `t.integer()` replaces the default on that side.",
    "`env.number()` reads plain decimal text only, so `0x10`, `1e3` and `Infinity` are refused at startup. A value of only spaces is unset for `env.number()` and `env.port()`, so a `default` applies, and `env.boolean({ default })` returns the default for a variable that is set but empty.",
    "`etag()` keeps an `ETag` the handler already set and answers `If-None-Match` against it, instead of replacing it with a hash of the body.",
  ],
}

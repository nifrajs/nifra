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
    "@nifrajs/islets",
    "@nifrajs/uploads",
    "@nifrajs/web",
    "@nifrajs/web-react",
  ],
  notes: [
    'Island hosts are any element with `data-island="<id>"`. `<nifra-island data-id>` markers are no longer mounted: rename `data-id` to `data-island`, `data-props` to `data-island-props`, `data-strategy` to `data-island-strategy` and `data-media` to `data-island-media`. The `@nifrajs/web-react` `<Island>` marker renders the new names; `@nifrajs/islets`\' `data-island-state` becomes `data-island-props`.',
    '`@nifrajs/islets`: `island("id", setup)` plus its own `mountIslands()` becomes `const id = bindIsland(setup)` and `mountIslands({ id })`; the setup still receives `{ root, state }` and returns its handlers, and gains `props` and `onDispose(fn)`. `islandState(value)` is `islandProps(value)`. `signal`, `computed`, `effect` and `batch` keep their shapes.',
    "`@nifrajs/web/nano`: a signal is read by calling it (`count()`, was `count.get()`); `computed(fn, [deps])` is `computed(fn)`, which tracks what it reads; `bind(el, source, apply)` is `effect(() => apply(el, source()))`; `bindResource` is an `effect` over the resource's state; `resource(fetcher, [deps])` is `resource(source, (key, abort) => fetcher)`, where `source` returns the key and the fetcher's reads are not dependencies; `Readable.subscribe(fn)` is `effect(() => fn(source()))`. `bindList(source, container, { key, create, update })` keeps its shape; `key` receives only the item.",
    "Effects, computeds, `bindList` and `resource` created while an enhancer sets up stop when its island unmounts, so the disposers nano asked you to collect can go. An effect created later, inside an event handler, is not owned.",
    "`nifra check` adds NF-C047 (a `data-bind-*` name its `bindIsland` setup never declares) and NF-C048 (a binding no `bindIsland` host walks), and NF-C022 now checks the islands `bindList` key. NF-C021 and NF-C023 are retired; a `nifra.check.json` override of either no longer does anything.",
    "`nifra scaffold --variant stateful` emits a reactive island where it emitted the nano pattern.",
    "The server-component pipeline is certified on Vite 8.3.4: set `vite` to exactly 8.3.4. Until it matches, the plugin's guard stops the build and `nifra check` names the installed version.",
    "`detectFileType`, `DETECTABLE_MIME_TYPES`, `FILE_TYPE_PREFIX_BYTES` and the `FileType` type are exported from `@nifrajs/core/file-type`, and `@nifrajs/uploads` no longer exports them. `@nifrajs/uploads/detect` imports are rewritten; import those names from `@nifrajs/core/file-type` where they came from `@nifrajs/uploads`. `@nifrajs/uploads` takes `@nifrajs/core` as a peer dependency.",
  ],
}

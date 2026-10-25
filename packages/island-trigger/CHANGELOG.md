# @nifrajs/island-trigger

## 5.8.0

No changes in this release.

## 5.7.0

No changes in this release.

## 5.6.0

### Patch Changes

- c403814: `@nifrajs/web/islands` now carries the reactive island runtime: `signal`, `computed`, `effect`, `batch` and `untrack` with auto-tracking, plus:
  
  - `bindIsland(setup)` - an enhancer driven by markup. `state(key, fallback)` seeds a signal from the island's props, the returned handlers back `data-bind-on`, and the six `data-bind-*` attributes bind text, visibility, classes, attributes, values and events by name. `onDispose(fn)` runs on unmount, also when registered later from a handler, and at once when registered after the island unmounted. `ctx.props` is `undefined` when the props attribute is absent or malformed. A setup or binding that throws stops everything the island started; on unmount a cleanup that throws is logged and the others still run.
  - `bindList(source, container, { key, create, update })` - keyed list rendering. A surviving item keeps its node, and a reorder moves only the nodes outside the longest run already in order: swapping two rows of 1,000 moves two nodes.
  - `resource(source, fetcher)` - an async value keyed by a getter, with a `pending`/`ready`/`error` state. A newer key aborts the older request and only the newest result lands; `refetch()` and `dispose()` are on the returned reader; once disposed, `refetch()` does nothing.
  - `islandProps(value)` - the JSON for an island's props attribute. Emit it through an escaping renderer inside quotes: `data-island-props="${...}"`.
  
  Every effect, list binding and resource an enhancer creates belongs to its island and stops when `mountIslands`' disposer runs. An effect's run, the first included, finishes before the effects its writes trigger run, itself among them.
  
  Island hosts are any element with `data-island="<id>"`; props, strategy and media move to `data-island-props`, `data-island-strategy` and `data-island-media`. `<nifra-island data-id>` markers are no longer mounted. Hosts inside `data-island-ignore` are skipped, and a host already mounted is not mounted twice. `mountIslands` accepts enhancers with different props types in one map.
  
  The `@nifrajs/web-react` `<Island>` marker renders the new attributes, and `nifra scaffold` emits them.
  
  `@nifrajs/web/nano` and the `@nifrajs/islets` package are removed; `@nifrajs/web/islands` replaces both. `nifra upgrade` moves the imports and the dependency, and its notes map each removed name to its replacement. A signal is read by calling it, `computed` tracks what it reads, and an island's effects, lists and resources stop when it unmounts, so no disposer needs collecting.

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

- 46b269a: `scheduleTrigger` ships smaller. Every strategy returns the same one-shot disposer, which stays safe to call after the trigger fired.

## 4.0.2

## 4.0.1

## 4.0.0

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

## 3.1.0

## 3.0.0

### Patch Changes

- 86a555b: The roadmap contract surfaces are now shipped across the public packages: shared island triggers,
  typed content indexes and joins, client loader/action hooks, and unified static, dynamic, and
  intercepting boundary modes. WebSocket routes also support opt-in synchronous outbound validation
  through `sendSchema` + `validateSend`; invalid or asynchronous outbound frames fail closed while the
  default remains type-level only.

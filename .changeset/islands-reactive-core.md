---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
"@nifrajs/cli": patch
---

`@nifrajs/web/islands` now carries the reactive island runtime: `signal`, `computed`, `effect`, `batch` and `untrack` with auto-tracking, plus:

- `bindIsland(setup)` - an enhancer driven by markup. `state(key, fallback)` seeds a signal from the island's props, the returned handlers back `data-bind-on`, and the six `data-bind-*` attributes bind text, visibility, classes, attributes, values and events by name. `onDispose(fn)` runs on unmount, also when registered later from a handler.
- `bindList(source, container, { key, create, update })` - keyed list rendering. A surviving item keeps its node, and a reorder moves only the nodes outside the longest run already in order: swapping two rows of 1,000 moves two nodes.
- `resource(source, fetcher)` - an async value keyed by a getter, with a `pending`/`ready`/`error` state. A newer key aborts the older request and only the newest result lands; `refetch()` and `dispose()` are on the returned reader.
- `islandProps(value)` - the JSON for an island's props attribute.

Every effect, list binding and resource an enhancer creates belongs to its island and stops when `mountIslands`' disposer runs.

Island hosts are any element with `data-island="<id>"`; props, strategy and media move to `data-island-props`, `data-island-strategy` and `data-island-media`. `<nifra-island data-id>` markers are no longer mounted. Hosts inside `data-island-ignore` are skipped, and a host already mounted is not mounted twice. `mountIslands` accepts enhancers with different props types in one map.

The `@nifrajs/web-react` `<Island>` marker renders the new attributes, and `nifra scaffold` emits them.

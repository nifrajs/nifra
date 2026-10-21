---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
"@nifrajs/cli": patch
"@nifrajs/island-trigger": patch
---

`@nifrajs/web/islands` now carries the reactive island runtime: `signal`, `computed`, `effect`, `batch` and `untrack` with auto-tracking, plus:

- `bindIsland(setup)` - an enhancer driven by markup. `state(key, fallback)` seeds a signal from the island's props, the returned handlers back `data-bind-on`, and the six `data-bind-*` attributes bind text, visibility, classes, attributes, values and events by name. `onDispose(fn)` runs on unmount, also when registered later from a handler, and at once when registered after the island unmounted. `ctx.props` is `undefined` when the props attribute is absent or malformed. A setup or binding that throws stops everything the island started; on unmount a cleanup that throws is logged and the others still run.
- `bindList(source, container, { key, create, update })` - keyed list rendering. A surviving item keeps its node, and a reorder moves only the nodes outside the longest run already in order: swapping two rows of 1,000 moves two nodes.
- `resource(source, fetcher)` - an async value keyed by a getter, with a `pending`/`ready`/`error` state. A newer key aborts the older request and only the newest result lands; `refetch()` and `dispose()` are on the returned reader; once disposed, `refetch()` does nothing.
- `islandProps(value)` - the JSON for an island's props attribute. Emit it through an escaping renderer inside quotes: `data-island-props="${...}"`.

Every effect, list binding and resource an enhancer creates belongs to its island and stops when `mountIslands`' disposer runs. An effect's run, the first included, finishes before the effects its writes trigger run, itself among them.

Island hosts are any element with `data-island="<id>"`; props, strategy and media move to `data-island-props`, `data-island-strategy` and `data-island-media`. `<nifra-island data-id>` markers are no longer mounted. Hosts inside `data-island-ignore` are skipped, and a host already mounted is not mounted twice. `mountIslands` accepts enhancers with different props types in one map.

The `@nifrajs/web-react` `<Island>` marker renders the new attributes, and `nifra scaffold` emits them.

`@nifrajs/web/nano` and the `@nifrajs/islets` package are removed; `@nifrajs/web/islands` replaces both. `nifra upgrade` moves the imports and the dependency, and its notes map each removed name to its replacement. A signal is read by calling it, `computed` tracks what it reads, and an island's effects, lists and resources stop when it unmounts, so no disposer needs collecting.

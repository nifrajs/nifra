---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

Add `@nifrajs/web/nano`, the explicit-reactivity lane for small apps that want local state without a
framework runtime. It exports `signal`, `computed(fn, [deps])` with an explicit dependency array,
`resource(fetcher, [deps])` - an async cell with a `pending`/`error`/`ready` value union that aborts a
superseded fetch and drops its stale result - and `bind` / `bindList` / `bindResource` DOM edges, all
with no virtual DOM and no auto-tracking. Because every reactive edge is a visible call, `nifra check`
gains three static lints: `NF-C021` (a `bind`/`bindList`/`bindResource` whose disposer is discarded),
`NF-C022` (a `bindList` keyed by the array index), and `NF-C023` (a `computed`/`resource` that reads a
signal its deps omit). `nifra scaffold` accepts `variant: "stateful"` to emit the golden nano island
pattern on a vanilla project, and a new "nano" cookbook documents signals, keyed lists, async state,
and where the lane stops.

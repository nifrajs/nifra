# @nifrajs/islets

Fine-grained signals + declarative DOM bindings for islands - **interactivity in ~2 KB gz**, no
framework runtime. The client companion to `@nifrajs/web-vanilla`: the server renders real HTML
(zero framework JS); islands attach behavior to it in place. No VDOM, no hydration re-render -
the markup the server sent IS the initial state.

The full island bundle is just under 2 KB gzipped, and a size test keeps it there. Use
it for small interactive widgets where a full framework runtime would be overkill.

## Server side (any adapter - `@nifrajs/web-vanilla` shown)

```ts
import { html } from "@nifrajs/web-vanilla"
import { islandState } from "@nifrajs/islets" // safe to import server-side: it's just JSON.stringify

html`<section data-island="compare" data-island-state="${islandState({ count: hotels.length })}">
  <span data-bind-text="count">${hotels.length}</span>
  <button data-bind-on="click:add" type="button">Compare</button>
</section>`
```

The state attribute is the loader-data → client-signal seam: emit it through an escaping renderer
(vanilla's `html` escapes attribute quotes) and the island reads it back with `state()` - no
separate hydration payload, no data globals.

## Client side (an `islandScripts` entry)

```ts
import { island, mountIslands } from "@nifrajs/islets"

island("compare", ({ state }) => {
  const count = state("count", 0) // seeded from data-island-state, falls back to 0
  return { add: () => count.set((n) => n + 1) }
})

mountIslands() // idempotent - safe to call again after soft navigation
```

## The binding set (closed - six bindings, no expression language)

| Attribute | Effect |
| --- | --- |
| `data-bind-text="sig"` | `textContent ← String(sig())` |
| `data-bind-show="sig"` | `hidden ← !sig()` |
| `data-bind-class="active:isOpen,b:sigB"` | `classList.toggle` per pair |
| `data-bind-attr="aria-expanded:isOpen"` | `setAttribute`; `false`/`null`/`undefined` removes. Never an `on*` handler or `srcdoc`; `href`/`src`/`action` and other URL attributes take only http(s), mailto, tel or relative URLs |
| `data-bind-value="query"` | two-way `<input>`/`<select>`/`<textarea>` (`input` event) |
| `data-bind-on="click:inc,submit:save"` | `addEventListener` per pair |

Values are signal/handler **names** resolved in the island's scope - never evaluated code, so
markup cannot inject behavior. Unknown names warn once and skip; the server-rendered content
stays as-is (progressive enhancement never throws).

Render user-supplied HTML (comments, rich text) inside an element marked `data-island-ignore`.
Nothing in it binds or mounts: a sanitizer that keeps `data-*` attributes cannot let that markup
reach the island's handlers or signals, or mount an island of its own.

```html
<section data-island="comments">
  <button data-bind-on="click:save">Save</button>
  <div data-island-ignore>${sanitizedCommentHtml}</div>
</section>
```

Islands may nest. A binding belongs to its nearest island, so an outer island never binds inside a
nested island. The nested host element itself is the outer island's markup: the outer island may
bind it, for example to show or hide the nested island.

## Signals

`signal(initial)` / `computed(fn)` / `effect(fn) → dispose` / `batch(fn)` - auto-tracking with
per-run re-tracking, `Object.is` skips, synchronous updates; `batch` coalesces multiple writes
into one flush. Island-scale by design: if a widget outgrows this (lists, ownership trees,
async orchestration), that's the signal to use the Solid adapter for that page - both tiers are
first-class.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.

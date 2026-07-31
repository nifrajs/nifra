---
"@nifrajs/web": patch
---

A custom `rootId` hydrates.

```ts
renderPage({ adapter, chain, data, clientEntry, rootId: "app" })
```

That render produced a flawless server-rendered document that then hydrated nothing, forever, with an
empty console: the generated client entry mounted into `document.getElementById("root")` and skipped
mounting when it found nothing. Every framework binding, every loader and the whole SSR pass worked,
and the page was static.

`rootId` is chosen per RENDER while the client entry is emitted once per BUILD, so an id baked into the
entry can only ever be a guess. The container announces itself instead - a non-default `rootId` also
carries `ROOT_ATTRIBUTE` (`data-nifra-root`), which the entry looks for before falling back to `#root`.
It has to be the DOM and not another `window.__NIFRA_*` global, because a second copy of the id can
drift from the markup while an attribute written by the same expression as the id cannot.

A default render emits exactly the bytes it did before - the marker is absent, and `#root` is still
what the entry finds. When a document has neither, the entry now throws and names what it looked for
rather than leaving a live page that answers no clicks.

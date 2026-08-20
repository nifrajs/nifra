---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

Make islands the first-class interactivity lane for zero-runtime vanilla pages. `@nifrajs/web/islands`
now exports `defineIsland` to type an enhancer's props and `createIslandBus` for typed pub/sub between
islands that share no state. `nifra check` gains `NF-C020`, warning when an island enhancer wires an
event listener but returns no cleanup, and `nifra scaffold` emits a golden vanilla route stub. New
"Islands" cookbook documents the counter, cart-badge, and filter patterns.

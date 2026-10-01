---
"@nifrajs/cli": patch
---

fix(cli): `nifra assure --hydration` hydrates every route in its DOM run and fails when hydration does
not happen. With `happy-dom` installed, the run could not load a code-split client entry, imported
the entry only once (so routes after the first were never hydrated), and checked the page before the
framework had hydrated it. It now builds the entry so its chunks load from disk, gives each route its
own copy, waits for the document's `data-nifra-hydrated` marker (up to 5s) and reports a route that
never gets there. An error the client throws while hydrating is reported too. The page data comes
only from the document's handover, as in a browser, and framework runtimes get the DOM globals they
use (Vue's `SVGElement`).

---
"@nifrajs/web": minor
"@nifrajs/web-vanilla": minor
---

A link or form can refresh one region of a vanilla page instead of loading the whole document. Mark the region `data-swap-slot="results"`, make `slot("results", content)` from `@nifrajs/web-vanilla` its only content, and add `data-swap="replace:results"` or `data-swap="append:results"` to the link or form:

- `enableSwap(enhancers, { root })` from the new `@nifrajs/web/islands/swap` entry takes the place of `mountIslands`. It mounts the page's islands, and a `data-swap` link or form then makes its usual request with an `x-nifra-swap: <slot>` header and puts the answer in the slot. A page that does not import it pays nothing.
- The server runs the page as usual and answers with that slot's HTML alone, `private, no-store` with `vary: x-nifra-swap`, echoing the header. A data request wins over a swap, an action's redirect is followed to the slot of the page it lands on, and ISR never serves or stores a swap.
- `replace` swaps the slot's content and, for a GET, pushes the URL; back and forward fetch the slots again. `append` adds to it, and a link or form inside the slot is removed when the next content arrives, so a "more" link gives way to the next page's own.
- Islands in a slot mount with it and unmount when it is replaced. A loading slot carries `aria-busy="true"`, a newer swap of a slot cancels the older one, and a failed request sets `data-swap-error` on the link or form.
- Any other answer, such as a redirect, another origin, a page without that slot or an error, loads the URL normally, and a form POST is never sent twice.

A render adapter answers swaps through the new optional `renderSlot(chain, props, name)`. Only `@nifrajs/web-vanilla` implements it in this release.

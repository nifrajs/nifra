---
"@nifrajs/web": patch
---

A client navigation starts loading the moment it is made, and only the page swap runs inside the view
transition. Before, the whole navigation ran inside `document.startViewTransition`, whose callback
waits for a frame: the data request left a frame late, the page stopped painting until the data
arrived (pending and `_loading` UI included), and a page that drew no frames while reporting itself
visible, such as an occluded window, changed its URL and never showed the new page. Back during such
a navigation then started the stalled navigation after it and wrote its URL into the entry Back
landed on. The swap now waits at most 100 ms for a frame before skipping the animation, and a swap a
newer navigation has superseded does nothing.

A navigation that a newer one supersedes settles quietly, as a superseded submit already did. Before,
the newer navigation aborting its data request rejected it, and the history layer loaded the
superseded page as a document: clicking a second link while the first one's data loaded ended on the
first page.

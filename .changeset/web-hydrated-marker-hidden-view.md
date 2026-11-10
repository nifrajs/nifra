---
"@nifrajs/web": patch
---

The generated client entry sets `data-nifra-hydrated` (and fires `nifra:hydrated`) on a timer when the view is hidden. It waited for an animation frame, which a hidden view never runs, so a window created hidden, minimized or covered held the marker until someone showed it, and a shell that shows its window once the page is ready never showed it.

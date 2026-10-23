---
"@nifrajs/web": patch
---

A server component's HTML may hold a responsive image: `srcset` on `<img>` and `<source>` is checked candidate by candidate, as the browser splits it, and each URL is held to the rule `src` is held to, where the attribute was refused before. The image preload hints React writes ahead of each `<img>` in a component it renders are cut from the component's HTML with its other hints, so a React server component that shows an image no longer fails its HTML check. A partially prerendered hole's HTML gets the same check.

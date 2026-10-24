---
"@nifrajs/web-vue": patch
---

Render a Vue layout again only when its own state, its props or the component directly below it change, not on every reload or sibling navigation. `KeepAlive` and `Transition` layouts still keep the pages they hold.

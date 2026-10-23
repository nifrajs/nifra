---
"@nifrajs/web": patch
"@nifrajs/web-vue": patch
---

Skip the symbol-key check when sharing freshly parsed JSON, which carries no symbol keys, so a reload that changes one row costs what it did before client-loader data was guarded. Client-loader data keeps the check.

Render a Vue layout again only when its own state, its props or the component directly below it change, not on every reload or sibling navigation. `KeepAlive` and `Transition` layouts still keep the pages they hold.

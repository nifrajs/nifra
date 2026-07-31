---
"@nifrajs/web-solid": patch
"@nifrajs/web-vue": patch
---

Solid's and Vue's `useServerFn` seed their reactive state from the store rather than from the idle
constant.

Both values are identical today - the store is created one line above and cannot have moved - so this
changes no behaviour. It removes the dependence on that staying true. Svelte's binding had the same
line reading the constant, and because its subscription is lazy the first render showed idle for a
call that had already finished. Reading the snapshot makes correctness independent of when the
subscription attaches.

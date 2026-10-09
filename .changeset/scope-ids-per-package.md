---
"@nifrajs/web": patch
---

Scoped style ids are now unique across a monorepo. Vue `data-v-*` scope ids, CSS-module class names and StyleX stylesheet ids hashed the file's path relative to its package, so `src/Card.vue` in two workspace packages got the same id, and each package's styles applied to the other's markup. The package's `name` now leads the hashed path. Every generated class name and scope id changes once.

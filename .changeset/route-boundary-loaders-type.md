---
"@nifrajs/web": minor
"create-nifra": patch
---

Generated route types gain `Route.BoundaryLoaders`, and `@nifrajs/web` exports `BoundaryLoadersOf` and `BoundaryLoaderEntry`. With `export const boundaryLoaders = { ... } satisfies Route.BoundaryLoaders`, a key that names no boundary of the page is a type error, and on a route with a `shellLoader` so is a hole without an entry. The check reads a `.tsx` or `.ts` page whose boundary names are literal types, such as a boundary declared `as const`; a hole's `load` gets its context type from the boundary's mode.

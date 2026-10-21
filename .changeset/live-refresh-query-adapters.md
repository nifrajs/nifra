---
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-vue": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-svelte": minor
---

`useQuery` (and Solid's `createQuery`) take the query cache's options as a third argument: `staleTime`, and `live` to refetch on the live keys a page's loaders grant. React's `useQuery` now hands its options to the client whole.

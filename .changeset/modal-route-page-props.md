---
"@nifrajs/web-react": patch
"@nifrajs/web-preact": patch
"@nifrajs/web-vue": patch
"@nifrajs/web-solid": patch
"@nifrajs/web-svelte": patch
---

While an intercept boundary shows a route over the page, the route props describe the page underneath: `path`, the typed `search`, and so `useLocation`, `useSearch` and `useMatches`, come from the page's own path. Before, they read the modal's URL, so the page lost its query string and `useMatches` sliced the modal's URL against the page's route chain.

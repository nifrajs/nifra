---
"@nifrajs/web-solid": patch
---

An interactive partial-prerendering hole filled after the page has finished hydrating keeps the nodes the fill brought and hydrates them in place. Solid 2's `hydrate` client-rendered over them once the page's own hydration was done, which replaced the hole's DOM.

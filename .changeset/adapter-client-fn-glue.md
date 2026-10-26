---
"@nifrajs/web": minor
"@nifrajs/web-react": patch
"@nifrajs/web-preact": patch
"@nifrajs/web-solid": patch
"@nifrajs/web-svelte": patch
"@nifrajs/web-vue": patch
---

`@nifrajs/web/fn-state` exports `clientServerFn(fn)`: a server-function reference typed as the one-argument stub a binding calls in the browser. The React, Preact, Solid, Svelte and Vue `useServerFn` bindings take their function through it.

The React, Svelte and Vue client and keep-alive mounts read a hydration verification runner's hooks through one reader in `@nifrajs/web/internal/hydration-assurance`. Recoverable errors and warnings reach the runner as before.
